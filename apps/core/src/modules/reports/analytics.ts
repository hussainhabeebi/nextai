/**
 * Business analytics read from the ERPNext general ledger, so every entry counts: WhatsApp, the app, AND anything
 * entered directly in ERPNext ("two-way"). A few grouped queries (sum per account / month / party), then a pure
 * `buildAnalytics` that turns them into KPIs, trends, breakdowns and plain-language insights.
 */
import type { ErpClient, ReportResult } from '@nextai/erpnext-client';
import { formatMoney, type Currency } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { chartTypes, erpContext, type ChartEntry } from '../erpnext/mappers.js';
import { fiscalYearStart, runReport } from './reports.js';

export const PERIODS = ['this_month', 'last_month', 'this_quarter', 'fiscal_year'] as const;
export type PeriodKey = (typeof PERIODS)[number];
export interface Period {
  key: PeriodKey | 'custom';
  label: string;
  from: string;
  to: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const ymd = (y: number, m: number, d: number) => iso(new Date(Date.UTC(y, m, d)));
const endOfMonth = (y: number, m: number) => ymd(y, m + 1, 0);

/** The selected period and the one before it (same length) for comparisons. */
export function periodsFor(key: PeriodKey, country: 'IN' | 'AE', now = new Date()): { current: Period; previous: Period } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = iso(now);
  switch (key) {
    case 'last_month':
      return {
        current: { key, label: 'Last month', from: ymd(y, m - 1, 1), to: endOfMonth(y, m - 1) },
        previous: { key, label: 'Month before', from: ymd(y, m - 2, 1), to: endOfMonth(y, m - 2) },
      };
    case 'this_quarter': {
      const q = Math.floor(m / 3) * 3;
      const days = Math.round((now.getTime() - Date.UTC(y, q, 1)) / 86400_000);
      return {
        current: { key, label: 'This quarter', from: ymd(y, q, 1), to: today },
        previous: { key, label: 'Same days last quarter', from: ymd(y, q - 3, 1), to: iso(new Date(Date.UTC(y, q - 3, 1) + days * 86400_000)) },
      };
    }
    case 'fiscal_year': {
      const fy = fiscalYearStart(country, now);
      const start = new Date(`${fy}T00:00:00Z`);
      const days = Math.round((now.getTime() - start.getTime()) / 86400_000);
      const prevStart = new Date(Date.UTC(start.getUTCFullYear() - 1, start.getUTCMonth(), 1));
      return {
        current: { key, label: 'Financial year to date', from: fy, to: today },
        previous: { key, label: 'Same period last year', from: iso(prevStart), to: iso(new Date(prevStart.getTime() + days * 86400_000)) },
      };
    }
    default: {
      const day = now.getUTCDate();
      return {
        current: { key: 'this_month', label: 'This month', from: ymd(y, m, 1), to: today },
        // month-to-date vs the same days last month, so a half month isn't compared with a full one
        previous: { key: 'this_month', label: 'Same days last month', from: ymd(y, m - 1, 1), to: ymd(y, m - 1, Math.min(day, new Date(Date.UTC(y, m, 0)).getUTCDate())) },
      };
    }
  }
}

type GlSum = { account: string; debit: number; credit: number };
type GlMonth = GlSum & { month: string };
type PartySum = { party: string; total: number; n: number };
type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
const round = (v: number) => Math.round(v * 100) / 100;

export interface RawAnalytics {
  types: Map<string, ChartEntry>;
  current: GlSum[];
  previous: GlSum[];
  months: GlMonth[];
  balances: GlSum[] | null;
  customers: PartySum[];
  suppliers: PartySum[];
  receivables: ReportResult | null;
  payables: ReportResult | null;
  errors: string[];
}

