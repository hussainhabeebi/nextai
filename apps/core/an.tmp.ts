import { createErpClient } from '@nextai/erpnext-client';
import { buildAnalytics, fetchAnalytics, ledgerEntries, periodsFor } from './src/modules/reports/analytics.js';
const erp = createErpClient({ baseUrl: 'http://erp.local:18000', apiKey: process.env.ERP_KEY!, apiSecret: process.env.ERP_SECRET! });
const c = { erp: () => erp } as never;
const t = { id: 'live-1', name: 'Aiingo Technologies India LLP', country: 'IN', currency: 'INR', settings: { erpCompany: 'Aiingo Technologies India LLP', companyAbbr: 'ATL' } } as never;
for (const k of ['this_month', 'last_month'] as const) {
  const { current, previous } = periodsFor(k, 'IN', new Date('2026-11-17T12:00:00Z'));
  const a = buildAnalytics(await fetchAnalytics(c, t, current, previous), 'INR', current, previous);
  console.log(`== ${k}`, current.from, current.to, 'vs', previous.from, previous.to);
  console.log('kpis', JSON.stringify(a.kpis)); console.log('balances', JSON.stringify(a.balances));
  console.log('trend', JSON.stringify(a.trend));
  console.log('expenses', JSON.stringify(a.expenseByAccount.map((x) => [x.account, x.amount, x.prev])));
  console.log('customers', JSON.stringify(a.topCustomers), 'suppliers', JSON.stringify(a.topSuppliers));
  console.log('AR', JSON.stringify({ total: a.receivables.total, overdue: a.receivables.overdue, buckets: a.receivables.buckets, parties: a.receivables.parties }));
  console.log('AP', a.payables.total, a.payables.overdue);
  for (const i of a.insights) console.log(`  [${i.tone}] ${i.text}`);
  console.log('errors', a.errors);
}
console.log((await ledgerEntries(c, t, { account: 'Office Rent - ATL', from: '2026-06-01', to: '2026-11-17' })).slice(0, 2));
