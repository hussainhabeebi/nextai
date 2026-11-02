import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { tenantDb } from '../src/lib/db.js';
import { postDraft } from '../src/modules/drafts/service.js';
import { preparePdf } from '../src/modules/ocr/pipeline.js';
import { validateExtraction } from '../src/modules/ocr/validate.js';
import { similarity } from '../src/modules/ocr/match.js';
import { closeShared, createTenant, drain, extractionBytes, testContainer } from './helpers.js';
import { cwMessage, postCw } from './webhook-helpers.js';
import { deflateSync } from 'node:zlib';

const c = testContainer();
let app: FastifyInstance;
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
let conv = 9000;

beforeAll(async () => {
  await seed(c.prisma);
  A = await createTenant(c.prisma, { settings: { companyAbbr: 'AIL' } });
  B = await createTenant(c.prisma);
  app = await buildApp(c);
});
beforeEach(() => {
  c.queue.jobs = [];
});
afterAll(async () => {
  await app.close();
  await closeShared();
});

async function sendBill(bytes: Uint8Array, conversationId: number, tenant = A) {
  const url = `https://app.aiingo.com/rails/active_storage/${Math.random()}.jpg`;
  c.chatwoot(tenant.tenant);
  c.cws.get(tenant.tenant.id)!.attachments.set(url, { content: bytes, mime: 'image/jpeg' });
  await postCw(app, cwMessage({ inboxId: tenant.tenant.cwInboxId!, phone: tenant.owner.phone!, attachments: [{ file_type: 'image', data_url: url }], conversationId }));
}
const say = (text: string, conversationId: number, tenant = A) =>
  postCw(app, cwMessage({ inboxId: tenant.tenant.cwInboxId!, phone: tenant.owner.phone!, content: text, conversationId }));

