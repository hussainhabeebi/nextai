/**
 * Answers to questions about the books and the WhatsApp reports, read straight from ERPNext (invoices, payments,
 * the general ledger), so they are exact and need no AI. Formatted for WhatsApp: *bold* headings, one fact per line,
 * names lined up as "• Name — ₹amount".
 */
import { formatMoney, type Currency, type ReportKey } from '@nextai/shared';
import type { ErpClient } from '@nextai/erpnext-client';
import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { fyStart, parsePeriod, type QPeriod, type Question } from '../../ai/question.js';
import { chartTypes, erpContext, type ChartEntry } from '../erpnext/mappers.js';
import { localDate } from '../outbound/time.js';
import { upcomingDeadlines } from '../briefing/deadlines.js';
import { ageing, byRoot, listAll, sumGl, type Ageing, type GlRow } from './analytics.js';
import { runReport } from './reports.js';

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
const round = (v: number) => Math.round(v * 100) / 100;
const short = (account: string) => account.replace(/\s+-\s+[^-]+$/, '');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);

/** Everything an answer needs about the tenant. */
interface Ctx {
  c: Container;
  tenant: Tenant;
  erp: ErpClient;
  company: string;
  today: string;
  m: (n: number) => string;
}

function ctxFor(c: Container, tenant: Tenant): Ctx {
  const { company, settings } = erpContext(tenant);
  const cur = tenant.currency as Currency;
  return { c, tenant, erp: c.erp(tenant), company, today: localDate(settings.timezone), m: (n: number) => formatMoney(round(n), cur) };
}

/** "• Name — ₹1,000.00" lines, biggest first. */
const bullets = (rows: Array<{ label: string; amount: number; note?: string }>, m: Ctx['m'], max = 8) => {
  const out = rows.slice(0, max).map((r) => `• ${r.label} — ${m(r.amount)}${r.note ? ` (${r.note})` : ''}`);
  if (rows.length > max) out.push(`  …and ${rows.length - max} more`);
  return out;
};

const group = (rows: Array<{ key: string; amount: number }>) => {
  const g = new Map<string, { amount: number; n: number }>();
  for (const r of rows) {
    const x = g.get(r.key) ?? { amount: 0, n: 0 };
    x.amount += r.amount;
    x.n += 1;
    g.set(r.key, x);
  }
  return [...g.entries()].map(([label, v]) => ({ label, amount: round(v.amount), n: v.n })).sort((a, b) => b.amount - a.amount);
};

// ---------------- reads ----------------

async function glTotals(x: Ctx, from: string, to: string) {
  const ctx = erpContext(x.tenant);
  const [types, rows] = await Promise.all([
    chartTypes(x.erp, ctx, x.tenant.id),
    listAll<GlRow>(x.erp, 'GL Entry', {
      filters: [['company', '=', x.company], ['is_cancelled', '=', 0], ['posting_date', 'between', [from, to]]],
      fields: ['name', 'account', 'debit', 'credit'],
    }),
  ]);
  return { types, ...byRoot(sumGl(rows), types) };
}

type Invoice = { name: string; party: string; total: number; net: number; outstanding: number; date: string; due: string; isReturn: boolean };
async function invoices(x: Ctx, kind: 'sales' | 'purchases', q: { from?: string; to?: string; party?: string; unpaid?: boolean }): Promise<Invoice[]> {
  const doctype = kind === 'sales' ? 'Sales Invoice' : 'Purchase Invoice';
  const field = kind === 'sales' ? 'customer' : 'supplier';
  const filters: Array<[string, string, unknown]> = [['company', '=', x.company], ['docstatus', '=', 1]];
  if (q.from && q.to) filters.push(['posting_date', 'between', [q.from, q.to]]);
  if (q.party) filters.push([field, '=', q.party]);
  if (q.unpaid) filters.push(['outstanding_amount', '>', 0]);
  const rows = await listAll<Row>(x.erp, doctype, {
    filters,
    fields: ['name', field, 'base_grand_total', 'base_net_total', 'outstanding_amount', 'posting_date', 'due_date', 'is_return'],
  });
  return rows.map((r) => ({
    name: String(r.name),
    party: String(r[field] ?? ''),
    total: num(r.base_grand_total),
    net: num(r.base_net_total ?? r.base_grand_total),
    outstanding: num(r.outstanding_amount),
    date: String(r.posting_date ?? ''),
    due: String(r.due_date ?? r.posting_date ?? ''),
    isReturn: Boolean(num(r.is_return)),
  }));
}

