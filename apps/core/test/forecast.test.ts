import type { FakeErpClient } from '@nextai/erpnext-client/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { addDays, isoDay } from '../src/modules/erpnext/fetch.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { collectionProbability, forecast, learnBehaviour, seasonality, type ForecastInputs } from '../src/modules/forecast/engine.js';
import { ruleClassify } from '../src/ai/rules.js';
import { closeShared, createTenant, testContainer } from './helpers.js';

const today = '2026-11-23';
const base = (over: Partial<ForecastInputs> = {}): ForecastInputs => ({
  today,
  currency: 'INR',
  openingBalance: 100_000,
  receivables: [],
  payables: [],
  customers: {},
  supplierDelay: { avgDelay: 0, sdDelay: 2, samples: 0 },
  collectionCycleDays: 30,
  paymentCycleDays: 30,
  history: [],
  macro: { inflationPct: 0, demandGrowthPct: 0 },
  minCashBuffer: 0,
  seed: 7,
  ...over,
});

describe('forecast engine (pure)', () => {
  it('learns each customer’s delay by FIFO-matching payments to invoices', () => {
    const r = learnBehaviour(
      [
        { party: 'Slow Co', postingDate: '2026-01-01', dueDate: '2026-01-31', amount: 1000 },
        { party: 'Slow Co', postingDate: '2026-02-01', dueDate: '2026-03-03', amount: 1000 },
        { party: 'Fast Co', postingDate: '2026-01-01', dueDate: '2026-01-31', amount: 500 },
      ],
      [
        { party: 'Slow Co', date: '2026-03-02', amount: 1500 }, // covers inv 1 (30 days late)
        { party: 'Slow Co', date: '2026-04-02', amount: 500 }, // completes inv 2 (30 days late)
        { party: 'Fast Co', date: '2026-01-26', amount: 500 }, // 5 days early
      ],
    );
    expect(r.byParty['Slow Co']).toMatchObject({ avgDelay: 30, samples: 2 });
    expect(r.byParty['Fast Co']!.avgDelay).toBe(-5);
    expect(r.byParty['Slow Co']!.share).toBe(0.8);
  });

  it('schedules receivables at due date + learned delay and payables at due date', () => {
    const f = forecast(
      base({
        receivables: [{ doc: 'SINV-1', party: 'Slow Co', postingDate: '2026-11-01', dueDate: '2026-11-25', outstanding: 40_000 }],
        payables: [{ doc: 'PINV-1', party: 'Landlord', postingDate: '2026-11-01', dueDate: '2026-11-27', outstanding: 150_000 }],
        customers: { 'Slow Co': { avgDelay: 21, sdDelay: 3, samples: 4, share: 1 } },
      }),
    );
    expect(f.expectedCollections[0]).toMatchObject({ expectedDate: '2026-12-16', delayDays: 21 });
    expect(f.weeks[0]!.outflows.payables).toBe(150_000);
    expect(f.weeks[0]!.closing).toBe(-50_000);
    expect(f.cashOutWeek).toBe(today);
    expect(f.weeks[3]!.inflows.receivables).toBeCloseTo(40_000 * 0.97, 0);
    expect(f.shortfallProbability).toBeGreaterThan(0.9);
  });

  it('weights old receivables by collection probability', () => {
    expect(collectionProbability(10)).toBe(0.97);
    expect(collectionProbability(400)).toBe(0.15);
  });

  it('uses seasonality only with a full year of history', () => {
    const months = Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(i + 1).padStart(2, '0')}`, inInvoiced: i === 11 ? 300 : 100, inDirect: 0, outInvoiced: 0, outDirect: 0 }));
    expect(seasonality(months.slice(0, 6), (m) => m.inInvoiced)).toEqual(Array(12).fill(1));
    const s = seasonality(months, (m) => m.inInvoiced);
    expect(s[11]).toBeGreaterThan(s[0]!);
  });

  it('what-if: a defaulting customer and a loan move the projection, deterministically', () => {
    const inputs = base({
      receivables: [{ doc: 'SINV-9', party: 'Risky Ltd', postingDate: '2026-11-01', dueDate: '2026-11-28', outstanding: 80_000 }],
      customers: { 'Risky Ltd': { avgDelay: 0, sdDelay: 2, samples: 3, share: 0.5 } },
      history: Array.from({ length: 6 }, (_, i) => ({ month: `2026-0${i + 4}`, inInvoiced: 52_000, inDirect: 0, outInvoiced: 26_000, outDirect: 26_000 })),
    });
    const b = forecast(inputs);
    expect(forecast(inputs).weeks.map((w) => w.p10)).toEqual(b.weeks.map((w) => w.p10)); // seeded
    const s = forecast(inputs, { collectionDelayDays: 0, payablesDelayDays: 0, salesChangePct: 0, expenseChangePct: 0, defaultingCustomers: ['risky ltd'], oneOffs: [{ date: '2026-12-01', amount: 50_000, label: 'Bank loan' }], monthlyRecurring: [{ amount: -15_000, label: 'New hire' }] });
    expect(s.expectedCollections).toHaveLength(0);
    expect(s.weeks[1]!.inflows.oneOff).toBe(50_000);
    expect(s.totals.closing).toBeLessThan(b.totals.closing);
    // run-rate inflows lose the defaulting customer's historical share
    expect(s.drivers.weeklyRunRate.inflow).toBe(b.drivers.weeklyRunRate.inflow);
    expect(s.weeks[12]!.inflows.runRate).toBeLessThan(b.weeks[12]!.inflows.runRate);
  });

  it('routes "cash forecast" on WhatsApp without hijacking expenses', () => {
    expect(ruleClassify('cash forecast')?.entities.report).toBe('cash_forecast');
    expect(ruleClassify('will we run out of cash?')?.entities.report).toBe('cash_forecast');
    expect(ruleClassify('paid 500 for forecast software')?.intent).toBe('record_expense');
  });
});

describe('forecast API', () => {
  const c = testContainer();
  let app: FastifyInstance;
  let A: Awaited<ReturnType<typeof createTenant>>;
  let tok: string;
  const auth = () => ({ authorization: `Bearer ${tok}` });

  beforeAll(async () => {
    await seed(c.prisma);
    A = await createTenant(c.prisma); // Growth includes cash_forecast
    app = await buildApp(c);
    tok = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'owner', typ: 'app' });
    const erp = c.erp(A.tenant) as FakeErpClient;
    erp.balances = { cash: 10_000, bank: 40_000, accounts: [] };
    const company = `Co ${A.tenant.slug}`;
    const put = (doctype: string, doc: Record<string, unknown>) => {
      if (!erp.docs.has(doctype)) erp.docs.set(doctype, new Map());
      erp.docs.get(doctype)!.set(String(doc.name), { doctype, company, docstatus: 1, ...doc });
    };
    const now = isoDay(new Date());
    // history: Ravi pays ~20 days late
    for (let i = 1; i <= 4; i++) {
      const posting = addDays(now, -30 * i - 40);
      put('Sales Invoice', { name: `SINV-H${i}`, customer: 'Ravi Traders', posting_date: posting, due_date: addDays(posting, 15), grand_total: 20_000, outstanding_amount: 0 });
      put('Payment Entry', { name: `PE-H${i}`, payment_type: 'Receive', party_type: 'Customer', party: 'Ravi Traders', posting_date: addDays(posting, 35), received_amount: 20_000, paid_amount: 20_000 });
    }
    put('Sales Invoice', { name: 'SINV-OPEN', customer: 'Ravi Traders', posting_date: addDays(now, -5), due_date: addDays(now, 10), grand_total: 30_000, outstanding_amount: 30_000 });
    put('Purchase Invoice', { name: 'PINV-RENT', supplier: 'Landlord', posting_date: addDays(now, -2), due_date: addDays(now, 4), grand_total: 70_000, outstanding_amount: 70_000 });
  });
  afterAll(async () => {
    await app.close();
    await closeShared();
  });

  it('builds a 13-week forecast from the books with learned payer behaviour', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/forecast?refresh=true', headers: auth() });
    expect(r.statusCode).toBe(200);
    const f = r.json();
    expect(f.weeks).toHaveLength(13);
    expect(f.openingBalance).toBe(50_000);
    expect(f.latePayers[0]).toMatchObject({ party: 'Ravi Traders', avgDelayDays: 20 });
    expect(f.expectedCollections[0].delayDays).toBe(20);
    expect(f.cashOutWeek).not.toBeNull(); // rent due before Ravi pays
    const dash = (await app.inject({ method: 'GET', url: '/v1/dashboard', headers: auth() })).json();
    expect(dash.alerts.some((a: { kind: string }) => a.kind === 'cash')).toBe(true);
  });

  it('simulates what-ifs against the cached baseline', async () => {
    const calls = (c.erp(A.tenant) as FakeErpClient).calls.length;
    const r = await app.inject({ method: 'POST', url: '/v1/forecast/simulate', headers: auth(), payload: { name: 'Delay rent', payablesDelayDays: 30, oneOffs: [{ date: addDays(isoDay(new Date()), 1), amount: 25_000, label: 'Owner capital' }] } });
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s.delta.lowest).toBeGreaterThan(0);
    expect(s.scenario.scenario.name).toBe('Delay rent');
    expect((c.erp(A.tenant) as FakeErpClient).calls.length).toBe(calls); // no extra ERPNext reads
  });

  it('rejects invalid scenarios', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/forecast/simulate', headers: auth(), payload: { salesChangePct: 9999 } });
    expect(r.statusCode).toBe(400);
  });
});
