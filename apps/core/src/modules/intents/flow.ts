import { parseChoice } from '@nextai/chatwoot-client';
import { QUEUES, formatMoney, t, type Currency, type DraftPayload, type IntentResult, type ReportKey } from '@nextai/shared';
import { ruleClassify } from '../../ai/index.js';
import { DATE_RE, KIND_CHOICES, cleanName, normalizeKind, parseDate } from '../../ai/rules.js';
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
import { createEmployee, normalizeGender } from '../erpnext/create-employee.js';
import { NEW_PARTY, partyChoices, partyQuestion, resolveParty, type PartyKind, type PartyResolution } from '../parties/resolve.js';
import { booksContext } from '../reports/reports.js';
import { answerQuestion, reportText } from '../reports/answers.js';
import { parseQuestion } from '../../ai/question.js';
import { hasFeature } from '../billing/gating.js';
import { forecastSummary } from '../forecast/service.js';
import { incrementUsage } from '../usage/usage.js';
import { buildBriefing } from '../briefing/briefing.js';
import { answerBankLine, askNextBankLine, importLines, linkDraftToBankLine, matchLines, tenantToday } from '../banking/service.js';
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

  if (state.step === 'awaiting_party' && state.choices && state.field) {
    // Answer to "which customer did you mean?": a number, the start of a listed name, "add new", or another name.
    if (['cancel', 'stop', 'no'].includes(lower)) {
      await c.conversations.clear(tenant.id, conversationId);
      return say(ctx, t(ctx.lang, 'bot.cancelled'));
    }
    const kind = state.field as PartyKind;
    const query = String(state.partial?.party ?? '');
    const pick = /^(new|add|add new|add it|create|create new|create it|yes add)$/.test(lower) ? NEW_PARTY : parseChoice(text, state.choices);
    let party: string;
    if (pick === NEW_PARTY) party = query;
    else if (pick) party = pick;
    else {
      const res = await resolveParty(c, tenant, kind, text);
      if (res.status === 'matched') party = res.name;
      else if (res.status === 'unavailable') party = res.query;
      else return askParty(ctx, res, kind, { pendingIntent: state.pendingIntent, draftId: state.draftId, bankLineId: state.bankLineId, partial: { ...(state.partial ?? {}), party: res.query } });
    }
    if (state.draftId) return applyEditAndResend(ctx, state.draftId, { partyName: party }, true);
    await c.conversations.set(tenant.id, conversationId, { step: 'idle' });
    if (!state.pendingIntent) return;
    const next = () => runIntent(ctx, { intent: state.pendingIntent!, confidence: 1, entities: { ...(state.partial ?? {}), party } as IntentResult['entities'] }, { partyChecked: true });
    return state.bankLineId ? linkDraftToBankLine(ctx, state.bankLineId, next) : next();
  }

  if (state.step === 'awaiting_field' && state.field === 'bankline' && state.partial?.lineId) {
    const lineId = String(state.partial.lineId);
    return answerBankLine(ctx, lineId, text, (i) => runIntent(ctx, i, { bankLineId: lineId }));
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
    } else if (state.field === 'gender') {
      const g = normalizeGender(text);
      if (!g) return say(ctx, 'Please reply 1 for Female, 2 for Male or 3 for Other.');
      partial.gender = g;
    } else if (state.field === 'birthDate' || state.field === 'joiningDate') {
      const d = parseDate(text);
      if (!d) return say(ctx, 'Please send the date like 15/03/1995 or "18 Nov 2026".');
      if (state.field === 'birthDate' && d >= new Date().toISOString().slice(0, 10)) return say(ctx, 'That date of birth is not in the past. Please send it again, e.g. 15/03/1995.');
      partial[state.field] = d;
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

/** Which party list a draft's customer/supplier must come from. */
const PARTY_OF_DRAFT: Partial<Record<string, PartyKind>> = { sales_invoice: 'Customer', payment_in: 'Customer', purchase_invoice: 'Supplier', payment_out: 'Supplier' };

async function applyEditAndResend(ctx: BotContext, draftId: string, patch: Partial<DraftPayload>, partyChecked = false) {
  const { c, tenant, conversationId } = ctx;
  if (patch.partyName && !partyChecked) {
    // "customer Orbit": pick the real customer/supplier from ERPNext, or ask which one was meant.
    const kind = PARTY_OF_DRAFT[(await getDraft(c, tenant.id, draftId)).type];
    if (kind) {
      const res = await resolveParty(c, tenant, kind, patch.partyName);
      if (res.status === 'matched') patch.partyName = res.name;
      else if (res.status === 'unavailable') patch.partyName = res.query;
      else return askParty(ctx, res, kind, { draftId, partial: { party: res.query } });
    }
  }
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
  const rule = ruleClassify(text, { today: tenantToday(ctx.tenant), country: ctx.tenant.country });
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

/** Ask which customer/supplier was meant, offering the closest ERPNext matches and "add as new". */
async function askParty(
  ctx: BotContext,
  res: Exclude<PartyResolution, { status: 'matched' } | { status: 'unavailable' }>,
  kind: PartyKind,
  state: { pendingIntent?: IntentResult['intent']; draftId?: string; bankLineId?: string; partial: Record<string, unknown> },
): Promise<void> {
  const choices = partyChoices(res, kind);
  await ctx.c.conversations.set(ctx.tenant.id, ctx.conversationId, { step: 'awaiting_party', field: kind, choices, ...state });
  const hint = `\n\nReply with a number, or type the correct ${kind.toLowerCase()} name.`;
  await ctx.c.chatwoot(ctx.tenant).sendChoices(ctx.conversationId, partyQuestion(res, kind) + hint, choices);
}

/**
 * The customer/supplier must be one from the tenant's ERPNext list. Returns the ERPNext name to use, or undefined
 * when the name was unclear and the user has been asked to choose (the flow continues with their answer).
 */
async function checkParty(ctx: BotContext, intent: IntentResult, kind: PartyKind, opts: RunOptions): Promise<string | undefined> {
  const typed = intent.entities.party!;
  if (opts.partyChecked) return typed;
  const res = await resolveParty(ctx.c, ctx.tenant, kind, typed);
  if (res.status === 'matched') return res.name;
  if (res.status === 'unavailable') return res.query; // ERPNext down: keep the name; posting checks it again
  await askParty(ctx, res, kind, { pendingIntent: intent.intent, bankLineId: opts.bankLineId, partial: { ...intent.entities, party: res.query } });
  return undefined;
}

async function askField(ctx: BotContext, intent: IntentResult, field: string, question: string) {
  await ctx.c.conversations.set(ctx.tenant.id, ctx.conversationId, { step: 'awaiting_field', pendingIntent: intent.intent, field, partial: intent.entities as Record<string, unknown> });
  await say(ctx, question);
}

/** "Create employee Sona C": ERPNext needs gender, date of birth and date of joining, asked one at a time when missing. */
async function addEmployee(ctx: BotContext, intent: IntentResult): Promise<void> {
  const { c, tenant } = ctx;
  const e = intent.entities;
  const name = cleanName(e.party ?? '');
  if (!name) return askFor(ctx, intent, 'party', 'employee name');
  if (ctx.user.role === 'staff') return say(ctx, `Only the owner or your accountant can add employees. Please ask them to send "create employee ${name}".`);
  const named = { ...intent, entities: { ...e, party: name } };
  const gender = normalizeGender(e.gender);
  if (!gender) return askField(ctx, named, 'gender', `Adding employee ${name}.\nGender?\n1. Female\n2. Male\n3. Other`);
  if (!e.birthDate) return askField(ctx, named, 'birthDate', `What is ${name}'s date of birth? (e.g. 15/03/1995)`);
  if (!e.joiningDate) return askField(ctx, named, 'joiningDate', `When did ${name} join? Reply "today" or a date like 01/11/2026.`);
  try {
    const r = await createEmployee(c, tenant, { name, gender, birthDate: e.birthDate, joiningDate: e.joiningDate });
    if (!r.created) return say(ctx, `${name} is already in your employee list (${r.name}). Nothing new was added.`);
    await audit(c.prisma, { tenantId: tenant.id, actorId: ctx.user.id, actorType: 'user', channel: 'whatsapp', action: 'employee.create', entity: 'employee', entityId: r.name, after: { name, gender, birthDate: e.birthDate, joiningDate: e.joiningDate } });
    return say(ctx, `✅ Employee "${name}" added to ERPNext (${r.name}).\nGender: ${gender} · Born: ${e.birthDate} · Joined: ${e.joiningDate}`);
  } catch (err) {
    logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'create employee failed');
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

export interface RunOptions {
  /** The party was already picked from the ERPNext list (or chosen as new) by the user. */
  partyChecked?: boolean;
  /** Drafting an answer to this bank line (kept if a question has to be asked first). */
  bankLineId?: string;
}

/** "Orbit Travels on nov 18" → party "Orbit Travels", date 2026-11-18 (when the classifier left the date on the name). */
function splitDateFromParty(intent: IntentResult): IntentResult {
  const e = intent.entities;
  if (!e.party) return intent;
  const m = e.party.match(DATE_RE);
  const date = m ? parseDate(m[1]!) : undefined;
  if (!m || !date) return intent;
  const party = e.party.replace(m[0], ' ').replace(/\s+/g, ' ').replace(/[\s,;:-]+$/, '').trim();
  return party ? { ...intent, entities: { ...e, party, date: e.date ?? date } } : intent;
}

export async function runIntent(ctx: BotContext, rawIntent: IntentResult, opts: RunOptions = {}): Promise<void> {
  const { c, tenant } = ctx;
  const intent = splitDateFromParty(rawIntent);
  const e = { ...intent.entities };
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
      if (e.party) {
        const party = await checkParty(ctx, intent, 'Supplier', opts);
        if (!party) return;
        e.party = party;
      }
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
      const customer = await checkParty(ctx, intent, 'Customer', opts);
      if (!customer) return;
      e.party = customer;
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
      const party = await checkParty(ctx, intent, direction === 'in' ? 'Customer' : 'Supplier', opts);
      if (!party) return;
      e.party = party;
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
      const supplier = await checkParty(ctx, intent, 'Supplier', opts);
      if (!supplier) return;
      e.party = supplier;
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
      const customer = await checkParty(ctx, intent, 'Customer', opts);
      if (!customer) return;
      e.party = customer;
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
      if ((e.report as string | undefined) === 'cash_forecast') {
        await say(ctx, (await hasFeature(c, tenant, 'cash_forecast')) ? await forecastSummary(c, tenant) : 'Cash forecasting is part of the Growth and Pro plans. Upgrade in the NextAi app → Billing.');
        return;
      }
      await say(ctx, await reportText(c, tenant, (e.report as ReportKey | undefined) ?? 'profit_and_loss', e.question ?? ''));
      return;
    }
    case 'ask_books': {
      // Exact answers straight from ERPNext for everything we can recognise; the AI only for the rest.
      const question = e.question ?? '';
      const q = parseQuestion(question, tenantToday(tenant), tenant.country);
      if (q) return say(ctx, await answerQuestion(c, tenant, q));
      if (c.ai.llm.name === 'mock') return say(ctx, ASK_EXAMPLES);
      const context = await booksContext(c, tenant);
      const { text, usage } = await c.ai.llm.answer(question, context, ctx.lang);
      await incrementUsage(c.prisma, tenant.id, { aiTokens: usage.tokens, aiCostMicros: usage.costMicros });
      await say(ctx, text);
      return;
    }
    case 'send_reminder': {
      if (!e.party) return askFor(ctx, intent, 'party', 'customer name');
      const customer = await checkParty(ctx, intent, 'Customer', opts);
      if (!customer) return;
      e.party = customer;
      await c.queue.enqueue(QUEUES.outboundReminder, { tenantId: tenant.id, party: e.party, requestedBy: ctx.user.id, conversationId: ctx.conversationId });
      await say(ctx, `⏰ Sending a payment reminder to ${e.party}.`);
      return;
    }
    case 'add_party':
    case 'add_account':
      return addAccount(ctx, intent);
    case 'add_employee':
      return addEmployee(ctx, intent);
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

const ASK_EXAMPLES = [
  'I can answer questions about your books, for example:',
  '• "Sales today" / "sales last month"',
  '• "Expenses this month" / "what did I spend on fuel"',
  '• "Profit this year"',
  '• "Who owes me?" / "Ravi balance"',
  '• "How much do I owe suppliers?"',
  '• "Cash and bank balance"',
  '• "Payments received this week"',
  '• "Top customers this month"',
  '• "Unpaid invoices" / "GST due"',
].join('\n');

export const formatTotal = (n: number, cur: Currency) => formatMoney(n, cur);