describe('OCR → draft → confirm → post', () => {
  it('posts a purchase invoice to ERPNext after "1", attaches the bill and learns the vendor', async () => {
    const id = ++conv;
    await sendBill(extractionBytes(), id);
    await drain(c); // ocr.process
    const cw = c.cws.get(A.tenant.id)!;
    expect(cw.lastText(id)).toMatch(/Purchase bill[\s\S]*Kerala Paper Mart[\s\S]*1\. Confirm/);
    const draft = (await tenantDb(c.prisma, A.tenant.id).draft.findFirst({ where: { conversationId: id } }))!;
    expect(draft.status).toBe('pending');
    expect(draft.type).toBe('purchase_invoice');

    await say('1', id);
    expect(c.queue.jobs.map((j) => j.name)).toEqual(['draft.post']);
    await drain(c);

    const posted = await tenantDb(c.prisma, A.tenant.id).draft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(posted.status).toBe('posted');
    const erp = c.erps.get(A.tenant.id)!;
    const pinv = erp.docs.get('Purchase Invoice')!.get(posted.erpName!)!;
    expect(pinv).toMatchObject({ docstatus: 1, supplier: 'Kerala Paper Mart Pvt Ltd', bill_no: 'KPM-1042', taxes_and_charges: 'Input GST In-state - AIL' });
    expect(erp.docs.get('Supplier')!.has('Kerala Paper Mart Pvt Ltd')).toBe(true); // auto-created after confirmation
    expect(erp.files[0]!.attachTo).toEqual({ doctype: 'Purchase Invoice', name: posted.erpName });
    expect(cw.lastText(id)).toMatch(/Posted ✅/);
    const vm = await tenantDb(c.prisma, A.tenant.id).vendorMapping.findMany();
    expect(vm[0]).toMatchObject({ supplierName: 'Kerala Paper Mart Pvt Ltd', hits: 1 });
    // re-running the job is a no-op (idempotent)
    await postDraft(c, A.tenant.id, draft.id);
    expect(erp.docs.get('Purchase Invoice')!.size).toBe(1);
  });

  it('uses the learned mapping for a fuzzy-matched supplier next time', async () => {
    const id = ++conv;
    await tenantDb(c.prisma, A.tenant.id).vendorMapping.update({
      where: { tenantId_supplierName: { tenantId: A.tenant.id, supplierName: 'Kerala Paper Mart Pvt Ltd' } },
      data: { expenseAccount: 'Office Maintenance Expenses - AIL' },
    });
    await sendBill(extractionBytes({ supplierName: 'KERALA PAPER MART', invoiceNo: 'KPM-2000', total: 1180, subtotal: 1000, tax: { cgst: 90, sgst: 90, igst: 0, vat: 0 }, lines: [{ description: 'Toner', qty: 1, rate: 1000, amount: 1000 }] }), id);
    await drain(c);
    const d = (await tenantDb(c.prisma, A.tenant.id).draft.findFirst({ where: { conversationId: id } }))!;
    expect(d.payload).toMatchObject({ partyName: 'Kerala Paper Mart Pvt Ltd', expenseAccount: 'Office Maintenance Expenses - AIL' });
  });

  it('routes low confidence / invalid extractions to review with a Chatwoot label and handover', async () => {
    const id = ++conv;
    await sendBill(extractionBytes({ confidence: 0.5, invoiceNo: 'LOW-1' }), id);
    await drain(c);
    const d = (await tenantDb(c.prisma, A.tenant.id).draft.findFirst({ where: { conversationId: id } }))!;
    expect(d.status).toBe('needs_review');
    const cw = c.cws.get(A.tenant.id)!;
    expect(cw.labels.get(id)).toContain('needs-review');
    expect(cw.statuses.get(id)).toBe('open');
  });

  it('flags duplicates of the same supplier + invoice number + amount', async () => {
    const id = ++conv;
    await sendBill(extractionBytes({ lines: [{ description: 'A4 paper ', qty: 10, rate: 250, amount: 2500 }] }), id); // same KPM-1042 / 2950, different bytes
    await drain(c);
    const d = (await tenantDb(c.prisma, A.tenant.id).draft.findFirst({ where: { conversationId: id } }))!;
    expect(d.status).toBe('needs_review');
    expect((d.payload as { validationIssues: string[] }).validationIssues.join()).toMatch(/duplicate/);
  });

  it('edits then cancels a draft over WhatsApp', async () => {
    const id = ++conv;
    await say('paid 500 for tea', id);
    const cw = c.cws.get(A.tenant.id)!;
    expect(cw.lastText(id)).toMatch(/Expense[\s\S]*500/);
    await say('2', id);
    expect(cw.lastText(id)).toMatch(/What should I change/);
    await say('amount 650', id);
    expect(cw.lastText(id)).toMatch(/650/);
    const d = (await tenantDb(c.prisma, A.tenant.id).draft.findFirst({ where: { conversationId: id } }))!;
    expect(d.type).toBe('journal_entry');
    expect(d.payload).toMatchObject({ total: 650, expenseAccount: 'Entertainment Expenses - AIL' });
    await say('3', id);
    expect((await tenantDb(c.prisma, A.tenant.id).draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('cancelled');
  });

  it('asks for missing fields, then posts a journal entry for a small cash expense', async () => {
    const id = ++conv;
    await say('spent on fuel', id);
    // rules cannot find an amount → LLM mock → help; use explicit flow instead
    await say('paid 300 on petrol', id);
    await say('1', id);
    await drain(c);
    const je = [...c.erps.get(A.tenant.id)!.docs.get('Journal Entry')!.values()].at(-1)!;
    expect(je).toMatchObject({ docstatus: 1, voucher_type: 'Cash Entry' });
    expect(je.accounts).toEqual([
      { account: 'Travel Expenses - AIL', debit_in_account_currency: 300, credit_in_account_currency: 0 },
      { account: 'Cash - AIL', debit_in_account_currency: 0, credit_in_account_currency: 300 },
    ]);
    const id2 = ++conv;
    await say('sold 5000', id2);
    expect(c.cws.get(A.tenant.id)!.lastText(id2)).toMatch(/customer name/);
    await say('Ravi Traders', id2);
    expect(c.cws.get(A.tenant.id)!.lastText(id2)).toMatch(/Sales invoice[\s\S]*Ravi Traders[\s\S]*5,000/);
  });

  it('voice notes are transcribed and go through the same flow', async () => {
    const id = ++conv;
    const url = 'https://app.aiingo.com/rails/active_storage/voice1.ogg';
    c.cws.get(A.tenant.id)!.attachments.set(url, { content: new TextEncoder().encode('Ravi paid 2000'), mime: 'audio/ogg' });
    await postCw(app, cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, attachments: [{ file_type: 'audio', data_url: url }], conversationId: id }));
    await drain(c);
    expect(c.cws.get(A.tenant.id)!.lastText(id)).toMatch(/Payment received[\s\S]*Ravi[\s\S]*2,000/);
  });

  it('a job carrying tenant B id cannot touch tenant A drafts', async () => {
    const d = await tenantDb(c.prisma, A.tenant.id).draft.findFirstOrThrow({ where: { status: 'posted' } });
    await expect(postDraft(c, B.tenant.id, d.id)).rejects.toThrow(/not found/);
  });
});

describe('ocr helpers', () => {
  it('validates math, GSTIN and dates', () => {
    const ok = JSON.parse(new TextDecoder().decode(extractionBytes()));
    expect(validateExtraction(ok, 'IN').issues).toEqual([]);
    const bad = { ...ok, total: 5000, supplierTaxId: 'BADGSTIN', date: '2999-01-01' };
    const r = validateExtraction(bad, 'IN');
    expect(r.hard).toBe(true);
    expect(r.issues.length).toBeGreaterThanOrEqual(3);
  });
  it('fuzzy matches supplier names', () => {
    expect(similarity('KERALA PAPER MART', 'Kerala Paper Mart Pvt Ltd')).toBe(1);
    expect(similarity('Lulu Hypermarket LLC', 'LuLu Hyper Market')).toBeGreaterThan(0.8);
    expect(similarity('ABC Traders', 'XYZ Foods')).toBeLessThan(0.5);
  });
  it('extracts embedded text and page count from PDFs', () => {
    const content = deflateSync(Buffer.from('BT (Invoice No 55) Tj ET'));
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Filter /FlateDecode >>stream\n'),
      content,
      Buffer.from('endstream\n'),
    ]);
    expect(preparePdf(pdf)).toEqual({ pages: 2, text: 'Invoice No 55' });
  });
});
