import { parseChoice } from '@nextai/chatwoot-client';
import { QUEUES, formatMoney, t, type Currency, type DraftPayload, type IntentResult } from '@nextai/shared';
import { ruleClassify } from '../../ai/index.js';
import { tenantDb } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import type { BotContext } from '../chatwoot/context.js';
import { say } from '../chatwoot/context.js';
import { CHOICES, cancelDraft, confirmDraft, createDraft, getDraft, parseEdit, summaryText, updateDraftPayload } from '../drafts/service.js';
import { erpContext, guessExpenseAccount } from '../erpnext/mappers.js';
import { booksContext, reportSummary } from '../reports/reports.js';
import { incrementUsage } from '../usage/usage.js';

/**
 * Deterministic flow engine. State machine per conversation (Redis, 24h):
 *   idle → (intent) → awaiting_field? → awaiting_confirm → (1 confirm | 2 edit → awaiting_edit | 3 cancel) → idle
 * The LLM is only used for free-text intent + entity extraction when rules are not confident.
 */
export async function handleText(ctx: BotContext, text: string): Promise<void> {
  const { c, tenant, conversationId } = ctx;
  const state = await c.conversations.get(tenant.id, conversationId);
  const actor = { id: ctx.user.id, type: 'user' as const, channel: 'whatsapp' as const };
  const lower = text.trim().toLowerCase();

  if (['menu', 'help', 'reset', 'cancel all'].includes(lower)) {
    await c.conversations.clear(tenant.id, conversationId);
    await say(ctx, t(ctx.lang, 'bot.help'));
    return;
  }

  if (state.step === 'awaiting_confirm' && state.draftId) {
    const choice = parseChoice(text, CHOICES);
    if (!choice) {
      // allow inline edits without pressing 2 first, e.g. "amount 1200"
      const patch = parseEdit(text);
      if (patch) return applyEditAndResend(ctx, state.draftId, patch);
      await say(ctx, t(ctx.lang, 'bot.invalidChoice'));
      return;
    }
    if (choice === 'confirm') {
      await confirmDraft(c, tenant, state.draftId, actor);
      await c.conversations.set(tenant.id, conversationId, { step: 'idle' });
      return; // "Posted ✅" is sent by draft.post when ERPNext accepts it
    }
    if (choice === 'edit') {
      await c.conversations.set(tenant.id, conversationId, { step: 'awaiting_edit', draftId: state.draftId });
      await say(ctx, t(ctx.lang, 'bot.editPrompt'));
      return;
    }
    await cancelDraft(c, tenant, state.draftId, actor);
    await c.conversations.clear(tenant.id, conversationId);
    await say(ctx, t(ctx.lang, 'bot.cancelled'));
    return;
  }

  if (state.step === 'awaiting_edit' && state.draftId) {
    const patch = parseEdit(text);
    if (!patch) {
      await say(ctx, t(ctx.lang, 'bot.editPrompt'));
      return;
    }
    return applyEditAndResend(ctx, state.draftId, patch);
  }

  if (state.step === 'awaiting_field' && state.pendingIntent && state.field) {
    const partial = { ...(state.partial ?? {}) } as IntentResult['entities'];
    if (state.field === 'amount') {
      const n = Number(text.replace(/[^\d.]/g, ''));
      if (!(n > 0)) return say(ctx, t(ctx.lang, 'bot.missingField', { field: 'amount' }));
      partial.amount = n;
    } else {
      partial.party = text.trim();
    }
    await c.conversations.set(tenant.id, conversationId, { step: 'idle' });
    return runIntent(ctx, { intent: state.pendingIntent, confidence: 1, entities: partial });
  }

  const intent = await classify(ctx, text);
  await runIntent(ctx, intent);
}

async function applyEditAndResend(ctx: BotContext, draftId: string, patch: Partial<DraftPayload>) {
  const { c, tenant, conversationId } = ctx;
  const current = await getDraft(c, tenant.id, draftId);
  const p = current.payload as DraftPayload;
  if (patch.total !== undefined && p.lines.length <= 1) {
    patch.lines = [{ description: p.lines[0]?.description ?? p.remarks ?? 'Item', qty: 1, rate: patch.total, amount: patch.total }];
  }
  const updated = await updateDraftPayload(c, tenant, draftId, patch, { id: ctx.user.id, type: 'user', channel: 'whatsapp' });
  await c.chatwoot(tenant).sendChoices(conversationId, summaryText(updated, ctx.lang), CHOICES);
  await c.conversations.set(tenant.id, conversationId, { step: 'awaiting_confirm', draftId });
}

