import { parseChoice } from '@nextai/chatwoot-client';
import { QUEUES, formatMoney, t, type Currency, type DraftPayload, type IntentResult } from '@nextai/shared';
import { ruleClassify } from '../../ai/index.js';
import { KIND_CHOICES, cleanName, normalizeKind } from '../../ai/rules.js';
import { ErpError } from '@nextai/erpnext-client';
import { audit } from '../audit/audit.js';
import { tenantDb } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import type { BotContext } from '../chatwoot/context.js';
import { say } from '../chatwoot/context.js';
import { CHOICES, cancelDraft, confirmDraft, createDraft, getDraft, parseEdit, summaryText, updateDraftPayload } from '../drafts/service.js';
import { account, erpContext, expenseLedgers, findLedger } from '../erpnext/mappers.js';
import { chooseExpenseAccount } from '../erpnext/expense-account.js';
import { GroupNotFound, KIND_LABEL, createLedger, createParty, isPartyKind, ledgerTarget } from '../erpnext/create-account.js';
import { booksContext, reportSummary } from '../reports/reports.js';
import { incrementUsage } from '../usage/usage.js';
import { buildBriefing } from '../briefing/briefing.js';
import { answerBankLine, askNextBankLine, importLines, matchLines, tenantToday } from '../banking/service.js';
import { parseBankSms } from '../banking/parse.js';

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

  if (state.step === 'awaiting_field' && state.field === 'bankline' && state.partial?.lineId) {
    return answerBankLine(ctx, String(state.partial.lineId), text, (i) => runIntent(ctx, i));
  }

  if (state.step === 'awaiting_field' && state.pendingIntent && state.field) {
    const partial = { ...(state.partial ?? {}) } as IntentResult['entities'];
    if (state.field === 'kind') {
      const kind = normalizeKind(text);
      const group = text.trim().match(/^(?:under|in)\s+(?:the\s+)?(.+?)(?:\s+group)?$/i)?.[1];
      if (kind && !group) partial.kind = kind;
      else if (text.trim().length > 1 && !/^\d+$/.test(text.trim())) partial.group = group ?? text.trim(); // a group name
      else return say(ctx, kindQuestion(String(partial.accountName ?? partial.party ?? 'it')));
    } else if (state.field === 'amount') {
      const n = Number(text.replace(/[^\d.]/g, ''));
      if (!(n > 0)) return say(ctx, t(ctx.lang, 'bot.missingField', { field: 'amount' }));
      partial.amount = n;
    } else {
      partial.party = text.trim();
    }
    await c.conversations.set(tenant.id, conversationId, { step: 'idle' });
    return runIntent(ctx, { intent: state.pendingIntent, confidence: 1, entities: partial });
  }

  // A forwarded bank SMS: record it against the books (or ask what it was).
  const sms = parseBankSms(text, tenantToday(tenant));
  if (sms) return handleBankSms(ctx, sms);

  const intent = await classify(ctx, text);
  await runIntent(ctx, intent);
}

async function handleBankSms(ctx: BotContext, sms: NonNullable<ReturnType<typeof parseBankSms>>): Promise<void> {
  const { c, tenant } = ctx;
  const { added } = await importLines(c, tenant, [sms], 'sms');
  if (!added.length) return say(ctx, 'I already have this bank transaction. Reply "bank" to see what still needs you.');
  const m = await matchLines(c, tenant, added, { userId: ctx.user.id, conversationId: ctx.conversationId });
  if (m.recorded) {
    const line = await tenantDb(c.prisma, tenant.id).bankLine.findUnique({ where: { id: added[0]!.id } });
    return say(ctx, `✅ Already in your books${line?.matchName ? ` (${line.matchName})` : ''}. Nothing to do.`);
  }
  if (m.toAsk) return askNextBankLine(ctx, added[0]!.id);
  // a payment draft was sent to confirm
}

