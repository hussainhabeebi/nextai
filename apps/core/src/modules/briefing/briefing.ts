/**
 * Daily briefing (WhatsApp + email): today's sales and expenses from the ledger, cash & bank, who to chase,
 * the next tax deadlines with what still blocks filing, approvals waiting and bank lines to check.
 * Also: deadline warnings to owners/accountants 7, 2 and 0 days before each filing.
 */
import { formatMoney, type Currency } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { erpContext } from '../erpnext/mappers.js';
import { sendWhatsApp } from '../outbound/whatsapp.js';
import { localDate } from '../outbound/time.js';
import { dayTotals } from '../reports/analytics.js';
import { daysBetween, upcomingDeadlines, type Deadline } from './deadlines.js';

type Overdue = { name: string; customer: string; outstanding_amount: number; due_date: string };

export interface Blockers {
  pending: number;
  erpDrafts: number;
  noTaxId: number;
}

const short = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const long = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const RULE = '━━━━━━━━━━━━━━━━━━';
const NUM = ['1️⃣', '2️⃣', '3️⃣'];
const lateIcon = (days: number) => (days > 30 ? '🔴' : days > 7 ? '🟠' : '🟡');
const inDays = (n: number) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);

/** What still has to be done before the books are ready to file. */
export async function filingBlockers(c: Container, tenant: Tenant, today: string): Promise<Blockers> {
  const db = tenantDb(c.prisma, tenant.id);
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 62 * 86400_000);
  const [pending, posted] = await Promise.all([
    db.draft.count({ where: { status: { in: ['pending', 'needs_review', 'failed'] } } }),
    db.draft.findMany({ where: { status: 'posted', type: 'purchase_invoice', updatedAt: { gte: since } }, select: { payload: true } }),
  ]);
  // GST/VAT input credit needs the supplier's GSTIN/TRN on the bill.
  const noTaxId = posted.filter((d) => !(d.payload as { partyTaxId?: string }).partyTaxId).length;
  let erpDrafts = 0;
  try {
    const erp = c.erp(tenant);
    const [si, pi] = await Promise.all([
      erp.list('Sales Invoice', { filters: [['docstatus', '=', 0]], fields: ['name'], limit: 100 }),
      erp.list('Purchase Invoice', { filters: [['docstatus', '=', 0]], fields: ['name'], limit: 100 }),
    ]);
    erpDrafts = si.length + pi.length;
  } catch {
    /* ERPNext unreachable: report what we know */
  }
  return { pending, erpDrafts, noTaxId };
}

function blockerText(b: Blockers, country: 'IN' | 'AE'): string | undefined {
  const parts = [
    b.pending ? `${b.pending} entr${b.pending === 1 ? 'y' : 'ies'} waiting for approval in NextAi` : undefined,
    b.erpDrafts ? `${b.erpDrafts} unsubmitted invoice${b.erpDrafts === 1 ? '' : 's'} in ERPNext` : undefined,
    b.noTaxId ? `${b.noTaxId} purchase bill${b.noTaxId === 1 ? '' : 's'} without the supplier's ${country === 'IN' ? 'GSTIN' : 'TRN'}` : undefined,
  ].filter(Boolean);
  return parts.length ? `Before filing: ${parts.join(' · ')}` : undefined;
}

export interface Briefing {
  day: string;
  text: string;
  /** For the email version. */
  rows: Array<{ label: string; value: string }>;
  /** The 4 values of the approved daily_summary template. */
  templateVars: { sales: string; expenses: string; cash: string; pending: string };
  deadlines: Deadline[];
}

