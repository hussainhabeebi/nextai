import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { tenantDb } from '../src/lib/db.js';
import { parseBankSms, parseCsvStatement } from '../src/modules/banking/parse.js';
import { importStatement, namedIn } from '../src/modules/banking/service.js';
import { confirmDraft } from '../src/modules/drafts/service.js';
import { closeShared, createTenant, drain, testContainer } from './helpers.js';
import { cwMessage, postCw } from './webhook-helpers.js';

const HDFC = `HDFC BANK Ltd.
Account No : 50100012345678
Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
15/11/26,NEFT CR-HDFC0000001-RAVI TRADERS-NETBANK,0000452188,15/11/26,,"12,000.00","50,000.00"
15/11/26,UPI-KSEB-kseb@sbi-631245789012,0000631245,15/11/26,"3,200.00",,"46,800.00"
16/11/26,IMPS-AM MOTORS-SERVICE,0000771122,16/11/26,"8,000.00",,"38,800.00"
14/11/26,NEFT-GULF MART PAYMENT,FT123,14/11/26,,"1,500.00","40,300.00"
16/11/26,RAZORPAY SOFTWARE PVT LTD SETTLEMENT,0000999,16/11/26,,"2,941.00","43,241.00"
,,,,,,
Statement Summary,,,,"11,200.00","16,441.00",`;

describe('statement and SMS parsing', () => {
  it('reads bank CSV exports: header row found below account details, debit/credit or amount + Cr/Dr, Indian number format', () => {
    const lines = parseCsvStatement(HDFC);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toEqual({ date: '2026-11-15', amount: 12000, direction: 'in', description: 'NEFT CR-HDFC0000001-RAVI TRADERS-NETBANK', reference: '0000452188', balance: 50000 });
    expect(lines[1]).toMatchObject({ amount: 3200, direction: 'out' });
    expect(parseCsvStatement('Txn Date;Description;Amount;Cr/Dr;Balance\n2026-11-14;Transfer from GULF MART;1250.00;CR;8000\n2026-11-15;DEWA bill;-430.50;DR;7569.50')).toEqual([
      { date: '2026-11-14', amount: 1250, direction: 'in', description: 'Transfer from GULF MART', reference: undefined, balance: 8000 },
      { date: '2026-11-15', amount: 430.5, direction: 'out', description: 'DEWA bill', reference: undefined, balance: 7569.5 },
    ]);
    expect(parseCsvStatement('name,phone\nRavi,9812345678')).toEqual([]);
  });

  it('reads bank SMS and ignores ordinary chat', () => {
    const today = '2026-11-17';
    expect(parseBankSms('Rs.12,000.00 credited to A/c XX1234 on 15-11-26 by NEFT from RAVI TRADERS Ref No 4521889911. Avl Bal Rs 50,000.00 -HDFC Bank', today)).toEqual({ date: '2026-11-15', amount: 12000, direction: 'in', description: 'RAVI TRADERS', reference: '4521889911' });
    expect(parseBankSms('Your A/c XX5678 is debited with INR 3,200.00 on 15/11/2026 towards KSEB Electricity. UPI Ref 631245789012. -SBI', today)).toMatchObject({ amount: 3200, direction: 'out', description: 'KSEB Electricity', reference: '631245789012' });
    expect(parseBankSms('Dear Customer, Acct XX9012 debited for Rs 450.00 on 16-Nov-26; AMAZON PAY credited. UPI:631299998888.', today)).toMatchObject({ date: '2026-11-16', amount: 450, direction: 'out', description: 'AMAZON PAY', reference: '631299998888' });
    expect(parseBankSms('AED 1,250.00 has been credited to your account XXX4321 on 14/11/2026 from GULF MART LLC. Ref: FT2633401234', today)).toMatchObject({ amount: 1250, direction: 'in', description: 'GULF MART LLC' });
    for (const chat of ['paid 500 for tea', 'Ravi paid 2000 by bank', 'Received Rs 50000 Cash from Hussain capital account by cash', 'Create supplier account AM Motors', 'received Rs 12,000.00 from Ravi to bank account']) {
      expect(parseBankSms(chat, today)).toBeUndefined();
    }
  });

  it('finds the party in a narration', () => {
    expect(namedIn('Ravi Traders', 'NEFT CR-HDFC0000001-RAVI TRADERS-NETBANK')).toBe(true);
    expect(namedIn('Ravi Traders', 'NEFT CR-SURESH TRADERS')).toBe(false); // "traders" alone doesn't count
    expect(namedIn('AM Motors Pvt Ltd', 'IMPS-AMMOTORS-SERVICE')).toBe(true);
  });
});