type Payment = { name: string; party: string; amount: number; date: string; mode: string };
async function payments(x: Ctx, type: 'Receive' | 'Pay', from: string, to: string, party?: string): Promise<Payment[]> {
  const filters: Array<[string, string, unknown]> = [['company', '=', x.company], ['docstatus', '=', 1], ['payment_type', '=', type], ['posting_date', 'between', [from, to]]];
  if (party) filters.push(['party', '=', party]);
  const rows = await listAll<Row>(x.erp, 'Payment Entry', { filters, fields: ['name', 'party', 'base_paid_amount', 'paid_amount', 'posting_date', 'mode_of_payment'] });
  return rows.map((r) => ({ name: String(r.name), party: String(r.party ?? ''), amount: num(r.base_paid_amount ?? r.paid_amount), date: String(r.posting_date ?? ''), mode: String(r.mode_of_payment ?? '') }));
}

/** Cash and bank balances from the ledger (works even where get_balance_on is not allowed). */
export async function moneyBalances(c: Container, tenant: Tenant, asOf?: string): Promise<{ cash: number; bank: number; accounts: Array<{ account: string; type: string; balance: number }> }> {
  const ctx = erpContext(tenant);
  const erp = c.erp(tenant);
  const to = asOf ?? localDate(ctx.settings.timezone);
  try {
    const types = await chartTypes(erp, ctx, tenant.id);
    const money = [...types.entries()].filter(([, t]) => t.accountType === 'Cash' || t.accountType === 'Bank');
    if (money.length) {
      const sums = sumGl(
        await listAll<GlRow>(erp, 'GL Entry', {
          filters: [['company', '=', ctx.company], ['is_cancelled', '=', 0], ['account', 'in', money.map(([n]) => n)], ['posting_date', '<=', to]],
          fields: ['name', 'account', 'debit', 'credit'],
        }),
      );
      const accounts = money.map(([account, t]) => {
        const s = sums.find((r) => r.account === account);
        return { account, type: t.accountType!, balance: round(s ? s.debit - s.credit : 0) };
      });
      return {
        cash: round(accounts.filter((a) => a.type === 'Cash').reduce((s, a) => s + a.balance, 0)),
        bank: round(accounts.filter((a) => a.type === 'Bank').reduce((s, a) => s + a.balance, 0)),
        accounts,
      };
    }
  } catch (err) {
    logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'ledger balances failed; trying ERPNext balances');
  }
  return erp.getBalances(ctx.company);
}

/** The customer/supplier the owner meant ("ravi" → "Ravi Traders"), exact name first. */
async function findParty(x: Ctx, typed: string): Promise<{ customer?: string; supplier?: string }> {
  const pick = async (doctype: 'Customer' | 'Supplier') => {
    const rows = await x.erp.list<{ name: string }>(doctype, { filters: [['name', 'like', `%${typed}%`]], fields: ['name'], limit: 20 }).catch(() => []);
    const lower = typed.toLowerCase();
    return (rows.find((r) => r.name.toLowerCase() === lower) ?? rows.find((r) => r.name.toLowerCase().startsWith(lower)) ?? rows[0])?.name;
  };
  const [customer, supplier] = await Promise.all([pick('Customer'), pick('Supplier')]);
  return { customer, supplier };
}

// ---------------- answers ----------------

/** Answer a parsed question from the books. */
export async function answerQuestion(c: Container, tenant: Tenant, q: Question): Promise<string> {
  const x = ctxFor(c, tenant);
  try {
    return await answer(x, q);
  } catch (err) {
    logger.warn({ tenantId: tenant.id, topic: q.topic, err: (err as Error).message }, 'answer failed');
    return "I couldn't read your books right now. Please try again in a few minutes.";
  }
}

