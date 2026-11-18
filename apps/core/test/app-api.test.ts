import { clearAccountCache } from '../src/modules/erpnext/mappers.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { tenantDb, withSystemTx } from '../src/lib/db.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { closeShared, createTenant, drain, extractionBytes, testContainer } from './helpers.js';

const c = testContainer();
let app: FastifyInstance;
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
let tokA: string;
let tokB: string;
let staffA: string;

beforeAll(async () => {
  await seed(c.prisma);
  A = await createTenant(c.prisma, { settings: { companyAbbr: 'AIL' } });
  // Like a real site with India Compliance: the GST purchase template exists.
  await (c.erp(A.tenant) as unknown as { create: (d: string, x: Record<string, unknown>) => Promise<unknown> }).create(
    'Purchase Taxes and Charges Template',
    { name: 'Input GST In-state - AIL', taxes: [{ charge_type: 'On Net Total', account_head: 'Input Tax CGST - AIL', rate: 9, add_deduct_tax: 'Add', category: 'Total' }] },
  );
  B = await createTenant(c.prisma);
  app = await buildApp(c);
  tokA = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'owner', typ: 'app' });
  tokB = await signAccess({ sub: B.owner.id, tid: B.tenant.id, role: 'owner', typ: 'app' });
  staffA = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'staff', typ: 'app' });
});
afterAll(async () => {
  await app.close();
  await closeShared();
});
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

