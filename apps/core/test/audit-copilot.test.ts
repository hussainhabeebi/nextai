import type { FakeErpClient } from '@nextai/erpnext-client/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { withSystemTx } from '../src/lib/db.js';
import { analyze, benford, invoiceSequenceGaps, resolvePolicy, type AuditTxn } from '../src/modules/audit-copilot/rules.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { closeShared, createTenant, drain, testContainer } from './helpers.js';

const policyIN = resolvePolicy({ outlierZ: 3.5, duplicateWindowDays: 3, flagWeekends: true, weeklyRun: true }, 'IN', 'INR');
const ctxIN = { country: 'IN' as const, currency: 'INR' as const, policy: policyIN };
const tx = (o: Partial<AuditTxn> & { name: string }): AuditTxn => ({ doctype: 'Purchase Invoice', date: '2026-10-07', amount: 1000, direction: 'out', ...o });

describe('audit rules (pure)', () => {
  it('flags duplicate supplier bills even with different formatting', () => {
    const { findings } = analyze([tx({ name: 'PI-1', party: 'Acme', billNo: 'INV-42' }), tx({ name: 'PI-2', party: 'Acme', billNo: 'inv 42', date: '2026-10-20' })], ctxIN);
    const f = findings.find((x) => x.rule === 'duplicate_bill');
    expect(f?.severity).toBe('critical');
    expect(f?.txns.map((t) => t.name)).toEqual(['PI-1', 'PI-2']);
  });

  it('applies Sec 40A(3) per payee per day and Sec 269ST on receipts', () => {
    const { findings } = analyze(
      [
        tx({ name: 'JE-1', doctype: 'Journal Entry', party: 'Ravi', amount: 6000, mode: 'cash' }),
        tx({ name: 'JE-2', doctype: 'Journal Entry', party: 'Ravi', amount: 6000, mode: 'cash' }),
        tx({ name: 'PE-9', doctype: 'Payment Entry', direction: 'in', party: 'Big Buyer', amount: 250_000, mode: 'cash' }),
      ],
      ctxIN,
    );
    expect(findings.find((f) => f.rule === 'cash_payment_limit')?.amount).toBe(12000);
    expect(findings.find((f) => f.rule === 'cash_receipt_limit')?.severity).toBe('critical');
  });

  it('detects split payments structured under the approval limit', () => {
    const { findings } = analyze(
      [60_000, 55_000].map((amount, i) => tx({ name: `PE-${i}`, doctype: 'Payment Entry', party: 'Vendor X', amount, mode: 'bank', partyType: 'Supplier' })),
      ctxIN,
    );
    expect(findings.some((f) => f.rule === 'split_transaction')).toBe(true);
  });

  it('flags input tax without a valid GSTIN', () => {
    const { findings } = analyze(
      [tx({ name: 'PI-5', party: 'No Gst Co', taxAmount: 900, amount: 5900 }), tx({ name: 'PI-6', party: 'Bad Gst Co', taxAmount: 90, taxId: '27AAPFU0939F1ZX' })],
      ctxIN,
    );
    expect(findings.find((f) => f.rule === 'missing_tax_id')?.severity).toBe('high');
    expect(findings.find((f) => f.rule === 'invalid_tax_id')).toBeDefined();
  });

  it('reports invoice number gaps but not cancelled numbers', () => {
    const sis = ['SINV-0001', 'SINV-0002', 'SINV-0004', 'SINV-0006'].map((name) => tx({ name, doctype: 'Sales Invoice', direction: 'in' }));
    sis.push(tx({ name: 'SINV-0003', doctype: 'Sales Invoice', direction: 'in', cancelled: true }));
    const [gap] = invoiceSequenceGaps(sis);
    expect(gap?.observed.missing).toEqual(['SINV-0005']);
  });

  it('runs Benford on large populations and flags manipulated digits', () => {
    const fake = Array.from({ length: 200 }, (_, i) => tx({ name: `X-${i}`, amount: 9000 + i }));
    const r = benford(fake);
    expect(r.stats.conformity).toBe('nonconformity');
    expect(r.finding?.observed.digit).toBe(9);
    // a genuinely Benford-distributed population passes
    const natural = Array.from({ length: 2000 }, (_, i) => tx({ name: `N-${i}`, amount: Math.round(10 ** (1 + ((i * 0.6180339887) % 1) * 4)) }));
    expect(benford(natural).stats.conformity).not.toBe('nonconformity');
  });

  it('finds robust outliers per party', () => {
    const txns = [1000, 1100, 950, 1050, 1020, 980, 9800].map((amount, i) => tx({ name: `PI-${i}`, party: 'Stationer', amount, billNo: `B${i}` }));
    const out = analyze(txns, ctxIN).findings.filter((f) => f.rule === 'amount_outlier');
    expect(out.map((f) => f.txns[0]!.name)).toEqual(['PI-6']);
  });
});