async function answer(x: Ctx, q: Question): Promise<string> {
  const { m } = x;
  const p = q.period;
  const oneDay = p.from === p.to;
  switch (q.topic) {
    case 'sales':
    case 'purchases': {
      const sales = q.topic === 'sales';
      let party: string | undefined;
      if (q.party) {
        const f = await findParty(x, q.party);
        party = sales ? f.customer : f.supplier;
        if (!party) return `I couldn't find a ${sales ? 'customer' : 'supplier'} called "${q.party}" in your books.`;
      }
      const rows = await invoices(x, q.topic, { from: p.from, to: p.to, party });
      const icon = sales ? '📈' : '🛒';
      const title = `${icon} *${sales ? 'Sales' : 'Purchases'}${party ? ` ${sales ? 'to' : 'from'} ${party}` : ''} · ${p.label}*`;
      if (!rows.length) {
        const lines = [title, `No ${sales ? 'sales invoices' : 'purchase bills'} ${oneDay ? 'on this day' : 'in this period'}.`];
        if (oneDay && !party && sales) {
          // a day with no sales: give the month so far for context
          const month = await invoices(x, 'sales', { from: `${p.to.slice(0, 8)}01`, to: p.to });
          if (month.length) lines.push(`This month so far: *${m(month.reduce((s, r) => s + r.net, 0))}* from ${plural(month.length, 'invoice')}.`);
        }
        return lines.join('\n');
      }
      const normal = rows.filter((r) => !r.isReturn);
      const returns = rows.filter((r) => r.isReturn);
      const total = rows.reduce((s, r) => s + r.total, 0);
      const net = rows.reduce((s, r) => s + r.net, 0);
      // The headline is before tax, like the P&L and the briefing; the invoiced total (with tax) follows.
      const lines = [title, `${sales ? 'Sales' : 'Purchases'}: *${m(net)}* · ${plural(normal.length, sales ? 'invoice' : 'bill')}`];
      if (Math.abs(total - net) >= 0.01) lines.push(`With tax: ${m(total)} (tax ${m(total - net)})`);
      if (returns.length) lines.push(`Includes ${plural(returns.length, 'return')}: ${m(returns.reduce((s, r) => s + r.total, 0))}`);
      const unpaid = rows.reduce((s, r) => s + Math.max(0, r.outstanding), 0);
      if (unpaid > 0) lines.push(`Still ${sales ? 'to collect' : 'to pay'}: ${m(unpaid)}`);
      if (party) {
        lines.push('', ...normal.slice(-8).map((r) => `• ${day(r.date)} ${r.name} — ${m(r.net)}${r.outstanding > 0 ? ' (unpaid)' : ''}`));
      } else {
        const byParty = group(rows.map((r) => ({ key: r.party, amount: r.net })));
        lines.push('', `*By ${sales ? 'customer' : 'supplier'}*`, ...bullets(byParty.map((g) => ({ label: g.label, amount: g.amount })), m, 6));
      }
      return lines.join('\n');
    }

    case 'expenses': {
      const g = await glTotals(x, p.from, p.to);
      let rows = [...g.expense.entries()].map(([a, v]) => ({ label: short(a), amount: round(v) })).filter((r) => Math.abs(r.amount) >= 0.01);
      if (q.about) {
        const words = q.about.split(/\s+/).filter((w) => w.length > 2);
        rows = rows.filter((r) => words.some((w) => r.label.toLowerCase().includes(w.replace(/s$/, ''))));
        if (!rows.length) return `💸 *Expenses on ${q.about} · ${p.label}*\nNothing booked to a ${q.about} account in this period.`;
      }
      rows.sort((a, b) => b.amount - a.amount);
      const total = rows.reduce((s, r) => s + r.amount, 0);
      if (!rows.length) return `💸 *Expenses · ${p.label}*\nNo expenses booked ${oneDay ? 'on this day' : 'in this period'}.`;
      return [`💸 *Expenses${q.about ? ` on ${q.about}` : ''} · ${p.label}*`, `Total: *${m(total)}*`, '', ...(rows.length > 1 || !q.about ? ['*By account*', ...bullets(rows, m, 8)] : [])].join('\n').trim();
    }

    case 'profit': {
      const g = await glTotals(x, p.from, p.to);
      return profitText(x, p, g);
    }

    case 'received':
    case 'paid': {
      const inn = q.topic === 'received';
      let party: string | undefined;
      if (q.party) {
        const f = await findParty(x, q.party);
        party = inn ? (f.customer ?? f.supplier) : (f.supplier ?? f.customer);
        if (!party) return `I couldn't find "${q.party}" in your books.`;
      }
      const rows = await payments(x, inn ? 'Receive' : 'Pay', p.from, p.to, party);
      const title = `${inn ? '💰' : '💸'} *${inn ? 'Money received' : 'Payments made'}${party ? ` ${inn ? 'from' : 'to'} ${party}` : ''} · ${p.label}*`;
      if (!rows.length) return `${title}\nNo ${inn ? 'payments received' : 'payments made'} ${oneDay ? 'on this day' : 'in this period'}.`;
      const total = rows.reduce((s, r) => s + r.amount, 0);
      const lines = [title, `Total: *${m(total)}* · ${plural(rows.length, 'payment')}`, ''];
      if (party) lines.push(...rows.slice(-8).map((r) => `• ${day(r.date)} — ${m(r.amount)}${r.mode ? ` (${r.mode})` : ''}`));
      else lines.push(`*By ${inn ? 'customer' : 'supplier'}*`, ...bullets(group(rows.map((r) => ({ key: r.party, amount: r.amount }))), m, 6));
      const modes = group(rows.map((r) => ({ key: r.mode || 'Other', amount: r.amount })));
      if (modes.length > 1) lines.push('', `By mode: ${modes.map((g) => `${g.label} ${m(g.amount)}`).join(' · ')}`);
      return lines.join('\n').trim();
    }

    case 'receivables':
    case 'payables': {
      const recv = q.topic === 'receivables';
      const r = await runReport(x.c, x.tenant, recv ? 'receivables' : 'payables');
      return ageingText(x, recv, ageing(r, x.today));
    }

    case 'cash': {
      const b = await moneyBalances(x.c, x.tenant);
      const lines = [`🏦 *Cash & bank · ${day(x.today)}*`, `Total: *${m(b.cash + b.bank)}*`, `Cash: ${m(b.cash)} · Bank: ${m(b.bank)}`];
      const accounts = b.accounts.filter((a) => Math.abs(a.balance) >= 0.01);
      if (accounts.length > 1) lines.push('', ...accounts.map((a) => `• ${short(a.account)} — ${m(a.balance)}`));
      if (b.cash < 0) lines.push('', '⚠️ Cash is negative: some cash expenses may have been paid from the bank or a sale is missing.');
      return lines.join('\n');
    }

    case 'party': {
      const f = await findParty(x, q.party ?? '');
      if (!f.customer && !f.supplier) return `I couldn't find "${q.party}" in your customers or suppliers.`;
      const lines: string[] = [];
      for (const [kind, name] of [['sales', f.customer], ['purchases', f.supplier]] as const) {
        if (!name) continue;
        const open = (await invoices(x, kind, { party: name, unpaid: true })).sort((a, b) => a.due.localeCompare(b.due));
        const owed = open.reduce((s, r) => s + r.outstanding, 0);
        const isCust = kind === 'sales';
        lines.push(`👤 *${name}* (${isCust ? 'customer' : 'supplier'})`);
        if (!open.length) lines.push(isCust ? 'Nothing pending: all invoices are paid ✅' : 'Nothing to pay: all bills are paid ✅');
        else {
          const late = open.filter((r) => r.due < x.today);
          lines.push(`${isCust ? 'Owes you' : 'You owe'}: *${m(owed)}* · ${plural(open.length, isCust ? 'unpaid invoice' : 'unpaid bill')}`);
          if (late.length) lines.push(`Overdue: ${m(late.reduce((s, r) => s + r.outstanding, 0))} (oldest ${daysBetween(late[0]!.due, x.today)} days late)`);
          lines.push(...open.slice(0, 6).map((r) => `• ${r.name} · due ${day(r.due)} — ${m(r.outstanding)}`));
        }
        const pays = await payments(x, isCust ? 'Receive' : 'Pay', fyStart(x.tenant.country, x.today), x.today, name).catch(() => []);
        const last = pays.sort((a, b) => a.date.localeCompare(b.date)).at(-1);
        if (last) lines.push(`Last payment: ${m(last.amount)} on ${day(last.date)}`);
        if (isCust && owed > 0) lines.push(`Reply "remind ${name}" to send a reminder.`);
        lines.push('');
      }
      return lines.join('\n').trim();
    }

    case 'top_customers':
    case 'top_suppliers': {
      const sales = q.topic === 'top_customers';
      const rows = await invoices(x, sales ? 'sales' : 'purchases', { from: p.from, to: p.to });
      const title = `🏆 *Top ${sales ? 'customers' : 'suppliers'} · ${p.label}*`;
      if (!rows.length) return `${title}\nNo ${sales ? 'sales' : 'purchases'} in this period.`;
      const g = group(rows.map((r) => ({ key: r.party, amount: r.net })));
      return [title, ...g.slice(0, 5).map((r, i) => `${i + 1}. ${r.label} — ${m(r.amount)} (${plural(r.n, sales ? 'invoice' : 'bill')})`), '', `Total (before tax): ${m(g.reduce((s, r) => s + r.amount, 0))}`].join('\n');
    }

    case 'unpaid_invoices':
    case 'unpaid_bills': {
      const sales = q.topic === 'unpaid_invoices';
      const rows = (await invoices(x, sales ? 'sales' : 'purchases', { unpaid: true })).sort((a, b) => a.due.localeCompare(b.due));
      const title = `🧾 *Unpaid ${sales ? 'sales invoices' : 'purchase bills'}*`;
      if (!rows.length) return `${title}\nNone 🎉`;
      const total = rows.reduce((s, r) => s + r.outstanding, 0);
      const lines = [title, `Total: *${m(total)}* · ${plural(rows.length, sales ? 'invoice' : 'bill')}`, ''];
      for (const r of rows.slice(0, 10)) {
        const late = daysBetween(r.due, x.today);
        lines.push(`• ${r.party} · ${r.name} — ${m(r.outstanding)} (${late > 0 ? `${late} days late` : late === 0 ? 'due today' : `due ${day(r.due)}`})`);
      }
      if (rows.length > 10) lines.push(`  …and ${rows.length - 10} more`);
      return lines.join('\n');
    }

    case 'tax': {
      const g = await glTotals(x, p.from, p.to);
      const label = x.tenant.country === 'IN' ? 'GST' : 'VAT';
      const lines = [`🧮 *${label} · ${p.label}*`];
      lines.push(g.tax >= 0 ? `Net ${label} payable: *${m(g.tax)}*` : `Input credit more than output: *${m(-g.tax)}* to carry forward`);
      lines.push('(Output tax collected minus input tax paid, from your ledger)');
      const due = upcomingDeadlines(x.tenant.country, erpContext(x.tenant).settings, x.today, 30).slice(0, 3);
      if (due.length) lines.push('', '*Coming up*', ...due.map((d) => `📅 ${d.what} — due ${day(d.due)} (${dueIn(daysBetween(x.today, d.due))})`));
      return lines.join('\n');
    }

    case 'pending': {
      const db = tenantDb(x.c.prisma, x.tenant.id);
      const drafts = await db.draft.findMany({ where: { status: { in: ['pending', 'needs_review'] } }, orderBy: { createdAt: 'asc' }, take: 10 });
      if (!drafts.length) return '⏳ *Waiting for approval*\nNothing waiting 🎉';
      const label: Record<string, string> = { purchase_invoice: 'Purchase bill', journal_entry: 'Expense', sales_invoice: 'Sales invoice', payment_in: 'Payment received', payment_out: 'Payment made' };
      return [
        `⏳ *Waiting for approval* · ${drafts.length}`,
        ...drafts.map((d) => {
          const pl = d.payload as { partyName?: string; remarks?: string; total?: number };
          return `• ${label[d.type] ?? d.type}${pl.partyName ? ` · ${pl.partyName}` : pl.remarks ? ` · ${pl.remarks}` : ''} — ${m(num(pl.total))}`;
        }),
        '',
        'Open the NextAi app → Approvals to review them.',
      ].join('\n');
    }

    case 'summary':
    default: {
      const [g, b, r] = await Promise.all([
        glTotals(x, p.from, p.to),
        moneyBalances(x.c, x.tenant).catch(() => null),
        runReport(x.c, x.tenant, 'receivables').then((res) => ageing(res, x.today)).catch(() => null),
      ]);
      const lines = [`📊 *Business summary · ${p.label}*`, `Income: ${m(g.incomeTotal)}`, `Expenses: ${m(g.expenseTotal)}`, `${g.incomeTotal - g.expenseTotal >= 0 ? 'Profit' : 'Loss'}: *${m(Math.abs(g.incomeTotal - g.expenseTotal))}*`];
      if (b) lines.push(`Cash & bank: ${m(b.cash + b.bank)}`);
      if (r) lines.push(`Customers owe: ${m(r.total)}${r.overdue ? ` (${m(r.overdue)} overdue)` : ''}`);
      return lines.join('\n');
    }
  }
}