/** Read everything the analytics need (few grouped queries). Partial failures are reported, not hidden as zeros. */
export async function fetchAnalytics(c: Container, tenant: Tenant, current: Period, previous: Period, monthsBack = 6): Promise<RawAnalytics> {
  const ctx = erpContext(tenant);
  const erp: ErpClient = c.erp(tenant);
  const errors: string[] = [];
  const attempt = async <T>(label: string, f: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      errors.push(`${label}: ${(err as { userMessage?: string }).userMessage ?? (err as Error).message}`);
      return fallback;
    }
  };
  const glBase = [['company', '=', ctx.company], ['is_cancelled', '=', 0]] as Array<[string, string, unknown]>;
  const sums = (from: string, to: string) =>
    erp.list<GlSum>('GL Entry', {
      filters: [...glBase, ['posting_date', 'between', [from, to]]],
      fields: ['account', 'sum(debit) as debit', 'sum(credit) as credit'],
      groupBy: 'account',
      limit: 5000,
    });
  const now = new Date(`${current.to}T00:00:00Z`);
  const trendFrom = ymd(now.getUTCFullYear(), now.getUTCMonth() - (monthsBack - 1), 1);
  const partyTotals = (doctype: 'Sales Invoice' | 'Purchase Invoice', field: 'customer' | 'supplier') =>
    erp.list<{ party: string; total: number; n: number }>(doctype, {
      filters: [['company', '=', ctx.company], ['docstatus', '=', 1], ['posting_date', 'between', [current.from, current.to]]],
      fields: [`${field} as party`, 'sum(base_net_total) as total', 'count(name) as n'],
      groupBy: field,
      orderBy: 'total desc',
      limit: 10,
    });

  const [types, cur, prev, months, customers, suppliers, receivables, payables] = await Promise.all([
    attempt('chart of accounts', () => chartTypes(erp, ctx, tenant.id), new Map<string, ChartEntry>()),
    attempt('ledger (this period)', () => sums(current.from, current.to), [] as GlSum[]),
    attempt('ledger (previous period)', () => sums(previous.from, previous.to), [] as GlSum[]),
    attempt('monthly trend', () =>
      erp.list<GlMonth>('GL Entry', {
        filters: [...glBase, ['posting_date', 'between', [trendFrom, current.to]]],
        fields: ['date_format(posting_date, "%Y-%m") as month', 'account', 'sum(debit) as debit', 'sum(credit) as credit'],
        groupBy: 'month, account',
        limit: 20000,
      }), [] as GlMonth[]),
    attempt('customers', () => partyTotals('Sales Invoice', 'customer'), [] as PartySum[]),
    attempt('suppliers', () => partyTotals('Purchase Invoice', 'supplier'), [] as PartySum[]),
    attempt('receivables', () => runReport(c, tenant, 'receivables'), null as ReportResult | null),
    attempt('payables', () => runReport(c, tenant, 'payables'), null as ReportResult | null),
  ]);
  const moneyAccounts = [...types.entries()].filter(([, t]) => t.accountType === 'Cash' || t.accountType === 'Bank').map(([n]) => n);
  const balances = moneyAccounts.length
    ? await attempt('cash & bank balances', () =>
        erp.list<GlSum>('GL Entry', {
          filters: [...glBase, ['account', 'in', moneyAccounts], ['posting_date', '<=', current.to]],
          fields: ['account', 'sum(debit) as debit', 'sum(credit) as credit'],
          groupBy: 'account',
          limit: 500,
        }), null as GlSum[] | null)
    : null;
  return { types, current: cur, previous: prev, months, balances, customers, suppliers, receivables, payables, errors };
}

export interface Analytics {
  currency: Currency;
  period: Period;
  previous: Period;
  kpis: { income: number; expenses: number; profit: number; margin: number | null; taxPayable: number; prev: { income: number; expenses: number; profit: number } };
  balances: { cash: number; bank: number; accounts: Array<{ account: string; ledger: string; type: string; balance: number }> } | null;
  trend: Array<{ month: string; income: number; expenses: number; profit: number }>;
  expenseByAccount: Array<{ account: string; ledger: string; amount: number; prev: number }>;
  incomeByAccount: Array<{ account: string; ledger: string; amount: number; prev: number }>;
  topCustomers: Array<{ party: string; amount: number; count: number }>;
  topSuppliers: Array<{ party: string; amount: number; count: number }>;
  receivables: Ageing;
  payables: Ageing;
  insights: Array<{ tone: 'good' | 'warn' | 'info'; text: string }>;
  errors: string[];
}
export interface Ageing {
  total: number;
  overdue: number;
  buckets: Array<{ label: string; amount: number }>;
  parties: Array<{ party: string; outstanding: number; overdue: number; oldestDays: number }>;
}

