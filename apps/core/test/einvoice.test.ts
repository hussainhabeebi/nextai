import type { FakeErpClient } from '@nextai/erpnext-client/testing';
import { QUEUES, tenantSettingsSchema } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { jobHandlers } from '../src/jobs/handlers.js';
import { tenantDb, withSystemTx } from '../src/lib/db.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { buildModel } from '../src/modules/einvoice/model.js';
import { ZATCA_GENESIS_PIH, buildIrp, buildPeppol, buildZatca, decodeTlv, indianFy, irn, validateIrp, validatePeppol, zatcaTlv } from '../src/modules/einvoice/schemes.js';
import { closeShared, createTenant, testContainer, type TestContainer } from './helpers.js';

const SELLER = '32AAPFU0939F1Z4'; // Kerala
const BUYER_KL = '32ABCDE1234F1Z9';
const BUYER_KA = '29ABCDE1234F1ZW';
const address = { line1: '12 MG Road', city: 'Kochi', postalCode: '682001', stateCode: '32' };

const fakeTenant = (country: 'IN' | 'AE', settings: Record<string, unknown>): Tenant =>
  ({ id: '00000000-0000-4000-8000-000000000001', name: 'Aiingo Technologies', country, currency: country === 'IN' ? 'INR' : 'AED', settings }) as unknown as Tenant;
const invoice = (over: Record<string, unknown> = {}) => ({
  name: 'SINV-26-0001',
  customer: 'Ravi Traders',
  posting_date: new Date().toISOString().slice(0, 10),
  posting_time: '10:15:00',
  docstatus: 1 as const,
  grand_total: 11800,
  items: [{ item_name: 'Website design', gst_hsn_code: '998314', qty: 1, rate: 10000, amount: 10000, uom: 'Nos' }],
  taxes: [
    { account_head: 'Output Tax CGST - AT', tax_amount: 900 },
    { account_head: 'Output Tax SGST - AT', tax_amount: 900 },
  ],
  customer_gstin: BUYER_KL,
  ...over,
});