const dueIn = (n: number) => (n < 0 ? `${-n} days ago` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);

function profitText(x: Ctx, p: QPeriod, g: Awaited<ReturnType<typeof glTotals>>): string {
  const { m } = x;
  const net = g.incomeTotal - g.expenseTotal;
  const lines = [`📊 *Profit & Loss · ${p.label}*`, `Income: ${m(g.incomeTotal)}`, `Expenses: ${m(g.expenseTotal)}`, `${net >= 0 ? '✅ Net profit' : '🔻 Net loss'}: *${m(Math.abs(net))}*`];
  if (g.incomeTotal > 0) lines.push(`Margin: ${((net / g.incomeTotal) * 100).toFixed(1)}%`);
  const top = (mp: Map<string, number>) => [...mp.entries()].map(([a, v]) => ({ label: short(a), amount: round(v) })).filter((r) => Math.abs(r.amount) >= 0.01).sort((a, b) => b.amount - a.amount);
  const inc = top(g.income);
  const exp = top(g.expense);
  if (inc.length) lines.push('', '*Income*', ...bullets(inc, m, 5));
  if (exp.length) lines.push('', '*Expenses*', ...bullets(exp, m, 6));
  if (!inc.length && !exp.length) lines.push('', 'Nothing booked in this period yet.');
  return lines.join('\n');
}