/** Account learned from earlier confirmed entries for this supplier (case-insensitive). */
async function learnedAccount(c: BotContext['c'], tenantId: string, party?: string): Promise<string | undefined> {
  if (!party) return undefined;
  const hit = await tenantDb(c.prisma, tenantId).vendorMapping.findFirst({ where: { tenantId, supplierName: { equals: party, mode: 'insensitive' } } });
  return hit?.expenseAccount;
}

async function applyEditAndResend(ctx: BotContext, draftId: string, patch: Partial<DraftPayload>) {
  const { c, tenant, conversationId } = ctx;
  if (patch.expenseAccount) {
    // "account software" → the real ledger "Software Subscriptions - ATL"; unknown names get a list to choose from.
    let ledgers: string[] = [];
    try {
      ledgers = await expenseLedgers(c.erp(tenant), erpContext(tenant), tenant.id);
    } catch {
      /* ERPNext unreachable: keep what was typed; posting falls back safely */
    }
    if (ledgers.length) {
      const found = findLedger(patch.expenseAccount, ledgers);
      if (!found) {
        const list = ledgers.slice(0, 25).map((l) => `• ${l.replace(/\s+-\s+[^-]+$/, '')}`).join('\n');
        await say(ctx, `I couldn't find an expense account called "${patch.expenseAccount}". Reply "account <name>" with one of:\n${list}`);
        return;
      }
      patch.expenseAccount = found;
    }
  }
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
    return result.confidence >= 0.5 ? result : (rule ?? notUnderstood(text));
  } catch (err) {
    logger.warn({ tenantId: ctx.tenant.id, err: (err as Error).message }, 'llm classify failed');
    return rule ?? notUnderstood(text);
  }
}

/** Nothing matched: show the help with the message that wasn't understood (question carries it to the reply). */
const notUnderstood = (text: string): IntentResult => ({ intent: 'help', confidence: 0, entities: { question: text.trim().slice(0, 120) } });

/** The expense/purchase ledger for a supplier bill: what this supplier was booked to before, else the best match. */
async function billAccount(ctx: BotContext, party: string | undefined, desc: string): Promise<string> {
  return (await learnedAccount(ctx.c, ctx.tenant.id, party)) ?? (await chooseExpenseAccount(ctx.c, ctx.tenant, [desc, party].filter(Boolean).join(' – ')));
}

const kindQuestion = (name: string) =>
  `What kind of account is ${name}?\n${KIND_CHOICES.map((k, i) => `${i + 1}. ${KIND_LABEL[k].replace(/ account$/, '')}`).join('\n')}\n\nOr reply with the group to put it under, e.g. "under Capital Account".`;