export async function buildBriefing(c: Container, tenant: Tenant, at = new Date()): Promise<Briefing> {
  const { settings, company } = erpContext(tenant);
  const cur = tenant.currency as Currency;
  const m = (n: number) => formatMoney(n, cur);
  const day = localDate(settings.timezone, at);
  const db = tenantDb(c.prisma, tenant.id);
  const erp = c.erp(tenant);

  const [totals, balances, overdue, pending, bankToCheck] = await Promise.all([
    dayTotals(c, tenant, day).catch(() => null),
    erp.getBalances(company).catch(() => null),
    erp
      .list<Overdue>('Sales Invoice', {
        filters: [['docstatus', '=', 1], ['outstanding_amount', '>', 0], ['due_date', '<', day]],
        fields: ['name', 'customer', 'outstanding_amount', 'due_date'],
        orderBy: 'outstanding_amount desc',
        limit: 200,
      })
      .catch(() => [] as Overdue[]),
    db.draft.count({ where: { status: { in: ['pending', 'needs_review'] } } }),
    db.bankLine.count({ where: { OR: [{ status: 'unmatched' }, { status: 'suggested', draftId: null }] } }),
  ]);
  const deadlines = upcomingDeadlines(tenant.country, settings, day, 14);
  const soon = deadlines.filter((d) => daysBetween(day, d.due) <= 7);
  const blockers = soon.length ? await filingBlockers(c, tenant, day) : undefined;

  const sales = totals ? m(totals.income) : 'not available';
  const expenses = totals ? m(totals.expenses) : 'not available';
  const cash = balances ? m(balances.cash + balances.bank) : 'not available right now';
  const owed = overdue.reduce((s, o) => s + o.outstanding_amount, 0);
  const top = overdue.slice(0, 3);
  const todo = [
    pending ? `⏳ ${pending} item${pending === 1 ? '' : 's'} need${pending === 1 ? 's' : ''} your approval` : undefined,
    bankToCheck ? `🏦 ${bankToCheck} bank line${bankToCheck === 1 ? '' : 's'} to check: reply *bank*` : undefined,
  ].filter((x): x is string => !!x);
  const block = blockers && blockerText(blockers, tenant.country);

  const lines = [RULE, `☀️ *Daily Report* · ${long(day)}`, `🏢 ${tenant.name}`, RULE, '', '📊 *TODAY*', `🟢 Sales: *${sales}*`, `🔴 Expenses: *${expenses}*`];
  if (totals) {
    const net = totals.income - totals.expenses;
    lines.push(`${net >= 0 ? '📈' : '📉'} Net: *${m(net)}*`);
  }
  lines.push(`🏦 Cash & bank: ${balances ? `*${cash}*` : `_${cash}_`}`);

  lines.push('', RULE, `💸 *TO COLLECT*${owed > 0 ? ` · ${m(owed)}` : ''}`);
  if (top.length) {
    top.forEach((o, i) => {
      const late = daysBetween(o.due_date, day);
      lines.push(`${NUM[i]} ${o.customer}`, `      ${m(o.outstanding_amount)} · ${lateIcon(late)} ${late} day${late === 1 ? '' : 's'} late`);
    });
    if (overdue.length > top.length) lines.push(`   _+${overdue.length - top.length} more overdue_`);
    lines.push('', `👉 Reply *remind ${top[0]!.customer}* to send a reminder`);
  } else {
    lines.push('🎉 Nothing overdue');
  }

  if (deadlines.length) {
    lines.push('', RULE, '📅 *TAX DEADLINES*');
    for (const d of deadlines.slice(0, 3)) lines.push(`▫️ ${d.what}: due ${short(d.due)} (${inDays(daysBetween(day, d.due))})`);
    if (block) lines.push(`⚠️ ${block}`);
  }

  lines.push('', RULE, '✅ *TO DO*', ...(todo.length ? todo : ['🎉 Nothing waiting for you']), RULE);

  const rows = [
    { label: 'Sales today', value: sales },
    { label: 'Expenses today', value: expenses },
    { label: 'Cash & bank', value: cash },
    { label: 'Waiting for your approval', value: String(pending) },
    ...(overdue.length ? [{ label: 'To collect', value: top.map((o) => `${o.customer} ${m(o.outstanding_amount)}`).join(', ') }] : []),
    ...deadlines.slice(0, 3).map((d) => ({ label: d.what, value: `due ${short(d.due)}` })),
    ...(bankToCheck ? [{ label: 'Bank lines to check', value: String(bankToCheck) }] : []),
  ];
  return { day, text: lines.join('\n'), rows, templateVars: { sales, expenses, cash, pending: String(pending) }, deadlines };
}

/**
 * Deadline warnings at each of settings.taxCalendar.warnDays (7, 2, 0 by default) before a filing. Accountants
 * always get them; owners too when they don't get the daily briefing (which already lists the deadlines).
 */
export async function sendDeadlineWarnings(c: Container, tenant: Tenant, at = new Date()) {
  const { settings } = erpContext(tenant);
  const day = localDate(settings.timezone, at);
  const warn = new Set(settings.taxCalendar.warnDays);
  const due = upcomingDeadlines(tenant.country, settings, day, Math.max(0, ...warn)).filter((d) => warn.has(daysBetween(day, d.due)));
  if (!due.length || !tenant.cwBotTokenEnc) return { sent: 0 };
  const db = tenantDb(c.prisma, tenant.id);
  const roles = settings.dailySummary.enabled ? ['tenant_accountant' as const] : ['owner' as const, 'tenant_accountant' as const];
  const people = await db.user.findMany({ where: { role: { in: roles }, status: { not: 'disabled' }, phone: { not: null } } });
  const block = blockerText(await filingBlockers(c, tenant, day), tenant.country);
  let sent = 0;
  for (const d of due) {
    const left = daysBetween(day, d.due);
    for (const p of people) {
      const ref = `deadline-${d.key}-${left}-${p.id}`;
      if (await db.outboundMessage.findFirst({ where: { kind: 'notice', ref, status: 'sent' } })) continue;
      const text = [`📅 ${tenant.name}: ${d.what} is due ${inDays(left)} (${short(d.due)}).`, block, d.note, 'Dates can move: check the tax portal for extensions.'].filter(Boolean).join('\n');
      try {
        await sendWhatsApp(c, tenant, { kind: 'notice', phone: p.phone!, name: p.name, templateKey: 'tax_deadline', params: [tenant.name, d.what, short(d.due), String(left)], fallbackText: text, ref });
        sent++;
      } catch (err) {
        logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'deadline warning failed');
      }
    }
  }
  return { sent };
}