function multipart(filename: string, mime: string, content: Uint8Array) {
  const boundary = '----nx' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('customer app API', () => {
  it('capture → OCR draft visible in approvals → confirm → posted', async () => {
    const mp = multipart('bill.jpg', 'image/jpeg', extractionBytes({ invoiceNo: 'APP-1' }));
    const cap = await app.inject({ method: 'POST', url: '/v1/capture', payload: mp.body, headers: { ...mp.headers, ...auth(tokA) } });
    expect(cap.statusCode).toBe(202);
    await drain(c);
    const list = await app.inject({ method: 'GET', url: '/v1/drafts', headers: auth(tokA) });
    const draft = list.json().items[0];
    expect(draft.status).toBe('pending');
    const detail = await app.inject({ method: 'GET', url: `/v1/drafts/${draft.id}`, headers: auth(tokA) });
    expect(detail.json().documentUrl).toMatch(new RegExp(`tenants/${A.tenant.id}/`));
    const patch = await app.inject({ method: 'PATCH', url: `/v1/drafts/${draft.id}`, headers: auth(tokA), payload: { expenseAccount: 'Office Maintenance Expenses - AIL' } });
    expect(patch.statusCode).toBe(200);
    const conf = await app.inject({ method: 'POST', url: `/v1/drafts/${draft.id}/confirm`, headers: auth(tokA) });
    expect(conf.json().status).toBe('confirmed');
    await drain(c);
    expect((await tenantDb(c.prisma, A.tenant.id).draft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('posted');
  });

  it('tenant B cannot read, edit or confirm tenant A drafts by id', async () => {
    const d = await tenantDb(c.prisma, A.tenant.id).draft.create({ data: { tenantId: A.tenant.id, type: 'journal_entry', payload: { date: '2026-11-01', currency: 'INR', total: 10, lines: [], validationIssues: [] } } });
    expect((await app.inject({ method: 'GET', url: `/v1/drafts/${d.id}`, headers: auth(tokB) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/v1/drafts/${d.id}`, headers: auth(tokB), payload: { total: 99 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/drafts/${d.id}/confirm`, headers: auth(tokB) })).statusCode).toBe(404);
    const listB = await app.inject({ method: 'GET', url: '/v1/drafts', headers: auth(tokB) });
    expect(listB.json().items.map((x: { id: string }) => x.id)).not.toContain(d.id);
  });

  it('dashboard figures come from the ERPNext ledger (incl. entries made in ERPNext); settings require owner', async () => {
    const erp = c.erp(A.tenant) as unknown as { create: (d: string, x: Record<string, unknown>) => Promise<unknown> };
    const company = `Co ${A.tenant.slug}`;
    const acc = (name: string, root_type: string, account_type = '') => erp.create('Account', { name, company, is_group: 0, root_type, account_type });
    await acc('Cash - AIL', 'Asset', 'Cash');
    await acc('HDFC - AIL', 'Asset', 'Bank');
    await acc('Sales - AIL', 'Income');
    await acc('Office Rent - AIL', 'Expense');
    const today = new Date().toISOString().slice(0, 10);
    let n = 0;
    const gl = (account: string, debit: number, credit: number, posting_date = today) =>
      erp.create('GL Entry', { name: `GL-${++n}`, company, is_cancelled: 0, account, debit, credit, posting_date });
    await gl('HDFC - AIL', 500000, 0, '2026-01-01'); // opening, entered directly in ERPNext
    await gl('Cash - AIL', 25000, 0, '2026-01-01');
    await gl('HDFC - AIL', 10000, 0); // sale received today
    await gl('Sales - AIL', 0, 10000);
    await gl('Office Rent - AIL', 4000, 0); // rent paid today
    await gl('HDFC - AIL', 0, 4000);
    clearAccountCache(A.tenant.id); // the chart was cached (empty) by earlier postings in this file
    const dash = await app.inject({ method: 'GET', url: '/v1/dashboard', headers: auth(tokA) });
    expect(dash.json()).toMatchObject({ currency: 'INR', cash: 25000, bank: 506000, todaySales: 10000, todayExpenses: 4000, salesMtd: 10000, expensesMtd: 4000, profitMtd: 6000 });

    const an = await app.inject({ method: 'GET', url: '/v1/analytics?period=this_month', headers: auth(tokA) });
    expect(an.statusCode).toBe(200);
    expect(an.json().expenseByAccount[0]).toMatchObject({ account: 'Office Rent', ledger: 'Office Rent - AIL', amount: 4000 });
    // every figure read without errors (the fake rejects "sum(debit)"-style fields, as current Frappe does)
    expect(an.json().errors).toEqual([]);
    expect(an.json().balances).toMatchObject({ cash: 25000, bank: 506000 });
    expect(an.json().trend.at(-1)).toMatchObject({ month: today.slice(0, 7), income: 10000, expenses: 4000 });
    const lines = await app.inject({ method: 'GET', url: `/v1/analytics/entries?account=${encodeURIComponent('Office Rent - AIL')}&from=2026-01-01&to=${today}`, headers: auth(tokA) });
    expect(lines.json().items).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/v1/analytics/entries?from=2026-01-01&to=${today}`, headers: auth(tokA) })).statusCode).toBe(400);
    const denied = await app.inject({ method: 'PATCH', url: '/v1/settings', headers: auth(staffA), payload: { settings: { autoPost: true } } });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({ method: 'PATCH', url: '/v1/settings', headers: auth(tokA), payload: { settings: { autoPost: true } } });
    expect(ok.json().settings.autoPost).toBe(true);
    const logs = await withSystemTx(c.prisma, (tx) => tx.auditLog.findMany({ where: { tenantId: A.tenant.id, action: 'settings.update' } }));
    expect(logs).toHaveLength(1);
  });

  it('creates and posts an invoice from the app, enforces plan user limits', async () => {
    const inv = await app.inject({ method: 'POST', url: '/v1/invoices', headers: auth(tokA), payload: { customer: 'Acme', customerPhone: '9847000000', lines: [{ description: 'Design', qty: 2, rate: 1500 }] } });
    expect(inv.statusCode).toBe(201);
    expect(inv.json().status).toBe('confirmed');
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: 'POST', url: '/v1/team', headers: auth(tokA), payload: { name: `S${i}`, phone: `98470000${10 + i}`, role: 'staff' } });
      expect(r.statusCode).toBe(201);
    }
    const over = await app.inject({ method: 'POST', url: '/v1/team', headers: auth(tokA), payload: { name: 'S9', phone: '9847000099', role: 'staff' } });
    expect(over.statusCode).toBe(402); // growth plan: 4 users
  });

  it('records purchases, expenses, bank entries and builds the daily report', async () => {
    const date = '2026-10-15';
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: auth(tokA), payload: payload as object });
    const pur = await post('/v1/purchases', { supplier: 'Paper Co', billNo: 'PC-9', date, paymentMode: 'cash', lines: [{ description: 'printer paper', qty: 2, rate: 250 }] });
    expect(pur.statusCode).toBe(201);
    expect(pur.json().payload.lines[0].account).toBe('Print and Stationery - AIL');
    const exp = await post('/v1/expenses', { description: 'taxi to client', amount: 300, date });
    expect(exp.statusCode).toBe(201);
    expect(exp.json().payload.expenseAccount).toBe('Travel Expenses - AIL');
    const rent = await post('/v1/expenses', { description: 'October', amount: 9000, category: 'rent', paymentMode: 'bank', date });
    expect(rent.json().payload.expenseAccount).toBe('Rent - AIL');
    const dep = await post('/v1/bank-entries', { kind: 'deposit', amount: 2000, date });
    expect(dep.statusCode).toBe(201);
    expect(dep.json().payload).toMatchObject({ expenseAccount: 'Bank Account - AIL', paidFromAccount: 'Cash - AIL' });
    await post('/v1/payments', { direction: 'in', party: 'Acme', amount: 1200, mode: 'upi', date });
    await drain(c);

    const r = await app.inject({ method: 'GET', url: `/v1/daily-report?date=${date}`, headers: auth(tokA) });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.entries.map((e: { kind: string }) => e.kind)).toEqual(['purchase', 'expense', 'expense', 'bank', 'receipt']);
    expect(body.totals).toMatchObject({ purchases: 500, expenses: 9300, bank: 2000, receipts: 1200, cashIn: 1200, cashOut: 9800 });
    expect(body.netCashFlow).toBe(-8600);
    const other = await app.inject({ method: 'GET', url: `/v1/daily-report?date=${date}`, headers: auth(tokB) });
    expect(other.json().entries).toHaveLength(0);
  });

  it('clinic & pharmacy views: settings, /me, quick sales paid at the counter, stock purchase', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(tokA) })).json().tenant).toMatchObject({ appView: 'general', appStyle: 'teal' });
    const bad = await app.inject({ method: 'PATCH', url: '/v1/settings', headers: auth(tokA), payload: { settings: { appView: 'hospital' } } });
    expect(bad.statusCode).toBe(400);
    await app.inject({ method: 'PATCH', url: '/v1/settings', headers: auth(tokA), payload: { settings: { appView: 'clinic', appStyle: 'blue' } } });
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(tokA) })).json().tenant).toMatchObject({ appView: 'clinic', appStyle: 'blue' });

    const date = '2026-10-20';
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: auth(tokA), payload: payload as object });
    const bill = await post('/v1/quick-sales', { kind: 'patient_bill', party: 'Ravi', doctor: 'Dr. Meera', date, discount: 50, paymentMode: 'upi', lines: [{ description: 'Consultation', qty: 1, rate: 300 }, { description: 'Dressing', qty: 1, rate: 200 }] });
    expect(bill.statusCode).toBe(201);
    expect(bill.json().total).toBe(450);
    expect(bill.json().invoice.payload.remarks).toBe('Patient bill · Dr Meera · Discount 50');
    expect(bill.json().payment.payload).toMatchObject({ partyName: 'Ravi', total: 450, paymentMode: 'upi' });

    const sale = await post('/v1/quick-sales', { kind: 'counter_sale', date, paymentMode: 'credit', lines: [{ description: 'Paracetamol 500', qty: 2, rate: 20, discountPct: 10, batch: 'B12', expiry: '2027-03' }] });
    expect(sale.json()).toMatchObject({ total: 36, payment: null });
    expect(sale.json().invoice.payload).toMatchObject({ partyName: 'Walk-in Customer' });
    expect(sale.json().invoice.payload.lines[0]).toMatchObject({ description: 'Paracetamol 500 · Batch B12 · Exp 03/27 · MRP 20', rate: 18, amount: 36 });

    const stock = await post('/v1/purchases', { supplier: 'Medi Distributors', date, itemsAccount: 'stock', lines: [{ description: 'Paracetamol 500 strip', qty: 10, rate: 12 }] });
    expect(stock.json().payload.lines[0].account).toBe('Cost of Goods Sold - AIL');
    const fee = await post('/v1/expenses', { description: 'Doctor fee — Dr Meera', amount: 1000, category: 'doctor_fees', date });
    expect(fee.json().payload.expenseAccount).toBe('Salary - AIL');
    await drain(c);

    const r = (await app.inject({ method: 'GET', url: `/v1/daily-report?date=${date}`, headers: auth(tokA) })).json();
    expect(r.totals).toMatchObject({ sales: 486, receipts: 450, cashIn: 450, purchases: 120, expenses: 1000 });
    await app.inject({ method: 'PATCH', url: '/v1/settings', headers: auth(tokA), payload: { settings: { appView: 'general', appStyle: 'teal' } } });
  });

  it('suspended tenants are read-only', async () => {
    await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: B.tenant.id }, data: { status: 'suspended' } }));
    expect((await app.inject({ method: 'GET', url: '/v1/drafts', headers: auth(tokB) })).statusCode).toBe(200);
    const w = await app.inject({ method: 'POST', url: '/v1/payments', headers: auth(tokB), payload: { direction: 'in', party: 'X', amount: 5 } });
    expect(w.statusCode).toBe(402);
  });
});