async function classify(ctx: BotContext, text: string): Promise<IntentResult> {
  const rule = ruleClassify(text);
  if (rule && rule.confidence >= 0.8) return rule;
  try {
    const { result, usage } = await ctx.c.ai.llm.classify(text, {
      country: ctx.tenant.country,
      currency: ctx.tenant.currency as Currency,
      today: new Date().toISOString().slice(0, 10),
    });
    await incrementUsage(ctx.c.prisma, ctx.tenant.id, { aiTokens: usage.tokens, aiCostMicros: usage.costMicros });
    return result.confidence >= 0.5 ? result : (rule ?? { intent: 'help', confidence: 0, entities: {} });
  } catch (err) {
    logger.warn({ tenantId: ctx.tenant.id, err: (err as Error).message }, 'llm classify failed');
    return rule ?? { intent: 'help', confidence: 0, entities: {} };
  }
}

async function askFor(ctx: BotContext, intent: IntentResult, field: 'amount' | 'party', label: string) {
  await ctx.c.conversations.set(ctx.tenant.id, ctx.conversationId, {
    step: 'awaiting_field',
    pendingIntent: intent.intent,
    field,
    partial: intent.entities as Record<string, unknown>,
  });
  await say(ctx, t(ctx.lang, 'bot.missingField', { field: label }));
}

export async function runIntent(ctx: BotContext, intent: IntentResult): Promise<void> {
  const { c, tenant } = ctx;
  const e = intent.entities;
  const today = new Date().toISOString().slice(0, 10);
  const currency = (e.currency ?? tenant.currency) as Currency;
  const erpCtx = erpContext(tenant);
  const base = { userId: ctx.user.id, conversationId: ctx.conversationId, actor: { id: ctx.user.id, type: 'user' as const, channel: 'whatsapp' as const } };

  switch (intent.intent) {
    case 'record_expense': {
      if (!e.amount) return askFor(ctx, intent, 'amount', 'amount');
      const desc = e.description ?? 'Expense';
      const payload: DraftPayload = {
        partyName: e.party,
        date: e.date ?? today,
        currency,
        lines: [{ description: desc, qty: 1, rate: e.amount, amount: e.amount }],
        total: e.amount,
        paymentMode: e.paymentMode ?? 'cash',
        expenseAccount: guessExpenseAccount(erpCtx, desc),
        remarks: desc,
        validationIssues: [],
      };
      await createDraft(c, tenant, { ...base, type: e.party ? 'purchase_invoice' : 'journal_entry', payload, confidence: intent.confidence });
      return;
    }
    case 'record_sale': {
      if (!e.amount) return askFor(ctx, intent, 'amount', 'amount');
      if (!e.party) return askFor(ctx, intent, 'party', 'customer name');
      const due = new Date(Date.now() + 15 * 86400_000).toISOString().slice(0, 10);
      const payload: DraftPayload = {
        partyName: e.party,
        date: e.date ?? today,
        dueDate: due,
        currency,
        lines: [{ description: e.description ?? 'Sales', qty: 1, rate: e.amount, amount: e.amount }],
        total: e.amount,
        validationIssues: [],
      };
      await createDraft(c, tenant, { ...base, type: 'sales_invoice', payload, confidence: intent.confidence });
      return;
    }
    case 'payment_in':
    case 'payment_out': {
      if (!e.amount) return askFor(ctx, intent, 'amount', 'amount');
      if (!e.party) return askFor(ctx, intent, 'party', intent.intent === 'payment_in' ? 'customer name' : 'supplier name');
      const payload: DraftPayload = {
        partyName: e.party,
        date: e.date ?? today,
        currency,
        lines: [],
        total: e.amount,
        paymentMode: e.paymentMode ?? 'bank',
        validationIssues: [],
      };
      await createDraft(c, tenant, { ...base, type: intent.intent, payload, confidence: intent.confidence });
      return;
    }
    case 'request_report': {
      const text = await reportSummary(c, tenant, (e.report as never) ?? 'profit_and_loss');
      await say(ctx, text);
      return;
    }
    case 'ask_books': {
      const context = await booksContext(c, tenant);
      const { text, usage } = await c.ai.llm.answer(e.question ?? '', context, ctx.lang);
      await incrementUsage(c.prisma, tenant.id, { aiTokens: usage.tokens, aiCostMicros: usage.costMicros });
      await say(ctx, text);
      return;
    }
    case 'send_reminder': {
      if (!e.party) return askFor(ctx, intent, 'party', 'customer name');
      await c.queue.enqueue(QUEUES.outboundReminder, { tenantId: tenant.id, party: e.party, requestedBy: ctx.user.id, conversationId: ctx.conversationId });
      await say(ctx, `⏰ Sending a payment reminder to ${e.party}.`);
      return;
    }
    case 'add_party': {
      if (!e.party) return askFor(ctx, intent, 'party', 'name');
      await say(ctx, `👍 ${e.party} will be added to your books with their first bill or invoice.`);
      return;
    }
    case 'help':
    default: {
      const pending = await tenantDb(c.prisma, tenant.id).draft.count({ where: { status: { in: ['pending', 'needs_review'] } } });
      const footer = pending ? `\n\n${pending} item(s) waiting for approval.` : '';
      await say(ctx, t(ctx.lang, 'bot.help') + footer);
    }
  }
}

export const formatTotal = (n: number, cur: Currency) => formatMoney(n, cur);
