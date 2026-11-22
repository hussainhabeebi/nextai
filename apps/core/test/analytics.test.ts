import { describe, expect, it } from 'vitest';
import { buildAnalytics, periodsFor, type RawAnalytics } from '../src/modules/reports/analytics.js';

const types = new Map([
  ['Sales - ATL', { rootType: 'Income' }],
  ['Salary - ATL', { rootType: 'Expense' }],
  ['Office Rent - ATL', { rootType: 'Expense' }],
  ['Cash - ATL', { rootType: 'Asset', accountType: 'Cash' }],
  ['HDFC - ATL', { rootType: 'Asset', accountType: 'Bank' }],
  ['Output Tax - ATL', { rootType: 'Liability', accountType: 'Tax' }],
]);
const gl = (account: string, debit: number, credit: number) => ({ account, debit, credit });
const raw = (over: Partial<RawAnalytics> = {}): RawAnalytics => ({
  types,
  current: [gl('Sales - ATL', 0, 100000), gl('Salary - ATL', 60000, 0), gl('Office Rent - ATL', 25000, 0), gl('Output Tax - ATL', 0, 18000)],
  previous: [gl('Sales - ATL', 0, 80000), gl('Salary - ATL', 30000, 0), gl('Office Rent - ATL', 25000, 0)],
  months: [
    { month: '2026-09', ...gl('Sales - ATL', 0, 90000) }, { month: '2026-09', ...gl('Salary - ATL', 60000, 0) },
    { month: '2026-10', ...gl('Sales - ATL', 0, 80000) }, { month: '2026-10', ...gl('Salary - ATL', 60000, 0) },
    { month: '2026-11', ...gl('Sales - ATL', 0, 100000) }, { month: '2026-11', ...gl('Salary - ATL', 85000, 0) },
  ],
  balances: [gl('Cash - ATL', 30000, 10000), gl('HDFC - ATL', 200000, 50000)],
  customers: [{ party: 'Ravi Traders', total: 70000, n: 2 }, { party: 'Gulf Mart', total: 30000, n: 1 }],
  suppliers: [],
  receivables: { columns: [], result: [
    { party: 'Kochi Exports', outstanding: 45000, range1: 0, range2: 0, range3: 45000, range4: 0, range5: 0, due_date: '2026-08-20', age: 75 },
    { party: 'Ravi Traders', outstanding: 20000, range1: 20000, range2: 0, range3: 0, range4: 0, range5: 0, due_date: '2026-12-01', age: 0 },
  ] },
  payables: null,
  errors: [],
  ...over,
});

describe('periods', () => {
  it('month to date is compared with the same days of the previous month', () => {
    const { current, previous } = periodsFor('this_month', 'IN', new Date('2026-11-17T10:00:00Z'));
    expect(current).toMatchObject({ from: '2026-11-01', to: '2026-11-17' });
    expect(previous).toMatchObject({ from: '2026-10-01', to: '2026-10-17' });
    expect(periodsFor('this_month', 'IN', new Date('2026-03-31T10:00:00Z')).previous.to).toBe('2026-02-28'); // clamps to short month
  });
  it('financial year: 1 April in India, 1 January in the UAE', () => {
    expect(periodsFor('fiscal_year', 'IN', new Date('2026-11-17T10:00:00Z')).current.from).toBe('2026-04-01');
    expect(periodsFor('fiscal_year', 'AE', new Date('2026-11-17T10:00:00Z')).current.from).toBe('2026-01-01');
    expect(periodsFor('last_month', 'IN', new Date('2026-01-10T10:00:00Z')).current).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
  });
});

describe('buildAnalytics', () => {
  const { current, previous } = periodsFor('this_month', 'IN', new Date('2026-11-17T10:00:00Z'));
  const a = buildAnalytics(raw(), 'INR', current, previous);
  it('KPIs from the ledger: income − expenses, margin, tax payable, previous period', () => {
    expect(a.kpis).toMatchObject({ income: 100000, expenses: 85000, profit: 15000, margin: 15, taxPayable: 18000, prev: { income: 80000, expenses: 55000, profit: 25000 } });
  });
  it('balances, trend and breakdowns', () => {
    expect(a.balances).toMatchObject({ cash: 20000, bank: 150000 });
    expect(a.trend.map((t) => t.profit)).toEqual([30000, 20000, 15000]);
    expect(a.expenseByAccount[0]).toMatchObject({ account: 'Salary', ledger: 'Salary - ATL', amount: 60000, prev: 30000 });
  });
  it('ageing: buckets, overdue and the oldest debts', () => {
    expect(a.receivables).toMatchObject({ total: 65000, overdue: 45000 });
    expect(a.receivables.buckets[2]).toEqual({ label: '61–90 days', amount: 45000 });
    expect(a.receivables.parties[0]).toMatchObject({ party: 'Kochi Exports', oldestDays: 75 });
  });
  it('plain-language insights', () => {
    const text = a.insights.map((i) => i.text).join('\n');
    expect(text).toMatch(/This month: a profit of ₹15,000\.00 \(down 40% vs same days last month\)/);
    expect(text).toMatch(/Expenses up 55% .*mostly Salary \(\+₹30,000\.00\)/);
    expect(text).toMatch(/₹45,000\.00 has been owed for more than 60 days \(Kochi Exports\)/);
    expect(text).toMatch(/Ravi Traders brings 70% of your sales/);
    expect(text).toMatch(/cover about 2\.8 months of expenses/); // 170000 / avg(60000, 60000) of the full months
  });
  it('a loss after a profit is described in words, not as a percentage', () => {
    const b = buildAnalytics(raw({ current: [gl('Sales - ATL', 0, 10000), gl('Salary - ATL', 16000, 0)] }), 'INR', current, previous);
    expect(b.insights[0]!.text).toBe('This month: a loss of ₹6,000.00 (same days last month: a profit of ₹25,000.00).');
  });
  it('reports what could not be read instead of zeros', () => {
    const b = buildAnalytics(raw({ balances: null, errors: ['cash & bank balances: Not permitted'] }), 'INR', current, previous);
    expect(b.balances).toBeNull();
    expect(b.errors).toEqual(['cash & bank balances: Not permitted']);
  });
});