/** Add a customer/supplier or a ledger of any kind in ERPNext (asking for the name or the kind first when missing). */
async function addAccount(ctx: BotContext, intent: IntentResult): Promise<void> {
  const { c, tenant } = ctx;
  const e = intent.entities;
  const name = cleanName(e.accountName || e.party || '');
  const kind = normalizeKind(e.kind);
  const group = e.group?.trim() || undefined;
  if (!name) return askFor(ctx, intent, 'party', kind ? `${KIND_LABEL[kind].toLowerCase()} name` : 'name');
  if (!kind && !group) {
    await c.conversations.set(tenant.id, ctx.conversationId, { step: 'awaiting_field', pendingIntent: intent.intent, field: 'kind', partial: { ...e, party: name } });
    return say(ctx, kindQuestion(name));
  }
  const party = kind && isPartyKind(kind) && !group ? kind : undefined;
  if (!party && ctx.user.role === 'staff') {
    return say(ctx, `Only the owner or your accountant can add ledger accounts. Please ask them to send "create ${kind ? KIND_LABEL[kind].toLowerCase() : 'account'} ${name}${group ? ` under ${group}` : ''}".`);
  }
  try {
    const r = party
      ? await createParty(c, tenant, party, name)
      : await createLedger(c, tenant, { kind: kind && !isPartyKind(kind) ? kind : undefined, group, name });
    const label = kind && (party || !group) ? KIND_LABEL[kind] : 'Account';
    if (!r.created) {
      return say(ctx, `${name} is already in your books${r.group ? ` (under ${r.group})` : ''}. Nothing new was added.`);
    }
    await audit(c.prisma, { tenantId: tenant.id, actorId: ctx.user.id, actorType: 'user', channel: 'whatsapp', action: party ? 'party.create' : 'account.create', entity: party ?? 'account', entityId: r.name, after: { kind, name: r.name, group: r.group } });
    const hint =
      party === 'customer' ? `\nTry: "sold 5000 to ${name}"`
      : party === 'supplier' ? `\nTry: "paid 5000 to ${name}" or send their bill`
      : kind === 'expense' || kind === 'direct_expense' ? `\nBills can now be booked to it: when editing a bill, reply "account ${name}".`
      : '';
    return say(ctx, `✅ ${label} "${name}" added to your books${r.group ? ` under ${r.group}` : ''}.${hint}`);
  } catch (err) {
    if (err instanceof GroupNotFound) {
      const list = err.groups.slice(0, 30).map((g) => `• ${g}`).join('\n');
      return say(ctx, `I couldn't find ${err.asked ? `a group called "${err.asked}"` : 'a suitable group'} in your chart of accounts. Send "create account ${name} under <group>" with one of:\n${list}`);
    }
    logger.warn({ tenantId: tenant.id, kind, err: (err as Error).message }, 'create account failed');
    const why = err instanceof ErpError ? ` ERPNext said: ${err.userMessage}` : '';
    return say(ctx, `Sorry, I couldn't add ${name} right now.${why}`);
  } finally {
    await c.conversations.set(tenant.id, ctx.conversationId, { step: 'idle' });
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
  const currency = tenant.currency as Currency; // books are kept in the business currency
  const money = ['record_expense', 'record_sale', 'payment_in', 'payment_out', 'record_purchase', 'sales_return', 'purchase_return', 'transfer'].includes(intent.intent);
  if (money && e.amount && e.currency && e.currency !== tenant.currency) {
    // "paid 20 USD …" in an INR business: posting 20 would book ₹20. Ask what was actually charged.
    const original = `${e.currency} ${e.amount}`;
    const described = { ...e, amount: undefined, currency: undefined, description: [e.description, `(${original})`].filter(Boolean).join(' ') };
    return askFor(ctx, { ...intent, entities: described }, 'amount', `amount in ${tenant.currency} that was charged for ${original}`);
  }
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
        expenseAccount: await billAccount(ctx, e.party, desc),
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
      const direction = intent.intent === 'payment_in' ? 'in' : 'out';
      let target;
      try {
        target = await ledgerTarget(c, tenant, e.party, direction, e.description);
      } catch (err) {
        logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'chart unavailable; treating as customer/supplier');
      }
      if (target) {
        // Owner's capital, drawings, a loan, or another ledger: a journal entry against it, not a customer/supplier payment.
        const payload: DraftPayload = {
          date: e.date ?? today,
          currency,
          lines: [],
          total: e.amount,
          paymentMode: e.paymentMode ?? 'cash',
          direction,
          expenseAccount: target.account,
          newAccount: target.newAccount,
          remarks: target.label,
          validationIssues: [],
        };
        await createDraft(c, tenant, { ...base, type: 'journal_entry', payload, confidence: intent.confidence });
        return;
      }
      const payload: DraftPayload = {
        partyName: e.party,
        date: e.date ?? today,
        currency,
        lines: [],
        total: e.amount,
        paymentMode: e.paymentMode ?? 'cash', // cash unless a bank-type mode is mentioned
        validationIssues: [],
      };
      await createDraft(c, tenant, { ...base, type: intent.intent, payload, confidence: intent.confidence });
      return;
    }
    case 'record_purchase':
    case 'purchase_return': {
      // A supplier bill (Purchase Invoice) or a return to the supplier (debit note: a Purchase Invoice with is_return).
      if (!e.amount) return askFor(ctx, intent, 'amount', 'amount');
      if (!e.party) return askFor(ctx, intent, 'party', 'supplier name');
      const isReturn = intent.intent === 'purchase_return';
      const desc = e.description ?? (isReturn ? 'Goods returned' : 'Purchase');
      const payload: DraftPayload = {
        partyName: e.party,
        date: e.date ?? today,
        currency,
        lines: [{ description: desc, qty: 1, rate: e.amount, amount: e.amount }],
        total: e.amount,
        // Bought from a supplier: on credit (unpaid bill) unless they said how it was paid.
        paymentMode: isReturn ? undefined : (e.paymentMode ?? 'credit'),
        expenseAccount: await billAccount(ctx, e.party, isReturn ? `purchase ${desc}` : desc),
        remarks: isReturn ? `Goods returned to ${e.party}${e.description ? `: ${e.description}` : ''}` : desc,
        ...(isReturn ? { isReturn: true } : {}),
        validationIssues: [],
      };
      await createDraft(c, tenant, { ...base, type: 'purchase_invoice', payload, confidence: intent.confidence });
      return;
    }
    case 'sales_return': {
      // Goods returned by a customer: an ERPNext credit note (Sales Invoice with is_return).
      if (!e.amount) return askFor(ctx, intent, 'amount', 'amount');
      if (!e.party) return askFor(ctx, intent, 'party', 'customer name');
      const payload: DraftPayload = {
        partyName: e.party,
        date: e.date ?? today,
        currency,
        lines: [{ description: e.description ?? 'Goods returned', qty: 1, rate: e.amount, amount: e.amount }],
        total: e.amount,
        isReturn: true,
        remarks: `Goods returned by ${e.party}${e.description ? `: ${e.description}` : ''}`,
        validationIssues: [],
      };
      await createDraft(c, tenant, { ...base, type: 'sales_invoice', payload, confidence: intent.confidence });
      return;
    }
    case 'transfer': {
      // Cash deposited into / withdrawn from the bank: an ERPNext Contra Entry.
      if (!e.amount) return askFor(ctx, intent, 'amount', 'amount');
      const withdrawal = /withdr|bank\s*to\s*cash/i.test(e.description ?? '');
      const erp = erpContext(tenant);
      const payload: DraftPayload = {
        date: e.date ?? today,
        currency,
        lines: [],
        total: e.amount,
        direction: 'out',
        voucherType: 'Contra Entry',
        // Row 0 (debit) receives the money; the payment mode picks the account it leaves.
        expenseAccount: account(erp, withdrawal ? 'cash' : 'bank'),
        paymentMode: withdrawal ? 'bank' : 'cash',
        remarks: withdrawal ? 'Cash withdrawn from bank' : 'Cash deposited in bank',
        validationIssues: [],
      };
      await createDraft(c, tenant, { ...base, type: 'journal_entry', payload, confidence: intent.confidence });
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
    case 'add_party':
    case 'add_account':
      return addAccount(ctx, intent);
    case 'briefing':
      return say(ctx, (await buildBriefing(c, tenant)).text);
    case 'bank':
      return askNextBankLine(ctx);
    case 'help':
    default: {
      const pending = await tenantDb(c.prisma, tenant.id).draft.count({ where: { status: { in: ['pending', 'needs_review'] } } });
      const footer = pending ? `\n\n${pending} item(s) waiting for approval.` : '';
      // Not understood: say so, rather than just repeating the menu.
      const lead = intent.confidence < 0.5 && e.question ? `${t(ctx.lang, 'bot.notUnderstood', { text: e.question })}\n\n` : '';
      await say(ctx, lead + t(ctx.lang, 'bot.help') + footer);
    }
  }
}

export const formatTotal = (n: number, cur: Currency) => formatMoney(n, cur);