const short = (account: string) => account.replace(/\s+-\s+[^-]+$/, '');

function byRoot(rows: GlSum[], types: Map<string, ChartEntry>) {
  const income = new Map<string, number>();
  const expense = new Map<string, number>();
  let tax = 0;
  for (const r of rows) {
    const t = types.get(r.account);
    if (t?.rootType === 'Income') income.set(r.account, (income.get(r.account) ?? 0) + num(r.credit) - num(r.debit));
    else if (t?.rootType === 'Expense') expense.set(r.account, (expense.get(r.account) ?? 0) + num(r.debit) - num(r.credit));
    if (t?.accountType === 'Tax') tax += num(r.credit) - num(r.debit); // output tax − input tax
  }
  const total = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);
  return { income, expense, incomeTotal: total(income), expenseTotal: total(expense), tax };
}

const BUCKETS: Array<[string, string]> = [['range1', '0–30 days'], ['range2', '31–60 days'], ['range3', '61–90 days'], ['range4', '91–120 days'], ['range5', '120+ days']];

function ageing(r: ReportResult | null, today: string): Ageing {
  const rows = ((r?.result ?? []) as Row[]).filter((x) => x && typeof x === 'object' && x.party && num(x.outstanding) !== 0);
  const buckets = BUCKETS.map(([k, label]) => ({ label, amount: round(rows.reduce((s, x) => s + num(x[k]), 0)) }));
  const parties = new Map<string, { outstanding: number; overdue: number; oldestDays: number }>();
  let overdue = 0;
  for (const x of rows) {
    const late = String(x.due_date ?? '') < today ? num(x.outstanding) : 0;
    overdue += late;
    const p = parties.get(String(x.party)) ?? { outstanding: 0, overdue: 0, oldestDays: 0 };
    p.outstanding += num(x.outstanding);
    p.overdue += late;
    p.oldestDays = Math.max(p.oldestDays, num(x.age));
    parties.set(String(x.party), p);
  }
  return {
    total: round(rows.reduce((s, x) => s + num(x.outstanding), 0)),
    overdue: round(overdue),
    buckets,
    parties: [...parties.entries()].map(([party, v]) => ({ party, outstanding: round(v.outstanding), overdue: round(v.overdue), oldestDays: v.oldestDays })).sort((a, b) => b.outstanding - a.outstanding).slice(0, 10),
  };
}

const pct = (a: number, b: number) => (b === 0 ? null : ((a - b) / Math.abs(b)) * 100);

