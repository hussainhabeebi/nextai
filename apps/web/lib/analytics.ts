/** Shape of GET /v1/analytics (ERPNext ledger based, includes entries made directly in ERPNext). */
export type PeriodKey = 'this_month' | 'last_month' | 'this_quarter' | 'fiscal_year';
export interface Period { key: string; label: string; from: string; to: string }
export interface Ageing {
  total: number;
  overdue: number;
  buckets: Array<{ label: string; amount: number }>;
  parties: Array<{ party: string; outstanding: number; overdue: number; oldestDays: number }>;
}
export interface Analytics {
  currency: string;
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

export const PERIOD_LABELS: Array<[PeriodKey, string]> = [
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
  ['this_quarter', 'Quarter'],
  ['fiscal_year', 'Financial year'],
];

/** % change, or null when there is no base to compare with. */
export const change = (now: number, before: number) => (before === 0 ? null : ((now - before) / Math.abs(before)) * 100);

/** Link to the ledger lines behind a number. */
export const entriesHref = (q: { account?: string; party?: string; from: string; to: string; title: string; cur?: string }) =>
  `/insights/entries?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as Array<[string, string]>).toString()}`;

export const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