describe('bank matching', () => {
  const c = testContainer();
  let app: FastifyInstance;
  let A: Awaited<ReturnType<typeof createTenant>>;
  type Fake = { create: (d: string, x: Record<string, unknown>) => Promise<unknown>; docs: Map<string, Map<string, Record<string, unknown>>> };
  const erp = () => c.erp(A.tenant) as unknown as Fake;
  const submitted = async (doctype: string, doc: Record<string, unknown>) => {
    await erp().create(doctype, doc);
    erp().docs.get(doctype)!.get(doc.name as string)!.docstatus = 1;
  };
  const say = (text: string, id: number) => postCw(app, cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, content: text, conversationId: id }));
  const cw = () => c.cws.get(A.tenant.id)!;

  beforeAll(async () => {
    await seed(c.prisma);
    A = await createTenant(c.prisma, { settings: { companyAbbr: 'AIL', paymentLinks: { account: 'Razorpay Clearing - AIL' } } });
    await submitted('Sales Invoice', { name: 'SINV-1', customer: 'Ravi Traders', outstanding_amount: 12000 });
    await submitted('Purchase Invoice', { name: 'PINV-1', supplier: 'AM Motors', outstanding_amount: 8000 });
    await submitted('Payment Entry', { name: 'PE-EXIST', party: 'Gulf Mart', payment_type: 'Receive', paid_amount: 1500, reference_no: 'FT123', posting_date: '2026-11-14' });
    c.chatwoot(A.tenant);
    app = await buildApp(c);
  });
  afterAll(async () => {
    await app.close();
    await closeShared();
  });

  it('a statement: already-recorded lines matched, invoices/bills and Razorpay settlements ready to approve, the rest asked', async () => {
    const r = await importStatement(c, A.tenant, { content: new TextEncoder().encode(HDFC), mime: 'text/csv', name: 'stmt.csv' }, { userId: A.owner.id });
    expect(r).toMatchObject({ lines: 5, duplicates: 0, recorded: 1, drafts: 3, toAsk: 1 });
    expect(r.text).toMatch(/Read 5 transactions[\s\S]*1 already in your books[\s\S]*3 matched to invoices\/bills: waiting in Approvals[\s\S]*1 need you: reply "bank"/);

    const db = tenantDb(c.prisma, A.tenant.id);
    const lines = await db.bankLine.findMany({ orderBy: { date: 'asc' } });
    expect(lines.find((l) => l.description.includes('GULF'))).toMatchObject({ status: 'matched', matchName: 'PE-EXIST' });
    expect(lines.find((l) => l.description.includes('KSEB'))).toMatchObject({ status: 'unmatched', draftId: null });
    const drafts = await db.draft.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' } });
    expect(drafts.map((d) => [d.type, (d.payload as { invoiceRef?: string }).invoiceRef ?? (d.payload as { remarks?: string }).remarks])).toEqual([
      ['payment_in', 'SINV-1'],
      ['payment_out', 'PINV-1'],
      ['journal_entry', 'Razorpay settlement to bank'],
    ]);

    // the same statement again: nothing new
    const again = await importStatement(c, A.tenant, { content: new TextEncoder().encode(HDFC), mime: 'text/csv' });
    expect(again).toMatchObject({ lines: 5, duplicates: 5, drafts: 0, toAsk: 0 });

    // approving the customer payment posts it against the invoice and marks the line matched
    await confirmDraft(c, A.tenant, drafts[0]!.id, { id: A.owner.id, type: 'user', channel: 'app' });
    await drain(c);
    const pe = [...erp().docs.get('Payment Entry')!.values()].at(-1)!;
    expect(pe).toMatchObject({ docstatus: 1, party: 'Ravi Traders', paid_amount: 12000, reference_no: '0000452188', references: [{ reference_doctype: 'Sales Invoice', reference_name: 'SINV-1', allocated_amount: 12000 }] });
    expect(await db.bankLine.findFirst({ where: { draftId: drafts[0]!.id } })).toMatchObject({ status: 'matched', matchName: pe.name });
  });

  it('asks about the rest on WhatsApp ("bank") and books the answer from the bank on that date', async () => {
    const id = 8101;
    await say('bank', id);
    expect(cw().lastText(id)).toMatch(/₹3,200.00 paid on 15 Nov\n“UPI-KSEB[\s\S]*what it was/);
    await say('electricity', id);
    expect(cw().lastText(id)).toMatch(/Expense[\s\S]*Paid by: bank[\s\S]*Date: 2026-11-15[\s\S]*3,200/);
    await say('1', id);
    await drain(c);
    const je = [...erp().docs.get('Journal Entry')!.values()].at(-1)!;
    expect(je).toMatchObject({ docstatus: 1, voucher_type: 'Bank Entry', posting_date: '2026-11-15' });
    await say('bank', id);
    expect(cw().lastText(id)).toMatch(/All bank lines are sorted/);
  });

  it('a forwarded SMS: matched to an open invoice to confirm, or asked about', async () => {
    await submitted('Sales Invoice', { name: 'SINV-2', customer: 'Kochi Bakers', outstanding_amount: 7000 });
    const id = 8102;
    await say('Rs.7,000.00 credited to A/c XX1234 on 16-11-26 by IMPS from KOCHI BAKERS Ref No 99887766. Avl Bal Rs 57,000.00', id);
    expect(cw().lastText(id)).toMatch(/Payment received[\s\S]*Customer: Kochi Bakers[\s\S]*For invoice: SINV-2[\s\S]*Bank ref: 99887766[\s\S]*1\. Confirm/);
    await say('3', id); // cancel → the line goes back to "needs an answer"

    const id2 = 8103;
    await say('Rs 5,000.00 credited to your A/c XX1234 on 17-11-26 from SHOP 24 UPI Ref 112233445566', id2);
    expect(cw().lastText(id2)).toMatch(/₹5,000.00 received on 17 Nov\n“SHOP 24”[\s\S]*who paid/);
    await say('Shop 24', id2);
    expect(cw().lastText(id2)).toMatch(/Payment received[\s\S]*Customer: Shop 24[\s\S]*Paid by: bank/);
    await say('1', id2);

    const id3 = 8104;
    await say('Rs.7,000.00 credited to A/c XX1234 on 16-11-26 by IMPS from KOCHI BAKERS Ref No 99887766. Avl Bal Rs 57,000.00', id3);
    expect(cw().lastText(id3)).toMatch(/already have this bank transaction/);
    await say('bank', id3);
    expect(cw().lastText(id3)).toMatch(/₹7,000.00 received on 16 Nov[\s\S]*Is it invoice SINV-2 \(Kochi Bakers\)\? Reply 1 for yes/);
    await say('skip', id3);
    expect(cw().lastText(id3)).toMatch(/All bank lines are sorted/);
  });

  it('app: upload a statement and list what needs an answer', async () => {
    const { signAccess } = await import('../src/modules/auth/tokens.js');
    const B = await createTenant(c.prisma);
    const tok = await signAccess({ sub: B.owner.id, tid: B.tenant.id, role: 'owner', typ: 'app' });
    const boundary = '----nxbank';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="statement.csv"\r\nContent-Type: text/csv\r\n\r\n`),
      Buffer.from('Date,Narration,Withdrawal,Deposit\n10/11/2026,Cash deposit,,2000\n11/11/2026,ATM withdrawal,500,\n'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({ method: 'POST', url: '/v1/bank/statement', payload: body, headers: { authorization: `Bearer ${tok}`, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ lines: 2, toAsk: 2 });
    const list = (await app.inject({ method: 'GET', url: '/v1/bank/lines', headers: { authorization: `Bearer ${tok}` } })).json();
    expect(list.items).toHaveLength(2);
    await app.inject({ method: 'POST', url: `/v1/bank/lines/${list.items[0].id}/ignore`, headers: { authorization: `Bearer ${tok}` } });
    expect((await app.inject({ method: 'GET', url: '/v1/bank/lines', headers: { authorization: `Bearer ${tok}` } })).json().items).toHaveLength(1);
  });
});
