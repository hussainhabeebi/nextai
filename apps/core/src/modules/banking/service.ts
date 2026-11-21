/**
 * Bank matching: statement lines and forwarded bank SMS → the books.
 *   1. already recorded (a Payment Entry with the same amount around that date) → matched, nothing to do;
 *   2. exactly one open invoice/bill for that amount whose party is named in the narration → a payment draft
 *      against it, ready to approve (WhatsApp confirm for an SMS, the Approvals list for a statement);
 *   3. a Razorpay settlement → a draft moving it from "Razorpay Clearing" to the bank;
 *   4. anything else → asked on WhatsApp one at a time ("bank"): "₹3,200 paid on 15 Nov to KSEB: what was it?".
 */
import { formatMoney, type Currency, type DraftPayload, type IntentResult } from '@nextai/shared';
import { Prisma, type BankLine, type Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { sha256 } from '../../lib/crypto.js';
import { tenantDb } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import type { BotContext } from '../chatwoot/context.js';
import { say } from '../chatwoot/context.js';
import { createDraft } from '../drafts/service.js';
import { erpContext } from '../erpnext/mappers.js';
import { localDate } from '../outbound/time.js';
import { incrementUsage } from '../usage/usage.js';
import { parseCsvStatement, type ParsedLine } from './parse.js';

type Open = { name: string; party: string; outstanding: number };
type Recorded = { name: string; party: string; amount: number; type: string; ref?: string; date: string };

const STOP = new Set(['pvt', 'ltd', 'llc', 'llp', 'the', 'and', 'company', 'traders', 'trading', 'enterprises', 'enterprise', 'store', 'stores', 'shop', 'services', 'india', 'fze', 'fzco', 'est', 'co']);
const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
/** The party is named in the narration ("NEFT CR-…-RAVI TRADERS-…" names "Ravi Traders"). */
export const namedIn = (party: string, narration: string) => {
  const words = new Set(tokens(narration));
  const flat = narration.toLowerCase().replace(/[^a-z0-9]/g, '');
  return tokens(party).some((w) => words.has(w) || (w.length >= 5 && flat.includes(w)));
};
const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400_000;
const shift = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export const fingerprint = (l: ParsedLine) =>
  sha256([l.date, l.direction, l.amount.toFixed(2), (l.reference?.replace(/^0+/, '') || l.description).toLowerCase().replace(/\s+/g, ' ')].join('|'));

/** Store new lines; lines already imported (overlapping statements, SMS seen twice) are skipped. */
export async function importLines(c: Container, tenant: Tenant, lines: ParsedLine[], source: 'statement' | 'sms'): Promise<{ added: BankLine[]; duplicates: number }> {
  const db = tenantDb(c.prisma, tenant.id);
  const added: BankLine[] = [];
  let duplicates = 0;
  for (const l of lines) {
    try {
      added.push(
        await db.bankLine.create({
          data: { tenantId: tenant.id, date: l.date, amount: l.amount, direction: l.direction, description: l.description, reference: l.reference, balance: l.balance, source, fingerprint: fingerprint(l) },
        }),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') duplicates++;
      else throw err;
    }
  }
  return { added, duplicates };
}

async function openItems(c: Container, tenant: Tenant, lines: BankLine[]) {
  const erp = c.erp(tenant);
  const dates = lines.map((l) => l.date).sort();
  const [si, pi, pe] = await Promise.all([
    erp.list<{ name: string; customer: string; outstanding_amount: number }>('Sales Invoice', { filters: [['docstatus', '=', 1], ['outstanding_amount', '>', 0]], fields: ['name', 'customer', 'outstanding_amount'], limit: 1000 }),
    erp.list<{ name: string; supplier: string; outstanding_amount: number }>('Purchase Invoice', { filters: [['docstatus', '=', 1], ['outstanding_amount', '>', 0]], fields: ['name', 'supplier', 'outstanding_amount'], limit: 1000 }),
    erp.list<{ name: string; party?: string; paid_amount: number; payment_type: string; reference_no?: string; posting_date: string }>('Payment Entry', {
      filters: [['docstatus', '=', 1], ['posting_date', 'between', [shift(dates[0]!, -5), shift(dates.at(-1)!, 5)]]],
      fields: ['name', 'party', 'paid_amount', 'payment_type', 'reference_no', 'posting_date'],
      limit: 2000,
    }),
  ]);
  return {
    sales: si.map((x): Open => ({ name: x.name, party: x.customer, outstanding: Number(x.outstanding_amount) })),
    purchases: pi.map((x): Open => ({ name: x.name, party: x.supplier, outstanding: Number(x.outstanding_amount) })),
    recorded: pe.map((x): Recorded => ({ name: x.name, party: x.party ?? '', amount: Number(x.paid_amount), type: x.payment_type, ref: x.reference_no, date: x.posting_date })),
  };
}

export interface MatchSummary {
  recorded: number;
  drafts: number;
  toAsk: number;
}

/**
 * Match lines against the books. With `conversationId` (a forwarded SMS) the payment draft is sent there to
 * confirm; for statements drafts wait in Approvals so dozens of lines don't become dozens of messages.
 */
export async function matchLines(c: Container, tenant: Tenant, lines: BankLine[], opts: { userId?: string; conversationId?: number } = {}): Promise<MatchSummary> {
  const summary: MatchSummary = { recorded: 0, drafts: 0, toAsk: 0 };
  if (!lines.length) return summary;
  const db = tenantDb(c.prisma, tenant.id);
  const settings = erpContext(tenant).settings;
  const books = await openItems(c, tenant, lines);
  const usedInvoices = new Set<string>();
  const usedPayments = new Set<string>();
  const actor = { id: opts.userId ?? 'system', type: opts.userId ? ('user' as const) : ('system' as const), channel: 'whatsapp' as const };

  for (const line of lines) {
    const amount = Number(line.amount);
    const inward = line.direction === 'in';
    // 1. Already in the books (recorded on WhatsApp, in the app, by a payment link or directly in ERPNext).
    const near = books.recorded.filter((p) => !usedPayments.has(p.name) && p.type === (inward ? 'Receive' : 'Pay') && Math.abs(p.amount - amount) < 0.01 && days(p.date, line.date) <= 5);
    const already =
      near.find((p) => p.ref && line.reference && p.ref.replace(/^0+/, '') === line.reference.replace(/^0+/, '')) ??
      near.find((p) => p.party && namedIn(p.party, line.description)) ??
      (near.length === 1 ? near[0] : undefined);
    if (already) {
      usedPayments.add(already.name);
      await db.bankLine.update({ where: { id: line.id }, data: { status: 'matched', matchType: 'Payment Entry', matchName: already.name } });
      summary.recorded++;
      continue;
    }
    // 2. An open invoice/bill for exactly this amount.
    const pool = (inward ? books.sales : books.purchases).filter((i) => !usedInvoices.has(i.name) && Math.abs(i.outstanding - amount) < 0.01);
    const named = pool.filter((i) => namedIn(i.party, line.description));
    const doctype = inward ? 'Sales Invoice' : 'Purchase Invoice';
    if (named.length === 1) {
      const inv = named[0]!;
      usedInvoices.add(inv.name);
      const payload: DraftPayload = { partyName: inv.party, invoiceRef: inv.name, date: line.date, currency: tenant.currency as Currency, lines: [], total: amount, paymentMode: 'bank', referenceNo: line.reference ?? undefined, remarks: `Bank: ${line.description}`.slice(0, 140), validationIssues: [] };
      const draft = await createDraft(c, tenant, { userId: opts.userId, type: inward ? 'payment_in' : 'payment_out', payload, conversationId: opts.conversationId, confidence: 0.95, actor });
      await db.bankLine.update({ where: { id: line.id }, data: { status: 'suggested', matchType: doctype, matchName: inv.name, draftId: draft.id } });
      summary.drafts++;
      continue;
    }
    // 3. Razorpay paying out what customers paid online (net of its fee).
    if (inward && /razorpay/i.test(line.description) && settings.paymentLinks.account) {
      const payload: DraftPayload = { date: line.date, currency: tenant.currency as Currency, lines: [], total: amount, paymentMode: 'bank', direction: 'in', expenseAccount: settings.paymentLinks.account, referenceNo: line.reference ?? undefined, remarks: 'Razorpay settlement to bank', validationIssues: [] };
      const draft = await createDraft(c, tenant, { userId: opts.userId, type: 'journal_entry', payload, conversationId: opts.conversationId, confidence: 0.95, actor });
      await db.bankLine.update({ where: { id: line.id }, data: { status: 'suggested', matchType: 'Journal Entry', matchName: 'Razorpay settlement', draftId: draft.id } });
      summary.drafts++;
      continue;
    }
    // 4. Ask. A single same-amount invoice without the name is offered as a guess.
    const guess = pool.length === 1 ? pool[0] : undefined;
    if (guess) await db.bankLine.update({ where: { id: line.id }, data: { status: 'suggested', matchType: doctype, matchName: guess.name } });
    summary.toAsk++;
  }
  return summary;
}

/** A statement file (CSV; PDF/photo read by AI) → lines → matched. Returns the WhatsApp/app summary. */
export async function importStatement(c: Container, tenant: Tenant, file: { content: Uint8Array; mime: string; name?: string }, opts: { userId?: string } = {}) {
  let parsed: ParsedLine[];
  const isCsv = /csv|text\/plain|comma-separated/i.test(file.mime) || /\.csv$/i.test(file.name ?? '');
  if (isCsv) {
    parsed = parseCsvStatement(new TextDecoder().decode(file.content));
  } else if (c.ai.vision.extractStatement && /pdf|image\//.test(file.mime)) {
    const { lines, usage } = await c.ai.vision.extractStatement({ content: file.content, mime: file.mime, currency: tenant.currency as Currency });
    await incrementUsage(c.prisma, tenant.id, { aiTokens: usage.tokens, aiCostMicros: usage.costMicros });
    parsed = lines.flatMap((l): ParsedLine[] => {
      const out = l.debit && l.debit > 0 ? { amount: l.debit, direction: 'out' as const } : l.credit && l.credit > 0 ? { amount: l.credit, direction: 'in' as const } : undefined;
      return out && /^\d{4}-\d{2}-\d{2}$/.test(l.date) ? [{ date: l.date, ...out, description: l.description || 'Bank transaction', reference: l.reference ?? undefined, balance: l.balance ?? undefined }] : [];
    });
  } else {
    parsed = [];
  }
  if (!parsed.length) return { lines: 0, duplicates: 0, recorded: 0, drafts: 0, toAsk: 0, text: "I couldn't find transactions in that file. Send your bank statement as CSV (best) or PDF." };
  const { added, duplicates } = await importLines(c, tenant, parsed, 'statement');
  const m = await matchLines(c, tenant, added, opts);
  const parts = [
    `🏦 Read ${parsed.length} transaction${parsed.length === 1 ? '' : 's'}${duplicates ? ` (${duplicates} already imported)` : ''}.`,
    m.recorded ? `✅ ${m.recorded} already in your books.` : undefined,
    m.drafts ? `🧾 ${m.drafts} matched to invoices/bills: waiting in Approvals.` : undefined,
    m.toAsk ? `❓ ${m.toAsk} need you: reply "bank" and I'll ask about each one.` : added.length ? 'All sorted 🎉' : undefined,
  ].filter(Boolean);
  return { lines: parsed.length, duplicates, ...m, text: parts.join('\n') };
}

// ---------------------------------------------------------------- WhatsApp questions ("bank")

const question = async (c: Container, tenant: Tenant, line: BankLine, remaining: number) => {
  const amount = formatMoney(Number(line.amount), tenant.currency as Currency);
  const head = `🏦 ${amount} ${line.direction === 'in' ? 'received' : 'paid'} on ${fmtDay(line.date)}\n“${line.description}”`;
  let guess = '';
  if (line.status === 'suggested' && line.matchName && !line.draftId) {
    const party = await c
      .erp(tenant)
      .get<{ customer?: string; supplier?: string }>(line.matchType ?? 'Sales Invoice', line.matchName)
      .catch(() => undefined);
    guess = `\nIs it ${line.matchType === 'Purchase Invoice' ? 'bill' : 'invoice'} ${line.matchName}${party ? ` (${party.customer ?? party.supplier})` : ''}? Reply 1 for yes.`;
  }
  const how =
    line.direction === 'in'
      ? 'Or reply who paid (e.g. "Ravi Traders"), "capital Hussain", "loan SBI", or "skip".'
      : 'Or reply what it was (e.g. "electricity", "supplier AM Motors", "drawings Hussain"), or "skip".';
  return `${head}${guess}\n${how}${remaining > 1 ? `\n(${remaining - 1} more after this)` : ''}`;
};

/** Lines that still need an answer (a cancelled draft puts its line back in the queue). */
async function pendingLines(c: Container, tenant: Tenant) {
  const db = tenantDb(c.prisma, tenant.id);
  const lines = await db.bankLine.findMany({ where: { status: { in: ['unmatched', 'suggested'] } }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }], take: 200 });
  const withDraft = lines.filter((l) => l.draftId);
  const drafts = withDraft.length ? await db.draft.findMany({ where: { id: { in: withDraft.map((l) => l.draftId!) } }, select: { id: true, status: true } }) : [];
  const cancelled = new Set(drafts.filter((d) => d.status === 'cancelled').map((d) => d.id));
  for (const l of withDraft.filter((x) => cancelled.has(x.draftId!))) {
    // Keep an invoice/bill match as a guess to offer ("Is it invoice SINV-2?"); drop anything else.
    const guess = l.matchType === 'Sales Invoice' || l.matchType === 'Purchase Invoice';
    const data = guess ? { status: 'suggested', draftId: null } : { status: 'unmatched', draftId: null, matchType: null, matchName: null };
    await db.bankLine.update({ where: { id: l.id }, data });
    Object.assign(l, data);
  }
  return lines.filter((l) => !l.draftId);
}