export function buildAnalytics(raw: RawAnalytics, currency: Currency, current: Period, previous: Period): Analytics {
  const cur = byRoot(raw.current, raw.types);
  const prev = byRoot(raw.previous, raw.types);
  const fmt = (v: number) => formatMoney(v, currency);

  const monthsMap = new Map<string, { income: number; expenses: number }>();
  for (const r of raw.months) {
    const t = raw.types.get(r.account);
    const m = monthsMap.get(r.month) ?? { income: 0, expenses: 0 };
    if (t?.rootType === 'Income') m.income += num(r.credit) - num(r.debit);
    if (t?.rootType === 'Expense') m.expenses += num(r.debit) - num(r.credit);
    monthsMap.set(r.month, m);
  }
  const trend = [...monthsMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, income: round(v.income), expenses: round(v.expenses), profit: round(v.income - v.expenses) }));

  const breakdown = (now: Map<string, number>, before: Map<string, number>) =>
    [...new Set([...now.keys(), ...before.keys()])]
      .map((account) => ({ account: short(account), ledger: account, amount: round(now.get(account) ?? 0), prev: round(before.get(account) ?? 0) }))
      .filter((x) => x.amount !== 0 || x.prev !== 0)
      .sort((a, b) => b.amount - a.amount);

  const balances = raw.balances
    ? (() => {
        const accounts = raw.balances.map((b) => ({ account: short(b.account), ledger: b.account, type: raw.types.get(b.account)?.accountType ?? 'Bank', balance: round(num(b.debit) - num(b.credit)) }));
        return { cash: round(accounts.filter((a) => a.type === 'Cash').reduce((s, a) => s + a.balance, 0)), bank: round(accounts.filter((a) => a.type === 'Bank').reduce((s, a) => s + a.balance, 0)), accounts: accounts.sort((a, b) => b.balance - a.balance) };
      })()
    : null;

  const profit = cur.incomeTotal - cur.expenseTotal;
  const prevProfit = prev.incomeTotal - prev.expenseTotal;
  const receivables = ageing(raw.receivables, current.to);
  const payables = ageing(raw.payables, current.to);
  const expenseByAccount = breakdown(cur.expense, prev.expense);
  const topCustomers = raw.customers.map((x) => ({ party: x.party, amount: round(num(x.total)), count: num(x.n) }));

  // ---- plain-language insights, most useful first ----
  const insights: Analytics['insights'] = [];
  if (cur.incomeTotal || cur.expenseTotal) {
    const what = (v: number) => `${v >= 0 ? 'a profit' : 'a loss'} of ${fmt(Math.abs(v))}`;
    const sameSign = (profit >= 0) === (prevProfit >= 0) && prevProfit !== 0;
    const pp = sameSign ? pct(Math.abs(profit), Math.abs(prevProfit)) : null;
    const compare = prevProfit === 0 && !prev.incomeTotal && !prev.expenseTotal
      ? ''
      : sameSign && pp !== null
        ? ` (${profit >= 0 ? (pp >= 0 ? 'up' : 'down') : pp >= 0 ? 'bigger' : 'smaller'} ${Math.abs(pp).toFixed(0)}% vs ${previous.label.toLowerCase()})`
        : ` (${previous.label.toLowerCase()}: ${what(prevProfit)})`;
    insights.push({ tone: profit >= 0 ? 'good' : 'warn', text: `${current.label}: ${what(profit)}${compare}.` });
  }
  const ep = pct(cur.expenseTotal, prev.expenseTotal);
  if (ep !== null && Math.abs(ep) >= 10) {
    const mover = expenseByAccount.map((x) => ({ ...x, delta: x.amount - x.prev })).sort((a, b) => (ep > 0 ? b.delta - a.delta : a.delta - b.delta))[0];
    insights.push({
      tone: ep > 0 ? 'warn' : 'good',
      text: `Expenses ${ep > 0 ? 'up' : 'down'} ${Math.abs(ep).toFixed(0)}% vs ${previous.label.toLowerCase()} (${fmt(cur.expenseTotal)})${mover && mover.delta !== 0 ? `, mostly ${mover.account} (${mover.delta > 0 ? '+' : '−'}${fmt(Math.abs(mover.delta))})` : ''}${current.key === 'this_month' ? '. Part-month figures move with payment dates such as salary day' : ''}.`,
    });
  }
  const top = expenseByAccount[0];
  if (top && cur.expenseTotal > 0 && top.amount / cur.expenseTotal >= 0.3) {
    insights.push({ tone: 'info', text: `${top.account} is ${((top.amount / cur.expenseTotal) * 100).toFixed(0)}% of your expenses (${fmt(top.amount)}).` });
  }
  const late = receivables.buckets.slice(2).reduce((s, b) => s + b.amount, 0);
  if (late > 0) {
    const who = receivables.parties.filter((p) => p.oldestDays > 60).map((p) => p.party);
    insights.push({ tone: 'warn', text: `${fmt(late)} has been owed for more than 60 days${who.length ? ` (${who.slice(0, 3).join(', ')}${who.length > 3 ? ' and others' : ''})` : ''}. Reply "remind <customer>" on WhatsApp to chase it.` });
  } else if (receivables.overdue > 0) {
    insights.push({ tone: 'info', text: `${fmt(receivables.overdue)} from customers is past its due date.` });
  }
  const totalSales = topCustomers.reduce((s, x) => s + x.amount, 0);
  if (topCustomers[0] && totalSales > 0 && topCustomers.length > 1 && topCustomers[0].amount / totalSales >= 0.5) {
    insights.push({ tone: 'info', text: `${topCustomers[0].party} brings ${((topCustomers[0].amount / totalSales) * 100).toFixed(0)}% of your sales: a big dependency on one customer.` });
  }
  const fullMonths = trend.filter((t) => t.month < current.to.slice(0, 7)).slice(-3);
  const burn = fullMonths.length ? fullMonths.reduce((s, t) => s + t.expenses, 0) / fullMonths.length : 0;
  if (balances && burn > 0) {
    const months = (balances.cash + balances.bank) / burn;
    insights.push({
      tone: months < 3 ? 'warn' : 'good',
      text: `Cash and bank (${fmt(balances.cash + balances.bank)}) cover about ${months.toFixed(1)} months of expenses at the recent pace (${fmt(burn)}/month).`,
    });
  }
  if (payables.overdue > 0) insights.push({ tone: 'warn', text: `${fmt(payables.overdue)} to suppliers is past its due date.` });

  return {
    currency,
    period: current,
    previous,
    kpis: {
      income: round(cur.incomeTotal),
      expenses: round(cur.expenseTotal),
      profit: round(profit),
      margin: cur.incomeTotal > 0 ? round((profit / cur.incomeTotal) * 100) : null,
      taxPayable: round(Math.max(0, cur.tax)),
      prev: { income: round(prev.incomeTotal), expenses: round(prev.expenseTotal), profit: round(prevProfit) },
    },
    balances,
    trend,
    expenseByAccount: expenseByAccount.slice(0, 10),
    incomeByAccount: breakdown(cur.income, prev.income).slice(0, 10),
    topCustomers,
    topSuppliers: raw.suppliers.map((x) => ({ party: x.party, amount: round(num(x.total)), count: num(x.n) })),
    receivables,
    payables,
    insights,
    errors: raw.errors,
  };
}