function ageingText(x: Ctx, recv: boolean, a: Ageing): string {
  const { m } = x;
  const title = recv ? '💸 *Customers owe you*' : '🧾 *You owe suppliers*';
  if (!a.total) return `${title}\nNothing outstanding 🎉`;
  const lines = [title, `Total: *${m(a.total)}*${a.overdue ? ` · overdue ${m(a.overdue)}` : ''}`, ''];
  lines.push(...a.parties.slice(0, 8).map((p) => `• ${p.party} — ${m(p.outstanding)}${p.overdue > 0 ? ` (${p.oldestDays ? `${p.oldestDays} days` : 'overdue'})` : ''}`));
  const buckets = a.buckets.filter((b) => b.amount);
  if (buckets.length > 1) lines.push('', `*By age:* ${buckets.map((b) => `${b.label} ${m(b.amount)}`).join(' · ')}`);
  if (recv && a.parties[0]) lines.push('', `Reply "remind ${a.parties[0].party}" to send a reminder.`);
  return lines.join('\n');
}

// ---------------- reports ----------------

/** A WhatsApp report: "report p&l", "balance sheet", "receivables", "cash flow last month", "ledger of Ravi". */
export async function reportText(c: Container, tenant: Tenant, key: ReportKey, text = ''): Promise<string> {
  const x = ctxFor(c, tenant);
  const named = parsePeriod(text, x.today, tenant.country);
  try {
    switch (key) {
      case 'profit_and_loss': {
        const fy = fyStart(tenant.country, x.today);
        const p: QPeriod = named ?? { label: `this ${tenant.country === 'IN' ? 'financial ' : ''}year (${day(fy)} – ${day(x.today)})`, from: fy, to: x.today, explicit: false };
        return `${profitText(x, p, await glTotals(x, p.from, p.to))}\n\nFull report: NextAi app → Reports.`;
      }
      case 'receivables':
      case 'payables':
        return ageingText(x, key === 'receivables', ageing(await runReport(c, tenant, key), x.today));
      case 'balance_sheet':
        return await balanceSheet(x, named?.to ?? x.today);
      case 'cash_flow': {
        const p = named ?? { label: `this month`, from: `${x.today.slice(0, 8)}01`, to: x.today, explicit: false };
        return await cashFlow(x, p);
      }
      case 'general_ledger': {
        const party = text.match(/\b(?:ledger|statement|account)\s+(?:of|for)\s+(.+)$/i)?.[1]?.replace(named?.match ?? '\u0000', '').trim();
        if (party) return await answer(x, { topic: 'party', party, period: named ?? { label: '', from: x.today, to: x.today, explicit: false } });
        const p = named ?? { label: 'this month', from: `${x.today.slice(0, 8)}01`, to: x.today, explicit: false };
        return await recentEntries(x, p);
      }
    }
  } catch (err) {
    logger.warn({ tenantId: tenant.id, key, err: (err as Error).message }, 'report failed');
    return 'Your books are busy right now. Please try again in a few minutes.';
  }
}