/** "bank": ask about the next line that needs an answer (or a given one, e.g. the SMS just forwarded). */
export async function askNextBankLine(ctx: BotContext, preferId?: string): Promise<void> {
  const all = await pendingLines(ctx.c, ctx.tenant);
  const lines = preferId ? [...all.filter((l) => l.id === preferId), ...all.filter((l) => l.id !== preferId)] : all;
  if (!lines.length) {
    await ctx.c.conversations.set(ctx.tenant.id, ctx.conversationId, { step: 'idle' });
    return say(ctx, '✅ All bank lines are sorted. Send a statement (CSV/PDF) or forward a bank SMS any time.');
  }
  const line = lines[0]!;
  await ctx.c.conversations.set(ctx.tenant.id, ctx.conversationId, { step: 'awaiting_field', pendingIntent: 'briefing', field: 'bankline', partial: { lineId: line.id } });
  await say(ctx, await question(ctx.c, ctx.tenant, line, lines.length));
}

/**
 * The answer to a bank question → an entry to confirm, using the normal message flow (capital and loan words go
 * to those ledgers, an expense gets its expense account), with the bank as the payment mode and the line's date.
 */
export async function answerBankLine(ctx: BotContext, lineId: string, text: string, run: (intent: IntentResult) => Promise<void>): Promise<void> {
  const { c, tenant } = ctx;
  const db = tenantDb(c.prisma, tenant.id);
  const line = await db.bankLine.findUnique({ where: { id: lineId } });
  await c.conversations.set(tenant.id, ctx.conversationId, { step: 'idle' });
  if (!line) return askNextBankLine(ctx);
  const reply = text.trim();
  if (/^(stop|later|exit|done)$/i.test(reply)) return say(ctx, 'OK. Reply "bank" when you want to continue.');
  if (/^(skip|ignore|personal|not business)\b/i.test(reply)) {
    await db.bankLine.update({ where: { id: line.id }, data: { status: 'ignored' } });
    return askNextBankLine(ctx);
  }
  const amount = Number(line.amount);
  const base = { amount, date: line.date, paymentMode: 'bank' };
  if (/^(1|yes|y|ok|correct)$/i.test(reply) && line.status === 'suggested' && line.matchName && !line.draftId) {
    const inv = await c.erp(tenant).get<{ customer?: string; supplier?: string }>(line.matchType ?? 'Sales Invoice', line.matchName);
    const payload: DraftPayload = { partyName: inv.customer ?? inv.supplier, invoiceRef: line.matchName, date: line.date, currency: tenant.currency as Currency, lines: [], total: amount, paymentMode: 'bank', referenceNo: line.reference ?? undefined, validationIssues: [] };
    const draft = await createDraft(c, tenant, { userId: ctx.user.id, type: line.direction === 'in' ? 'payment_in' : 'payment_out', payload, conversationId: ctx.conversationId, confidence: 0.95, actor: { id: ctx.user.id, type: 'user', channel: 'whatsapp' } });
    await db.bankLine.update({ where: { id: line.id }, data: { draftId: draft.id } });
    return;
  }
  const party = (re: RegExp) => reply.replace(re, '').trim() || undefined;
  let intent: IntentResult;
  if (line.direction === 'in') {
    // Who paid: a customer by default; "capital X" / "loan X" go to those ledgers (see ledgerTarget).
    intent = { intent: 'payment_in', confidence: 1, entities: { ...base, party: party(/^(customer|from)\s+/i), description: /capital|loan|owner|director|partner/i.test(reply) ? reply : undefined } };
  } else if (/^(supplier|vendor|to)\s+/i.test(reply) || /\b(drawings?|capital|loan|repaid|repayment)\b/i.test(reply)) {
    intent = { intent: 'payment_out', confidence: 1, entities: { ...base, party: party(/^(supplier|vendor|to)\s+/i), description: /drawings?|capital|loan|repaid|repayment/i.test(reply) ? reply : undefined } };
  } else {
    intent = { intent: 'record_expense', confidence: 1, entities: { ...base, description: reply } };
  }
  await linkDraftToBankLine(ctx, line.id, () => run(intent));
}

/** Run a step of the flow and, if it drafted an entry, tie that entry to the bank line (matched once it posts). */
export async function linkDraftToBankLine(ctx: BotContext, lineId: string, step: () => Promise<void>): Promise<void> {
  const db = tenantDb(ctx.c.prisma, ctx.tenant.id);
  const before = await db.draft.findFirst({ where: { conversationId: ctx.conversationId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  await step();
  const made = await db.draft.findFirst({ where: { conversationId: ctx.conversationId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (made && made.id !== before?.id) {
    await db.bankLine.update({ where: { id: lineId }, data: { status: 'suggested', draftId: made.id, matchType: 'Draft', matchName: null } });
  } else {
    logger.info({ tenantId: ctx.tenant.id, lineId }, 'bank answer did not create an entry yet (more details asked)');
  }
}

/** Today in the tenant's timezone (for SMS without a date). */
export const tenantToday = (tenant: Tenant) => localDate(erpContext(tenant).settings.timezone);