/** Drill-down: the ledger lines behind a number (an account, or a customer/supplier) in a period. */
export async function ledgerEntries(c: Container, tenant: Tenant, q: { account?: string; party?: string; from: string; to: string }) {
  const ctx = erpContext(tenant);
  const filters: Array<[string, string, unknown]> = [['company', '=', ctx.company], ['is_cancelled', '=', 0], ['posting_date', 'between', [q.from, q.to]]];
  if (q.account) filters.push(['account', '=', q.account]); // full ledger name, e.g. "Office Rent - ATL"
  if (q.party) filters.push(['party', '=', q.party]);
  const rows = await c.erp(tenant).list<{ posting_date: string; account: string; voucher_type: string; voucher_no: string; party?: string; debit: number; credit: number; remarks?: string }>('GL Entry', {
    filters,
    fields: ['posting_date', 'account', 'voucher_type', 'voucher_no', 'party', 'debit', 'credit', 'remarks'],
    orderBy: 'posting_date desc, creation desc',
    limit: 200,
  });
  return rows.map((r) => ({ ...r, account: short(r.account), amount: round(num(r.debit) - num(r.credit)), remarks: r.remarks && r.remarks !== 'No Remarks' ? r.remarks.replace(/^Note:\s*/i, '').slice(0, 140) : undefined }));
}

/** Income and expenses for one day (Home tiles), from the ledger. */
export async function dayTotals(c: Container, tenant: Tenant, day: string): Promise<{ income: number; expenses: number }> {
  const ctx = erpContext(tenant);
  const erp = c.erp(tenant);
  const [types, rows] = await Promise.all([
    chartTypes(erp, ctx, tenant.id),
    erp.list<GlSum>('GL Entry', {
      filters: [['company', '=', ctx.company], ['is_cancelled', '=', 0], ['posting_date', '=', day]],
      fields: ['account', 'sum(debit) as debit', 'sum(credit) as credit'],
      groupBy: 'account',
      limit: 2000,
    }),
  ]);
  const r = byRoot(rows, types);
  return { income: round(r.incomeTotal), expenses: round(r.expenseTotal) };
}