describe('e-invoice formats (pure)', () => {
  const settings = tenantSettingsSchema.parse({ taxId: SELLER, address, companyName: 'Aiingo Technologies India LLP' });

  it('computes the IRN as SHA-256 of GSTIN + FY + type + number', () => {
    expect(indianFy('2026-11-23')).toBe('2026-27');
    expect(indianFy('2027-03-31')).toBe('2026-27');
    expect(irn(SELLER, '2026-11-23', 'INV', 'SINV-1')).toBe(createHash('sha256').update(`${SELLER}2026-27INVSINV-1`).digest('hex'));
  });

  it('builds IRP v1.1 JSON with CGST/SGST intra-state and IGST inter-state', () => {
    const m = buildModel({ tenant: fakeTenant('IN', settings), settings, invoice: invoice() });
    expect(validateIrp(m)).toEqual([]);
    const doc = JSON.parse(buildIrp(m).body);
    expect(doc.Version).toBe('1.1');
    expect(doc.DocDtls).toMatchObject({ Typ: 'INV', No: 'SINV-26-0001' });
    expect(doc.ItemList[0]).toMatchObject({ IsServc: 'Y', HsnCd: '998314', GstRt: 18, CgstAmt: 900, SgstAmt: 900, IgstAmt: 0, TotItemVal: 11800 });
    expect(doc.ValDtls).toMatchObject({ AssVal: 10000, TotInvVal: 11800 });

    const inter = buildModel({ tenant: fakeTenant('IN', settings), settings, invoice: invoice({ customer_gstin: BUYER_KA, taxes: [{ account_head: 'Output Tax IGST - AT', tax_amount: 1800 }] }) });
    expect(validateIrp(inter)).toEqual([]);
    expect(JSON.parse(buildIrp(inter).body).ItemList[0]).toMatchObject({ IgstAmt: 1800, CgstAmt: 0 });
  });

  it('blocks non-compliant invoices with actionable messages', () => {
    const m = buildModel({ tenant: fakeTenant('IN', settings), settings, invoice: invoice({ customer_gstin: BUYER_KA, items: [{ item_name: 'Paper', qty: 1, rate: 10000, amount: 10000 }] }) });
    const fields = validateIrp(m).map((i) => i.field);
    expect(fields).toContain('lines[1].hsn');
    expect(fields).toContain('taxes'); // CGST/SGST on an inter-state supply
  });

  it('encodes the ZATCA TLV QR and chains invoice hashes', () => {
    const tlv = zatcaTlv([[1, 'Bobs Records'], [2, '310122393500003']]);
    expect(decodeTlv(tlv)).toEqual({ 1: 'Bobs Records', 2: '310122393500003' });
    expect(ZATCA_GENESIS_PIH).toBe('NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==');
    const ksa = tenantSettingsSchema.parse({ taxId: '310122393500003', address: { line1: 'King Fahd Rd', city: 'Riyadh' } });
    const m = buildModel({ tenant: fakeTenant('AE', ksa), settings: ksa, invoice: invoice({ customer_gstin: undefined, taxes: [{ account_head: 'VAT 15%', tax_amount: 1500 }], grand_total: 11500 }) });
    const first = buildZatca(m, 't1', { counter: 1 });
    const second = buildZatca({ ...m, number: 'SINV-26-0002' }, 't1', { counter: 2, prevHash: first.hash });
    expect(first.prevHash).toBe(ZATCA_GENESIS_PIH);
    expect(second.body).toContain(`>${first.hash}<`);
    expect(second.body).toContain('<cbc:UUID>2</cbc:UUID>');
    expect(decodeTlv(second.qr!)[6]).toBe(second.hash);
    expect(first.body).toContain('name="0200000"'); // simplified (B2C)
  });

  it('builds Peppol PINT AE UBL with escaped content', () => {
    const ae = tenantSettingsSchema.parse({ taxId: '100123456700003', address: { line1: 'Office 4, Bay Square', city: 'Dubai', stateCode: 'DU' } });
    const m = buildModel({ tenant: fakeTenant('AE', ae), settings: ae, invoice: invoice({ customer_name: 'Smith & <Sons>', customer_gstin: undefined, tax_id: '100987654300003', taxes: [{ account_head: 'VAT 5%', tax_amount: 500 }], grand_total: 10500 }) });
    expect(validatePeppol(m)).toEqual([]);
    const d = buildPeppol(m, 't1');
    expect(d.body).toContain('urn:peppol:pint:billing-1@ae-1');
    expect(d.body).toContain('Smith &amp; &lt;Sons&gt;');
    expect(d.body).toContain('<cbc:PayableAmount currencyID="AED">10500.00</cbc:PayableAmount>');
    expect(buildPeppol(m, 't1').id).toBe(d.id); // stable across retries
    expect(validatePeppol({ ...m, totals: { ...m.totals, vat: 900, tax: 900, total: 10900 } }).map((i) => i.field)).toContain('taxes');
  });
});

/** Run only the queues under test (outbound sending is covered elsewhere). */
async function run(c: TestContainer, only: string[]) {
  const h = jobHandlers(c);
  const ran: string[] = [];
  for (let i = 0; i < 50; i++) {
    const idx = c.queue.jobs.findIndex((j) => only.includes(j.name));
    if (idx < 0) break;
    const [job] = c.queue.jobs.splice(idx, 1);
    ran.push(job!.name);
    await h[job!.name]!(job!.data);
  }
  return ran;
}