describe('audit copilot API', () => {
  const c = testContainer();
  let app: FastifyInstance;
  let A: Awaited<ReturnType<typeof createTenant>>;
  let B: Awaited<ReturnType<typeof createTenant>>;
  let tokA: string;
  let tokB: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    await seed(c.prisma);
    A = await createTenant(c.prisma);
    B = await createTenant(c.prisma); // stays on Growth → no audit copilot
    await withSystemTx(c.prisma, async (txc) => {
      const pro = await txc.plan.findUniqueOrThrow({ where: { code: 'pro' } });
      await txc.tenant.update({ where: { id: A.tenant.id }, data: { planId: pro.id } });
    });
    A.tenant = await withSystemTx(c.prisma, (txc) => txc.tenant.findUniqueOrThrow({ where: { id: A.tenant.id } }));
    app = await buildApp(c);
    tokA = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'owner', typ: 'app' });
    tokB = await signAccess({ sub: B.owner.id, tid: B.tenant.id, role: 'owner', typ: 'app' });

    const erp = c.erp(A.tenant) as FakeErpClient;
    const company = `Co ${A.tenant.slug}`;
    const put = (doctype: string, doc: Record<string, unknown>) => erp.docs.get(doctype)?.set(String(doc.name), { doctype, company, docstatus: 1, ...doc }) ?? erp.docs.set(doctype, new Map([[String(doc.name), { doctype, company, docstatus: 1, ...doc }]]));
    const d = new Date();
    const day = (n: number) => new Date(d.getTime() - n * 86_400_000).toISOString().slice(0, 10);
    put('Purchase Invoice', { name: 'PI-0001', supplier: 'Kerala Paper Mart', bill_no: 'KPM-77', posting_date: day(10), grand_total: 11800, total_taxes_and_charges: 1800, tax_id: '27AAPFU0939F1ZV' });
    put('Purchase Invoice', { name: 'PI-0002', supplier: 'Kerala Paper Mart', bill_no: 'KPM-77', posting_date: day(5), grand_total: 11800, total_taxes_and_charges: 1800, tax_id: '27AAPFU0939F1ZV' });
    put('Journal Entry', { name: 'JE-0001', voucher_type: 'Cash Entry', posting_date: day(3), total_debit: 15000 });
    put('Sales Invoice', { name: 'SINV-0001', customer: 'Ravi', posting_date: day(9), grand_total: 5000 });
    put('Sales Invoice', { name: 'SINV-0002', customer: 'Ravi', posting_date: day(8), grand_total: 5000 });
    put('Sales Invoice', { name: 'SINV-0004', customer: 'Ravi', posting_date: day(7), grand_total: 5000 });
  });
  afterAll(async () => {
    await app.close();
    await closeShared();
  });

  it('is gated to the Pro plan', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/audit/runs', headers: auth(tokB), payload: {} });
    expect(r.statusCode).toBe(402);
  });

  let runId: string;
  it('tests the full population and stores findings with evidence', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/audit/runs', headers: auth(tokA), payload: {} });
    expect(r.statusCode).toBe(202);
    runId = r.json().id;
    expect((await app.inject({ method: 'POST', url: '/v1/audit/runs', headers: auth(tokA), payload: {} })).statusCode).toBe(409); // one at a time
    await drain(c);
    const res = await app.inject({ method: 'GET', url: `/v1/audit/runs/${runId}`, headers: auth(tokA) });
    const { run, findings } = res.json();
    expect(run.status).toBe('completed');
    expect(run.txnCount).toBe(6);
    expect(run.summary.coveragePct).toBe(100);
    expect(run.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.prevHash).toBeNull();
    const rules = findings.map((f: { rule: string }) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(['duplicate_bill', 'cash_payment_limit', 'invoice_sequence_gap']));
    expect(findings[0].severity).toBe('critical');
    const dup = findings.find((f: { rule: string }) => f.rule === 'duplicate_bill');
    expect(dup.evidence.transactions).toHaveLength(2);
    expect(dup.evidence.parameters.maxCashPayment).toBe(10000);
    expect(run.summary.narrative).toBeTruthy();
  });

  it('isolates runs between tenants', async () => {
    await withSystemTx(c.prisma, async (txc) => {
      const pro = await txc.plan.findUniqueOrThrow({ where: { code: 'pro' } });
      await txc.tenant.update({ where: { id: B.tenant.id }, data: { planId: pro.id } });
    });
    const r = await app.inject({ method: 'GET', url: `/v1/audit/runs/${runId}`, headers: auth(tokB) });
    expect(r.statusCode).toBe(404);
  });

  it('requires a reason to dismiss, carries decisions forward and chains evidence', async () => {
    const { findings } = (await app.inject({ method: 'GET', url: `/v1/audit/runs/${runId}`, headers: auth(tokA) })).json();
    const gap = findings.find((f: { rule: string }) => f.rule === 'invoice_sequence_gap');
    expect((await app.inject({ method: 'PATCH', url: `/v1/audit/findings/${gap.id}`, headers: auth(tokA), payload: { status: 'dismissed' } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'PATCH', url: `/v1/audit/findings/${gap.id}`, headers: auth(tokA), payload: { status: 'dismissed', note: 'SINV-0003 voided on paper, approved by CA' } });
    expect(ok.json().status).toBe('dismissed');

    const second = (await app.inject({ method: 'POST', url: '/v1/audit/runs', headers: auth(tokA), payload: {} })).json();
    await drain(c);
    const r2 = (await app.inject({ method: 'GET', url: `/v1/audit/runs/${second.id}`, headers: auth(tokA) })).json();
    const first = (await app.inject({ method: 'GET', url: `/v1/audit/runs/${runId}`, headers: auth(tokA) })).json();
    expect(r2.run.prevHash).toBe(first.run.evidenceHash);
    expect(r2.run.datasetHash).toBe(first.run.datasetHash); // same population → same fingerprint
    const carried = r2.findings.find((f: { rule: string }) => f.rule === 'invoice_sequence_gap');
    expect(carried.status).toBe('dismissed');
    expect(carried.resolution).toMatch(/voided on paper/);
    expect(r2.run.summary.carriedDecisions).toBe(1);
  });

  it('exports a workpaper as JSON and CSV', async () => {
    const wp = (await app.inject({ method: 'GET', url: `/v1/audit/runs/${runId}/workpaper`, headers: auth(tokA) })).json();
    expect(wp.integrity.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(wp.findings.length).toBeGreaterThan(0);
    const csv = await app.inject({ method: 'GET', url: `/v1/audit/runs/${runId}/workpaper?format=csv`, headers: auth(tokA) });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body).toMatch(/duplicate_bill/);
  });

  it('surfaces high-risk findings on the dashboard', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/dashboard', headers: auth(tokA) });
    expect(r.json().alerts.some((a: { kind: string }) => a.kind === 'audit')).toBe(true);
  });
});