async function balanceSheet(x: Ctx, asOf: string): Promise<string> {
  const { m } = x;
  const ctx = erpContext(x.tenant);
  const [types, rows] = await Promise.all([
    chartTypes(x.erp, ctx, x.tenant.id),
    listAll<GlRow>(x.erp, 'GL Entry', { filters: [['company', '=', x.company], ['is_cancelled', '=', 0], ['posting_date', '<=', asOf]], fields: ['name', 'account', 'debit', 'credit'] }),
  ]);
  const sums = sumGl(rows);
  const side = (root: string, sign: 1 | -1) =>
    sums
      .filter((s) => (types.get(s.account) as ChartEntry | undefined)?.rootType === root)
      .map((s) => ({ label: short(s.account), amount: round(sign * (s.debit - s.credit)) }))
      .filter((r) => Math.abs(r.amount) >= 0.01)
      .sort((a, b) => b.amount - a.amount);
  const assets = side('Asset', 1);
  const liabilities = side('Liability', -1);
  const equity = side('Equity', -1);
  const pl = byRoot(sums, types);
  const profit = pl.incomeTotal - pl.expenseTotal;
  const total = (r: Array<{ amount: number }>) => r.reduce((s, v) => s + v.amount, 0);
  return [
    `📒 *Balance Sheet · as of ${day(asOf)}*`,
    '',
    `*Assets: ${m(total(assets))}*`,
    ...bullets(assets, m, 6),
    '',
    `*Liabilities: ${m(total(liabilities))}*`,
    ...bullets(liabilities, m, 6),
    '',
    `*Capital: ${m(total(equity) + profit)}*`,
    ...bullets([...equity, { label: profit >= 0 ? 'Profit to date' : 'Loss to date', amount: round(profit) }], m, 6),
    '',
    'Full report: NextAi app → Reports.',
  ].join('\n');
}