describe('e-invoicing flow', () => {
  const c = testContainer();
  let app: FastifyInstance;
  let A: Awaited<ReturnType<typeof createTenant>>;
  let tok: string;
  let erp: FakeErpClient;
  const auth = () => ({ authorization: `Bearer ${tok}` });

  beforeAll(async () => {
    await seed(c.prisma);
    A = await createTenant(c.prisma, { settings: { taxId: SELLER, address, eInvoicing: { enabled: true } } });
    app = await buildApp(c);
    tok = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'owner', typ: 'app' });
    erp = c.erp(A.tenant) as FakeErpClient;
    erp.docs.set('Sales Invoice', new Map([['SINV-26-0001', { doctype: 'Sales Invoice', ...invoice() }]]));
    erp.docs.set('Customer', new Map([['Ravi Traders', { doctype: 'Customer', name: 'Ravi Traders', gstin: BUYER_KL }]]));
  });
  afterAll(async () => {
    await app.close();
    await closeShared();
  });

  it('registers an ERPNext invoice, writes the IRN back and only then releases the customer copy', async () => {
    // same entry point the ERPNext on_submit webhook and bot posting use
    const { onSalesInvoiceSubmitted } = await import('../src/modules/einvoice/service.js');
    expect(await onSalesInvoiceSubmitted(c, A.tenant, 'SINV-26-0001', { send: true, source: 'erpnext' })).toBe('einvoice');
    expect(c.queue.jobs.map((j) => j.name)).toEqual([QUEUES.einvoiceSubmit]); // not sent yet
    await run(c, [QUEUES.einvoiceSubmit]);
    const e = await tenantDb(c.prisma, A.tenant.id).eInvoice.findFirstOrThrow({ where: { invoiceName: 'SINV-26-0001' } });
    expect(e.status).toBe('accepted');
    expect(e.irn).toBe(irn(SELLER, invoice().posting_date as string, 'INV', 'SINV-26-0001'));
    expect(e.ackNo).toMatch(/^\d{15}$/);
    expect(e.qrPayload).toMatch(/\./);
    expect((erp.docs.get('Sales Invoice')!.get('SINV-26-0001') as Record<string, unknown>).irn).toBe(e.irn);
    expect(c.queue.jobs.map((j) => j.name)).toContain(QUEUES.outboundInvoice);
    const stored = await c.storage.get(A.tenant.id, e.r2Key!);
    expect(JSON.parse(new TextDecoder().decode(stored.body)).DocDtls.No).toBe('SINV-26-0001');
    c.queue.jobs = [];
  });

  it('is idempotent: re-submitting returns the same registration', async () => {
    await c.queue.enqueue(QUEUES.einvoiceSubmit, { tenantId: A.tenant.id, invoiceName: 'SINV-26-0001' });
    await run(c, [QUEUES.einvoiceSubmit]);
    const rows = await tenantDb(c.prisma, A.tenant.id).eInvoice.findMany({ where: { invoiceName: 'SINV-26-0001' } });
    expect(rows).toHaveLength(1);
    expect(c.einvoice.registered.size).toBe(1);
  });

  it('holds a bot-posted invoice that is missing HSN codes and tells the owner why', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/invoices', headers: auth(), payload: { customer: 'Meera Stores', lines: [{ description: 'Consulting', qty: 1, rate: 5000 }] } });
    expect(r.statusCode).toBe(201);
    await run(c, [QUEUES.draftPost]);
    // give the fake ERPNext invoice a buyer GSTIN so it is B2B
    const [name] = [...erp.docs.get('Sales Invoice')!.keys()].filter((k) => k !== 'SINV-26-0001');
    Object.assign(erp.docs.get('Sales Invoice')!.get(name!)!, { customer_gstin: BUYER_KA });
    await run(c, [QUEUES.einvoiceSubmit]);
    const e = await tenantDb(c.prisma, A.tenant.id).eInvoice.findFirstOrThrow({ where: { invoiceName: name } });
    expect(e.status).toBe('invalid');
    expect((e.errors as Array<{ field: string }>).map((x) => x.field)).toContain('lines[1].hsn');
    expect(c.queue.jobs.some((j) => j.name === QUEUES.outboundInvoice)).toBe(false);
    const list = (await app.inject({ method: 'GET', url: '/v1/einvoices', headers: auth() })).json();
    expect(list.summary).toMatchObject({ enabled: true, scheme: 'in_irp', needsAction: 1 });
    const dash = (await app.inject({ method: 'GET', url: '/v1/dashboard', headers: auth() })).json();
    expect(dash.alerts.some((a: { kind: string }) => a.kind === 'einvoice')).toBe(true);
  });

  it('skips B2C invoices in India and sends them straight away', async () => {
    erp.docs.get('Sales Invoice')!.set('SINV-B2C-1', { doctype: 'Sales Invoice', ...invoice({ name: 'SINV-B2C-1', customer: 'Walk-in', customer_gstin: undefined }) });
    await c.queue.enqueue(QUEUES.einvoiceSubmit, { tenantId: A.tenant.id, invoiceName: 'SINV-B2C-1', sendAfter: true });
    await run(c, [QUEUES.einvoiceSubmit]);
    expect(await tenantDb(c.prisma, A.tenant.id).eInvoice.count({ where: { invoiceName: 'SINV-B2C-1' } })).toBe(0);
    expect(c.queue.jobs.some((j) => j.name === QUEUES.outboundInvoice && j.data.invoiceName === 'SINV-B2C-1')).toBe(true);
    c.queue.jobs = [];
  });

  it('records authority rejections and retries gateway outages', async () => {
    erp.docs.get('Sales Invoice')!.set('SINV-26-0009', { doctype: 'Sales Invoice', ...invoice({ name: 'SINV-26-0009' }) });
    c.einvoice.rejectNext = [{ field: '2150', message: 'Duplicate IRN' }];
    await c.queue.enqueue(QUEUES.einvoiceSubmit, { tenantId: A.tenant.id, invoiceName: 'SINV-26-0009' });
    await run(c, [QUEUES.einvoiceSubmit]);
    const db = tenantDb(c.prisma, A.tenant.id);
    expect((await db.eInvoice.findFirstOrThrow({ where: { invoiceName: 'SINV-26-0009' } })).status).toBe('rejected');
    const { GatewayError } = await import('../src/modules/einvoice/gateway.js');
    c.einvoice.failNext = new GatewayError('503', true);
    await expect(jobHandlers(c)[QUEUES.einvoiceSubmit]!({ tenantId: A.tenant.id, invoiceName: 'SINV-26-0009' })).rejects.toThrow('503');
    expect((await db.eInvoice.findFirstOrThrow({ where: { invoiceName: 'SINV-26-0009' } })).status).toBe('failed');
    await jobHandlers(c)[QUEUES.einvoiceSubmit]!({ tenantId: A.tenant.id, invoiceName: 'SINV-26-0009' });
    expect((await db.eInvoice.findFirstOrThrow({ where: { invoiceName: 'SINV-26-0009' } })).status).toBe('accepted');
  });

  it('cancels within the 24-hour IRP window only', async () => {
    const db = tenantDb(c.prisma, A.tenant.id);
    const e = await db.eInvoice.findFirstOrThrow({ where: { invoiceName: 'SINV-26-0009' } });
    await withSystemTx(c.prisma, (tx) => tx.eInvoice.update({ where: { id: e.id }, data: { ackDate: new Date(Date.now() - 25 * 3600_000) } }));
    const late = await app.inject({ method: 'POST', url: `/v1/einvoices/${e.id}/cancel`, headers: auth(), payload: { reason: 'data_entry_mistake' } });
    expect(late.statusCode).toBe(400);
    expect(late.json().message).toMatch(/credit note/);
    const ok = await db.eInvoice.findFirstOrThrow({ where: { invoiceName: 'SINV-26-0001' } });
    const r = await app.inject({ method: 'POST', url: `/v1/einvoices/${ok.id}/cancel`, headers: auth(), payload: { reason: 'order_cancelled', remark: 'Customer cancelled' } });
    expect(r.json().status).toBe('cancelled');
    expect(c.einvoice.cancelled.has(`${A.tenant.id}:in_irp:${ok.irn}`)).toBe(true);
  });

  it('keeps settings partial updates from wiping nested values', async () => {
    const r = await app.inject({ method: 'PATCH', url: '/v1/settings', headers: auth(), payload: { settings: { eInvoicing: { autoSubmit: false }, address: { line2: 'Floor 3' } } } });
    expect(r.statusCode).toBe(200);
    expect(r.json().settings.eInvoicing).toMatchObject({ enabled: true, autoSubmit: false });
    expect(r.json().settings.address).toMatchObject({ line1: '12 MG Road', line2: 'Floor 3' });
  });
});
