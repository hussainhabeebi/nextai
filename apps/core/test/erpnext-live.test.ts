/**
 * Live end-to-end test against a real ERPNext site: WhatsApp message / bill photo → draft → "1" → posted
 * and submitted in ERPNext. Skipped unless ERPNEXT_TEST_URL is set, e.g.
 *
 *   ERPNEXT_TEST_URL=http://erp.local:18000 ERPNEXT_TEST_KEY=... ERPNEXT_TEST_SECRET=... \
 *   ERPNEXT_TEST_COMPANY="Aiingo Trading LLC" ERPNEXT_TEST_ABBR=ATL pnpm --filter @nextai/core test erpnext-live
 *
 * The site must have finished the ERPNext setup wizard (company, fiscal year, chart of accounts).
 */
import { createErpClient, type ErpClient } from '@nextai/erpnext-client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { tenantDb } from '../src/lib/db.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { closeShared, createTenant, drain, extractionBytes, testContainer } from './helpers.js';
import { cwMessage, postCw } from './webhook-helpers.js';

const URL_ = process.env.ERPNEXT_TEST_URL;
const live = describe.runIf(!!URL_);

live('ERPNext live posting', () => {
  const c = testContainer();
  let app: FastifyInstance;
  let A: Awaited<ReturnType<typeof createTenant>>;
  let erp: ErpClient;
  let conv = 90000;
  const run = Date.now().toString(36);

  beforeAll(async () => {
    await seed(c.prisma);
    erp = createErpClient({ baseUrl: URL_!, apiKey: process.env.ERPNEXT_TEST_KEY!, apiSecret: process.env.ERPNEXT_TEST_SECRET! });
    c.erp = () => erp;
    A = await createTenant(c.prisma, {
      country: 'AE',
      currency: 'AED',
      settings: { erpCompany: process.env.ERPNEXT_TEST_COMPANY, companyAbbr: process.env.ERPNEXT_TEST_ABBR },
    });
    app = await buildApp(c);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await closeShared();
  });

  const say = (text: string, id: number) =>
    postCw(app, cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, content: text, conversationId: id }));
  async function sendBill(bytes: Uint8Array, id: number) {
    const url = `https://app.aiingo.com/rails/active_storage/${Math.random()}.jpg`;
    c.chatwoot(A.tenant);
    c.cws.get(A.tenant.id)!.attachments.set(url, { content: bytes, mime: 'image/jpeg' });
    await postCw(app, cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, attachments: [{ file_type: 'image', data_url: url }], conversationId: id }));
  }
  /** Confirm the pending draft of a conversation, run the worker, and return the draft + the ERPNext doc. */
  async function confirmAndPost(id: number) {
    const db = tenantDb(c.prisma, A.tenant.id);
    const draft = await db.draft.findFirst({ where: { conversationId: id }, orderBy: { createdAt: 'desc' } });
    expect(draft, `no draft; bot said: ${c.cws.get(A.tenant.id)?.lastText(id)}`).toBeTruthy();
    if (draft!.status === 'pending') await say('1', id);
    await drain(c);
    const after = await db.draft.findUniqueOrThrow({ where: { id: draft!.id } });
    expect(after.error ?? '', `${after.type}: ${after.error}`).toBe('');
    expect(after.status).toBe('posted');
    const doc = await erp.get(after.erpDoctype!, after.erpName!);
    expect(doc.docstatus).toBe(1);
    return { draft: after, doc };
  }

  it('Admin → Integrations → Connect ERPNext signs in and finds the company', async () => {
    const auth = `Bearer ${await signAccess({ sub: '00000000-0000-4000-8000-000000000001', prole: 'super_admin', typ: 'admin' })}`;
    const r = await app.inject({
      method: 'POST',
      url: `/admin/v1/tenants/${A.tenant.id}/erpnext/connect`,
      headers: { authorization: auth },
      payload: { siteUrl: URL_, apiKey: process.env.ERPNEXT_TEST_KEY, apiSecret: process.env.ERPNEXT_TEST_SECRET, company: process.env.ERPNEXT_TEST_COMPANY },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, company: process.env.ERPNEXT_TEST_COMPANY, abbr: process.env.ERPNEXT_TEST_ABBR, warnings: [] });
  }, 60_000);

  it('bill photo on credit → submitted Purchase Invoice with VAT template and the bill attached', async () => {
    const id = ++conv;
    await sendBill(
      extractionBytes({
        supplierName: `Gulf Office Supplies ${run}`,
        supplierTaxId: null,
        invoiceNo: `GOS-${run}`,
        currency: 'AED',
        lines: [{ description: 'Printer paper', qty: 4, rate: 25, amount: 100 }],
        subtotal: 100,
        tax: { cgst: 0, sgst: 0, igst: 0, vat: 5 },
        total: 105,
        paymentMode: 'credit',
      }),
      id,
    );
    await drain(c);
    const { doc } = await confirmAndPost(id);
    expect(doc.doctype).toBe('Purchase Invoice');
    expect(doc.taxes_and_charges).toBe(`UAE VAT 5% - ${process.env.ERPNEXT_TEST_ABBR}`);
    expect(doc.grand_total).toBe(105);
  }, 120_000);

  it('bill photo paid by card → paid Purchase Invoice against a bank (leaf) account', async () => {
    const id = ++conv;
    await sendBill(
      extractionBytes({
        supplierName: `Card Store ${run}`,
        supplierTaxId: null,
        invoiceNo: `CS-${run}`,
        currency: 'AED',
        lines: [{ description: 'Office chairs', qty: 2, rate: 400, amount: 800 }],
        subtotal: 800,
        tax: { cgst: 0, sgst: 0, igst: 0, vat: 0 },
        total: 800,
        paymentMode: 'card',
      }),
      id,
    );
    await drain(c);
    const { doc } = await confirmAndPost(id);
    expect(doc.doctype).toBe('Purchase Invoice');
    expect(doc.is_paid).toBe(1);
    expect(doc.cash_bank_account).not.toBe(`Bank Accounts - ${process.env.ERPNEXT_TEST_ABBR}`); // a group account can't be posted to
  }, 120_000);

  it('"paid 300 on petrol" → cash Journal Entry', async () => {
    const id = ++conv;
    await say('paid 300 on petrol', id);
    await drain(c);
    const { doc } = await confirmAndPost(id);
    expect(doc.doctype).toBe('Journal Entry');
    expect(doc.voucher_type).toBe('Cash Entry');
  }, 120_000);

  it('"paid 1200 for rent by bank" → bank Journal Entry to the rent account', async () => {
    const id = ++conv;
    await say('paid 1200 for rent by bank', id);
    await drain(c);
    const { doc } = await confirmAndPost(id);
    expect(doc.doctype).toBe('Journal Entry');
    expect(doc.voucher_type).toBe('Bank Entry');
    const accounts = (doc.accounts as Array<{ account: string; debit_in_account_currency: number }>).map((a) => a.account);
    expect(accounts[0]).toBe(`Office Rent - ${process.env.ERPNEXT_TEST_ABBR}`);
    expect(doc.total_debit).toBe(1200);
  }, 120_000);

  it('"sold 5000 to <customer>" → submitted Sales Invoice', async () => {
    const id = ++conv;
    await say(`sold 5000 to Ravi Traders ${run}`, id);
    await drain(c);
    const { doc } = await confirmAndPost(id);
    expect(doc.doctype).toBe('Sales Invoice');
    expect(doc.currency).toBe('AED');
    expect(doc.grand_total).toBe(5000);
  }, 120_000);

  it('"<customer> paid 2000" → Payment Entry (Receive)', async () => {
    const id = ++conv;
    await say(`Ravi Traders ${run} paid 2000`, id);
    await drain(c);
    const { doc } = await confirmAndPost(id);
    expect(doc.doctype).toBe('Payment Entry');
    expect(doc.payment_type).toBe('Receive');
    expect(doc.paid_amount).toBe(2000); // not a digit from the customer's name
  }, 120_000);

  it('"paid 1000 to <supplier> by bank" → Payment Entry (Pay)', async () => {
    const id = ++conv;
    await say(`paid 1000 to Gulf Office Supplies ${run} by bank`, id);
    await drain(c);
    const { doc } = await confirmAndPost(id);
    expect(doc.doctype).toBe('Payment Entry');
    expect(doc.payment_type).toBe('Pay');
    expect(doc.paid_amount).toBe(1000);
    expect(doc.party).toBe(`Gulf Office Supplies ${run[0]!.toUpperCase()}${run.slice(1)}`); // no "By Bank" in the name
  }, 120_000);
});