async function cashFlow(x: Ctx, p: QPeriod): Promise<string> {
  const { m } = x;
  const before = new Date(Date.parse(`${p.from}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  const [open, close] = await Promise.all([moneyBalances(x.c, x.tenant, before), moneyBalances(x.c, x.tenant, p.to)]);
  const [inn, out] = await Promise.all([payments(x, 'Receive', p.from, p.to), payments(x, 'Pay', p.from, p.to)]);
  const opening = open.cash + open.bank;
  const closing = close.cash + close.bank;
  const received = inn.reduce((s, r) => s + r.amount, 0);
  const paid = out.reduce((s, r) => s + r.amount, 0);
  const other = closing - opening - received + paid;
  return [
    `💧 *Cash flow · ${p.label}*`,
    `Opening cash & bank: ${m(opening)}`,
    `+ Received from customers: ${m(received)}`,
    `− Paid to suppliers: ${m(paid)}`,
    `± Expenses, capital & other: ${m(other)}`,
    `*Closing cash & bank: ${m(closing)}*`,
  ].join('\n');
}

async function recentEntries(x: Ctx, p: QPeriod): Promise<string> {
  const rows = await listAll<Row>(x.erp, 'GL Entry', {
    filters: [['company', '=', x.company], ['is_cancelled', '=', 0], ['posting_date', 'between', [p.from, p.to]]],
    fields: ['name', 'posting_date', 'account', 'debit', 'credit', 'voucher_no', 'party'],
  });
  if (!rows.length) return `📖 *Ledger · ${p.label}*\nNo entries in this period.`;
  const last = rows.sort((a, b) => String(a.posting_date).localeCompare(String(b.posting_date))).slice(-12);
  return [
    `📖 *Ledger · ${p.label}* · ${plural(rows.length, 'line')}`,
    ...last.map((r) => `• ${day(String(r.posting_date))} ${short(String(r.account))}${r.party ? ` (${r.party})` : ''} — ${num(r.debit) ? `Dr ${x.m(num(r.debit))}` : `Cr ${x.m(num(r.credit))}`}`),
    '',
    'Full ledger: NextAi app → Reports.',
  ].join('\n');
}
