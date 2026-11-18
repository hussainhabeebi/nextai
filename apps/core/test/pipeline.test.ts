import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { tenantDb } from '../src/lib/db.js';
import { postDraft } from '../src/modules/drafts/service.js';
import { erpContext } from '../src/modules/erpnext/mappers.js';
import { preparePdf, processOcr, sniffMime } from '../src/modules/ocr/pipeline.js';
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
  // Like a real site with India Compliance: GST templates exist and carry the tax rows.
  const erpA = c.erp(A.tenant) as unknown as { create: (d: string, x: Record<string, unknown>) => Promise<unknown> };
  await erpA.create('Purchase Taxes and Charges Template', {
    name: 'Input GST In-state - AIL',
    taxes: [
      { charge_type: 'On Net Total', account_head: 'Input Tax CGST - AIL', rate: 9, description: 'CGST', category: 'Total', add_deduct_tax: 'Add' },
      { charge_type: 'On Net Total', account_head: 'Input Tax SGST - AIL', rate: 9, description: 'SGST', category: 'Total', add_deduct_tax: 'Add' },
    ],
  });
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
const sayAs = (text: string, conversationId: number, tenant: typeof A) => say(text, conversationId, tenant);

describe('creating accounts from WhatsApp', () => {
  it('adds a supplier or customer once, asks what an account is when unclear, and adds ledgers under the right group', async () => {
    const T = await createTenant(c.prisma, { settings: { companyAbbr: 'AIL' } }); // own books: ledgers added here stay out of other tests
    const erp = c.erp(T.tenant) as unknown as { create: (d: string, x: Record<string, unknown>) => Promise<unknown> };
    const company = erpContext(T.tenant).company;
    const docs = () => c.erps.get(T.tenant.id)!.docs;
    const group = (name: string, root_type: string, account_type = '') =>
      erp.create('Account', { name, account_name: name.replace(/ - AIL$/, ''), company, is_group: 1, root_type, account_type, parent_account: `${root_type} - AIL` });
    await group('Indirect Expenses - AIL', 'Expense');
    await group('Bank Accounts - AIL', 'Asset', 'Bank');
    c.chatwoot(T.tenant);
    const cw = () => c.cws.get(T.tenant.id)!;
    const say = (text: string, conversationId: number) => sayAs(text, conversationId, T);

    const id = ++conv;
    await say('Create supplier account AM Motors', id);
    expect(cw().lastText(id)).toMatch(/Supplier "AM Motors" added/);
    // never the root group: ERPNext rejects "All Supplier Groups"; a site without a leaf group gets "General"
    expect(docs().get('Supplier')!.get('AM Motors')).toMatchObject({ supplier_name: 'AM Motors', supplier_group: 'General' });
    expect(docs().get('Supplier Group')!.get('General')).toMatchObject({ parent_supplier_group: 'All Supplier Groups', is_group: 0 });
    await say('add am motors as a vendor', id);
    expect(cw().lastText(id)).toMatch(/already in your books/);
    expect([...docs().get('Supplier')!.values()].filter((s) => String(s.supplier_name).toLowerCase() === 'am motors')).toHaveLength(1);

    await say('create account for Kochi Bakers', id);
    expect(cw().lastText(id)).toMatch(/What kind of account is Kochi Bakers\?[\s\S]*1\. Customer[\s\S]*2\. Supplier/);
    await say('1', id);
    expect(cw().lastText(id)).toMatch(/Customer "Kochi Bakers" added/);
    expect(docs().get('Customer')!.get('Kochi Bakers')).toBeDefined();

    await say('create expense account Fuel', id);
    expect(cw().lastText(id)).toMatch(/Expense account "Fuel" added to your books under Indirect Expenses/);
    expect([...docs().get('Account')!.values()].find((a) => a.account_name === 'Fuel')).toMatchObject({ parent_account: 'Indirect Expenses - AIL', is_group: 0, company });
    await say('open bank account HDFC Current', id);
    expect([...docs().get('Account')!.values()].find((a) => a.account_name === 'HDFC Current')).toMatchObject({ parent_account: 'Bank Accounts - AIL', account_type: 'Bank' });

    await say('add a customer', id);
    expect(cw().lastText(id)).toMatch(/customer name/);
    await say('shop 24', id);
    expect(cw().lastText(id)).toMatch(/Customer "Shop 24" added/);
  });

  it('creates every kind of ledger: capital, loans, tax, fixed assets, or under a named group', async () => {
    const T = await createTenant(c.prisma, { settings: { companyAbbr: 'AIL' } });
    const erp = c.erp(T.tenant) as unknown as { create: (d: string, x: Record<string, unknown>) => Promise<unknown> };
    const company = erpContext(T.tenant).company;
    const accounts = () => [...c.erps.get(T.tenant.id)!.docs.get('Account')!.values()];
    const group = (name: string, root_type: string, parent: string | null, account_type = '') =>
      erp.create('Account', { name: `${name} - AIL`, account_name: name, company, is_group: 1, root_type, account_type, parent_account: parent ? `${parent} - AIL` : undefined });
    // ERPNext's standard chart (India), as groups
    await group('Source of Funds (Liabilities)', 'Liability', null);
    await group('Capital Account', 'Liability', 'Source of Funds (Liabilities)');
    await group('Current Liabilities', 'Liability', 'Source of Funds (Liabilities)');
    await group('Duties and Taxes', 'Liability', 'Current Liabilities', 'Tax');
    await group('Loans (Liabilities)', 'Liability', 'Source of Funds (Liabilities)');
    await group('Application of Funds (Assets)', 'Asset', null);
    await group('Fixed Assets', 'Asset', 'Application of Funds (Assets)');
    await group('Current Assets', 'Asset', 'Application of Funds (Assets)');
    await group('Expenses', 'Expense', null);
    await group('Direct Expenses', 'Expense', 'Expenses');
    c.chatwoot(T.tenant);
    const cw = () => c.cws.get(T.tenant.id)!;
    const say = (text: string, conversationId: number) => sayAs(text, conversationId, T);
    const leaf = (name: string) => accounts().find((a) => a.account_name === name);

    const id = ++conv;
    await say('Create Capital account Hussain', id);
    expect(cw().lastText(id)).toMatch(/Capital account "Hussain" added to your books under Capital Account/);
    expect(leaf('Hussain')).toMatchObject({ parent_account: 'Capital Account - AIL', is_group: 0, root_type: 'Liability' });
    await say('new loan account SBI Car Loan', id);
    expect(leaf('SBI Car Loan')).toMatchObject({ parent_account: 'Loans (Liabilities) - AIL' });
    await say('create tax account Output VAT 5%', id);
    expect(leaf('Output VAT 5%')).toMatchObject({ parent_account: 'Duties and Taxes - AIL', account_type: 'Tax' });
    await say('create fixed asset account Delivery Van', id);
    expect(leaf('Delivery Van')).toMatchObject({ parent_account: 'Fixed Assets - AIL', root_type: 'Asset' });
    await say('add direct expense account Freight Inward', id);
    expect(leaf('Freight Inward')).toMatchObject({ parent_account: 'Direct Expenses - AIL' });

    await say('create account Hussain Drawings under capital account', id);
    expect(cw().lastText(id)).toMatch(/"Hussain Drawings" added to your books under Capital Account/);
    expect(leaf('Hussain Drawings')).toMatchObject({ parent_account: 'Capital Account - AIL' });
    await say('create account Rent Deposit under Deposits Paid', id);
    expect(cw().lastText(id)).toMatch(/couldn't find a group called "Deposits Paid"[\s\S]*• Current Assets/);

    // unclear kind: answered with a number, or with a group
    await say('create GL account Shahala Capital', id);
    expect(cw().lastText(id)).toMatch(/What kind of account is Shahala Capital\?[\s\S]*7\. Capital[\s\S]*under Capital Account/);
    await say('7', id);
    expect(leaf('Shahala Capital')).toMatchObject({ parent_account: 'Capital Account - AIL' });
    await say('create account Office Deposit', id);
    await say('under current assets', id);
    expect(leaf('Office Deposit')).toMatchObject({ parent_account: 'Current Assets - AIL' });
    await say('create capital account Hussain', id);
    expect(cw().lastText(id)).toMatch(/already in your books \(under Capital Account\)/);
  });

  it('money from the owner/director is capital, not a customer receipt; drawings and loans likewise', async () => {
    const T = await createTenant(c.prisma, { settings: { companyAbbr: 'AIL' } });
    const erp = c.erp(T.tenant) as unknown as { create: (d: string, x: Record<string, unknown>) => Promise<unknown> };
    const company = erpContext(T.tenant).company;
    const docs = () => c.erps.get(T.tenant.id)!.docs;
    await erp.create('Account', { name: 'Capital Account - AIL', account_name: 'Capital Account', company, is_group: 1, root_type: 'Liability', parent_account: 'Source of Funds (Liabilities) - AIL' });
    await erp.create('Account', { name: 'Loans (Liabilities) - AIL', account_name: 'Loans (Liabilities)', company, is_group: 1, root_type: 'Liability', parent_account: 'Source of Funds (Liabilities) - AIL' });
    await erp.create('Account', { name: 'Cash - AIL', account_name: 'Cash', company, is_group: 0, root_type: 'Asset', account_type: 'Cash', parent_account: 'Cash In Hand - AIL' });
    await erp.create('Customer Group', { name: 'All Customer Groups', is_group: 1 });
    await erp.create('Customer Group', { name: 'Commercial', is_group: 0, parent_customer_group: 'All Customer Groups' });
    c.chatwoot(T.tenant);
    const cw = () => c.cws.get(T.tenant.id)!;
    const say = (text: string, conversationId: number) => sayAs(text, conversationId, T);
    const lastJe = () => [...docs().get('Journal Entry')!.values()].at(-1)!;

    // the exact message from WhatsApp
    const id = ++conv;
    await say('Received Rs 50000 Cash from Hussain capital account by cash', id);
    expect(cw().lastText(id)).toMatch(/Money received[\s\S]*Capital introduced by Hussain[\s\S]*new capital account[\s\S]*Received in: cash[\s\S]*50,000/);
    expect(cw().lastText(id)).not.toMatch(/Customer:/);
    await say('1', id);
    await drain(c);
    expect(docs().get('Customer')?.size ?? 0).toBe(0); // no customer called "Hussain Capital Account"
    const hussain = [...docs().get('Account')!.values()].find((a) => a.account_name === 'Hussain')!;
    expect(hussain).toMatchObject({ parent_account: 'Capital Account - AIL', is_group: 0 });
    expect(lastJe()).toMatchObject({ docstatus: 1, voucher_type: 'Cash Entry' });
    expect(lastJe().accounts).toEqual([
      { account: hussain.name, debit_in_account_currency: 0, credit_in_account_currency: 50000 },
      { account: 'Cash - AIL', debit_in_account_currency: 50000, credit_in_account_currency: 0 },
    ]);

    // next time the existing capital account is used; other ways of saying it
    const id2 = ++conv;
    await say('director Hussain brought in 20000', id2);
    expect(cw().lastText(id2)).toMatch(/Money received[\s\S]*Account: Hussain/);
    await say('1', id2);
    await drain(c);
    expect((lastJe().accounts as unknown[])[0]).toMatchObject({ account: hussain.name, credit_in_account_currency: 20000 });
    const id3 = ++conv;
    await say('paid 5000 to Hussain drawings', id3);
    expect(cw().lastText(id3)).toMatch(/Money paid[\s\S]*Drawings by Hussain/);
    await say('1', id3);
    await drain(c);
    expect(lastJe().accounts).toEqual([
      { account: hussain.name, debit_in_account_currency: 5000, credit_in_account_currency: 0 },
      { account: 'Cash - AIL', debit_in_account_currency: 0, credit_in_account_currency: 5000 },
    ]);
    const id4 = ++conv;
    await say('received 200000 from SBI loan by bank', id4);
    expect(cw().lastText(id4)).toMatch(/Loan received from SBI[\s\S]*SBI \(new loan account/);

    // ordinary customers still work, in a real (leaf) customer group
    const id5 = ++conv;
    await say('received 3000 from Ravi Traders', id5);
    expect(cw().lastText(id5)).toMatch(/Payment received[\s\S]*Customer: Ravi Traders/);
    await say('1', id5);
    await drain(c);
    expect(docs().get('Customer')!.get('Ravi Traders')).toMatchObject({ customer_group: 'Commercial' });
  });
});

describe('everyday transactions over WhatsApp post the right ERPNext document', () => {
  it('payments in/out, purchases, returns and cash ↔ bank transfers', async () => {
    const T = await createTenant(c.prisma, { settings: { companyAbbr: 'AIL' } });
    const erp = c.erp(T.tenant) as unknown as { create: (d: string, x: Record<string, unknown>) => Promise<unknown> };
    const company = erpContext(T.tenant).company;
    await erp.create('Account', { name: 'Cash - AIL', account_name: 'Cash', company, is_group: 0, root_type: 'Asset', account_type: 'Cash', parent_account: 'Cash In Hand - AIL' });
    await erp.create('Account', { name: 'Bank Account - AIL', account_name: 'Bank Account', company, is_group: 0, root_type: 'Asset', account_type: 'Bank', parent_account: 'Bank Accounts - AIL' });
    c.chatwoot(T.tenant);
    const cw = () => c.cws.get(T.tenant.id)!;
    const docs = (d: string) => [...(c.erps.get(T.tenant.id)!.docs.get(d)?.values() ?? [])];
    const say = (text: string, conversationId: number) => sayAs(text, conversationId, T);
    const confirm = async (text: string, expected: RegExp) => {
      const id = ++conv;
      await say(text, id);
      expect(cw().lastText(id)).toMatch(expected);
      await say('1', id);
      await drain(c);
      return id;
    };

    // the exact message that used to get the help menu back
    await confirm('Received Rs 6300 from 4L fashion', /Payment received[\s\S]*Customer: 4L fashion[\s\S]*6,300/);
    expect(docs('Payment Entry').at(-1)).toMatchObject({ docstatus: 1, payment_type: 'Receive', party_type: 'Customer', party: '4L fashion', paid_amount: 6300 });

    await confirm('paid 2500 to 4L fashion by bank', /Payment made[\s\S]*Supplier: 4L fashion[\s\S]*2,500/);
    expect(docs('Payment Entry').at(-1)).toMatchObject({ docstatus: 1, payment_type: 'Pay', party_type: 'Supplier', party: '4L fashion', paid_from: 'Bank Account - AIL' });

    await confirm('bought cement for 12000 from AM Motors', /Purchase bill[\s\S]*Supplier: AM Motors[\s\S]*cement[\s\S]*12,000/);
    const bill = docs('Purchase Invoice').at(-1)!;
    expect(bill).toMatchObject({ docstatus: 1, supplier: 'AM Motors' });
    expect(bill.is_paid).toBeUndefined(); // bought on credit unless they say how it was paid

    await confirm('Ravi returned goods worth 1500', /Sales return \(credit note\)[\s\S]*Customer: Ravi[\s\S]*1,500/);
    const cn = docs('Sales Invoice').at(-1)!;
    expect(cn).toMatchObject({ docstatus: 1, customer: 'Ravi', is_return: 1 });
    expect((cn.items as Array<Record<string, unknown>>)[0]).toMatchObject({ qty: -1, rate: 1500 });

    await confirm('returned goods 800 to AM Motors', /Purchase return \(debit note\)[\s\S]*Supplier: AM Motors[\s\S]*800/);
    expect(docs('Purchase Invoice').at(-1)).toMatchObject({ docstatus: 1, supplier: 'AM Motors', is_return: 1 });

    await confirm('deposited 10000 cash in bank', /Cash ↔ bank transfer[\s\S]*To: Bank Account[\s\S]*10,000/);
    expect(docs('Journal Entry').at(-1)).toMatchObject({ docstatus: 1, voucher_type: 'Contra Entry' });
    expect(docs('Journal Entry').at(-1)!.accounts).toEqual([
      { account: 'Bank Account - AIL', debit_in_account_currency: 10000, credit_in_account_currency: 0 },
      { account: 'Cash - AIL', debit_in_account_currency: 0, credit_in_account_currency: 10000 },
    ]);
    await confirm('withdrew 3000 from bank', /Cash ↔ bank transfer[\s\S]*To: Cash[\s\S]*3,000/);
    expect(docs('Journal Entry').at(-1)!.accounts).toEqual([
      { account: 'Cash - AIL', debit_in_account_currency: 3000, credit_in_account_currency: 0 },
      { account: 'Bank Account - AIL', debit_in_account_currency: 0, credit_in_account_currency: 3000 },
    ]);

    // something it cannot read says so, instead of only repeating the menu
    const id = ++conv;
    await say('blah blah xyz', id);
    expect(cw().lastText(id)).toMatch(/didn't understand "blah blah xyz"[\s\S]*You can:/);
  });
});

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
    // tax rows copied from the template (ERPNext does not do this for API inserts)
    expect((pinv.taxes as Array<{ account_head: string; rate: number }>).map((t) => [t.account_head, t.rate])).toEqual([
      ['Input Tax CGST - AIL', 9],
      ['Input Tax SGST - AIL', 9],
    ]);
    expect(erp.docs.get('Supplier')!.has('Kerala Paper Mart Pvt Ltd')).toBe(true); // auto-created after confirmation
    expect(erp.files[0]!.attachTo).toEqual({ doctype: 'Purchase Invoice', name: posted.erpName });
    expect(cw.lastText(id)).toMatch(/Posted ✅/);
    const vm = await tenantDb(c.prisma, A.tenant.id).vendorMapping.findMany();
    expect(vm[0]).toMatchObject({ supplierName: 'Kerala Paper Mart Pvt Ltd', hits: 1 });
    // re-running the job is a no-op (idempotent)
    await postDraft(c, A.tenant.id, draft.id);
    expect(erp.docs.get('Purchase Invoice')!.size).toBe(1);
  });

  it('a bill whose tax template is missing in ERPNext goes to review with a clear reason', async () => {
    const id = ++conv;
    await sendBill(extractionBytes({ invoiceNo: 'NO-TPL-1' }), id, B);
    await drain(c);
    const draft = (await tenantDb(c.prisma, B.tenant.id).draft.findFirst({ where: { conversationId: id } }))!;
    await say('1', id, B);
    await drain(c);
    const after = await tenantDb(c.prisma, B.tenant.id).draft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.status).toBe('needs_review');
    expect(after.error).toMatch(/Tax template "Input GST In-state - .*" does not exist in ERPNext/);
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

  it('a foreign-currency expense asks for the amount actually charged, then posts in the business currency', async () => {
    const id = ++conv;
    await say('paid 20USD for Google Gemini API Charges from Credit Card date : 15/11/2026', id);
    expect(c.cws.get(A.tenant.id)!.lastText(id)).toMatch(/amount in INR that was charged for USD 20/);
    await say('1712.40', id);
    const draft = (await tenantDb(c.prisma, A.tenant.id).draft.findFirst({ where: { conversationId: id } }))!;
    const p = draft.payload as { total: number; currency: string; date: string; paymentMode: string; remarks: string };
    expect(p).toMatchObject({ total: 1712.4, currency: 'INR', date: '2026-11-15', paymentMode: 'card' });
    expect(p.remarks).toMatch(/google gemini api charges \(USD 20\)/);
  });

  it('picks the expense account from the real chart: rule, then AI from the list, shown in the summary and editable', async () => {
    const T = await createTenant(c.prisma, { settings: { companyAbbr: 'TT' } });
    const erp = c.erp(T.tenant) as unknown as { create: (d: string, x: Record<string, unknown>) => Promise<unknown> };
    for (const name of ['Miscellaneous Expenses - TT', 'Software Subscriptions - TT', 'Legal Expenses - TT', 'Staff Welfare Expenses - TT']) {
      await erp.create('Account', { name, company: `Co ${T.tenant.slug}`, is_group: 0, root_type: 'Expense', account_type: '' });
    }
    await erp.create('Account', { name: 'Cost of Goods Sold - TT', company: `Co ${T.tenant.slug}`, is_group: 0, root_type: 'Expense', account_type: 'Cost of Goods Sold' });
    const llm = c.ai.llm;
    const offered: string[][] = [];
    c.ai.llm = Object.assign(Object.create(llm), {
      chooseAccount: async (_d: string, ledgers: string[]) => {
        offered.push(ledgers);
        return { account: 'Staff Welfare Expenses - TT', usage: { tokens: 10, costMicros: 1 } };
      },
    });
    try {
      const sayT = (text: string, id: number) => postCw(app, cwMessage({ inboxId: T.tenant.cwInboxId!, phone: T.owner.phone!, content: text, conversationId: id }));
      const id = ++conv;
      await sayT('paid 1700 for google gemini api charges', id);
      const cw = c.cws.get(T.tenant.id)!;
      expect(cw.lastText(id)).toMatch(/Account: Software Subscriptions/); // keyword rule, existing ledger
      expect(offered).toHaveLength(0);

      const id2 = ++conv;
      await sayT('paid 900 for team outing', id2);
      expect(cw.lastText(id2)).toMatch(/Account: Staff Welfare Expenses/); // AI pick from the real list
      expect(offered[0]).not.toContain('Cost of Goods Sold - TT'); // not a bill target
      expect(offered[0]).toContain('Legal Expenses - TT');

      await sayT('2', id2);
      await sayT('account legal', id2);
      expect(cw.lastText(id2)).toMatch(/Account: Legal Expenses/);
      await sayT('account yacht', id2);
      expect(cw.lastText(id2)).toMatch(/couldn't find an expense account called "yacht"[\s\S]*Software Subscriptions/);
    } finally {
      c.ai.llm = llm;
    }
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

describe('unreadable bills are never dropped', () => {
  it('detects the real file type from the bytes', () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'application/octet-stream')).toBe('image/jpeg');
    expect(sniffMime(new TextEncoder().encode('%PDF-1.7'), 'image/jpeg')).toBe('application/pdf');
    expect(sniffMime(new Uint8Array([1, 2, 3]), 'image/jpg')).toBe('image/jpeg');
    expect(sniffMime(new TextEncoder().encode('\0\0\0\x18ftypheic'), 'image/heic')).toBeUndefined();
  });

  it('asks for a JPG/PDF when the file type cannot be read (e.g. HEIC)', async () => {
    const id = ++conv;
    const url = `https://app.aiingo.com/rails/active_storage/${Math.random()}.heic`;
    c.chatwoot(A.tenant);
    c.cws.get(A.tenant.id)!.attachments.set(url, { content: new TextEncoder().encode('\0\0\0\x18ftypheic....'), mime: 'image/heic' });
    await postCw(app, cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, attachments: [{ file_type: 'image', data_url: url }], conversationId: id }));
    await drain(c);
    expect(c.cws.get(A.tenant.id)!.lastText(id)).toMatch(/JPG or PNG\) or a PDF/);
    expect(await tenantDb(c.prisma, A.tenant.id).draft.findFirst({ where: { conversationId: id } })).toBeNull();
  });

  it('a bill the AI cannot read goes to review instead of disappearing; outages are retried', async () => {
    const vision = c.ai.vision;
    try {
      c.ai.vision = { name: 'broken', extract: async () => Promise.reject(Object.assign(new Error('invalid image'), { status: 400 })) };
      const id = ++conv;
      await sendBill(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), id);
      await drain(c);
      const draft = (await tenantDb(c.prisma, A.tenant.id).draft.findFirst({ where: { conversationId: id } }))!;
      expect(draft.status).toBe('needs_review');
      expect((draft.payload as { validationIssues: string[] }).validationIssues.join(' ')).toMatch(/Could not be read automatically/);
      expect(c.cws.get(A.tenant.id)!.lastText(id)).toMatch(/accountant will double-check/);

      c.ai.vision = { name: 'down', extract: async () => Promise.reject(Object.assign(new Error('overloaded'), { status: 529 })) };
      const id2 = ++conv;
      await sendBill(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 9]), id2);
      const job = c.queue.jobs.find((j) => j.name === 'ocr.process')!;
      c.queue.jobs = [];
      await expect(processOcr(c, job.data as never)).rejects.toThrow('overloaded'); // left for BullMQ to retry
    } finally {
      c.ai.vision = vision;
    }
  });
});
