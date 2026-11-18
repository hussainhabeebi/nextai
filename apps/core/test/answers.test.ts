import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { parsePeriod, parseQuestion } from '../src/ai/question.js';
import { ruleClassify } from '../src/ai/rules.js';
import { erpContext } from '../src/modules/erpnext/mappers.js';
import { localDate } from '../src/modules/outbound/time.js';
import { closeShared, createTenant, testContainer } from './helpers.js';
import { cwMessage, postCw } from './webhook-helpers.js';

const TODAY = '2026-11-18';
const ask = (text: string) => parseQuestion(text, TODAY, 'IN');

describe('reading questions about the books', () => {
  it('finds the topic and the period', () => {
    expect(ask('how much sales is Today')).toMatchObject({ topic: 'sales', period: { from: TODAY, to: TODAY, explicit: true } });
    expect(ask('today sales')).toMatchObject({ topic: 'sales', period: { from: TODAY } });
    expect(ask('what are my expenses last month')).toMatchObject({ topic: 'expenses', period: { from: '2026-10-01', to: '2026-10-31' } });
    expect(ask('expenses in october')).toMatchObject({ topic: 'expenses', period: { from: '2026-10-01', to: '2026-10-31' } });
    expect(ask('sales last 7 days')).toMatchObject({ topic: 'sales', period: { from: '2026-11-12', to: TODAY } });
    expect(ask('purchases last week')).toMatchObject({ topic: 'purchases', period: { from: '2026-11-09', to: '2026-11-15' } });
    expect(ask('sales on 15/11')).toMatchObject({ topic: 'sales', period: { from: '2026-11-15', to: '2026-11-15' } });
    expect(ask('profit')).toMatchObject({ topic: 'profit', period: { from: '2026-04-01', to: TODAY, explicit: false } });
    expect(ask('did I make a loss last month?')).toMatchObject({ topic: 'profit', period: { from: '2026-10-01' } });
    expect(ask('who owes me')?.topic).toBe('receivables');
    expect(ask('how much do customers owe me?')?.topic).toBe('receivables');
    expect(ask('how much do I owe suppliers')?.topic).toBe('payables');
    expect(ask('cash in hand')?.topic).toBe('cash');
    expect(ask('bank balance')?.topic).toBe('cash');
    expect(ask('collections yesterday')).toMatchObject({ topic: 'received', period: { from: '2026-11-17' } });
    expect(ask('top customers this month')?.topic).toBe('top_customers');
    expect(ask('unpaid invoices')?.topic).toBe('unpaid_invoices');
    expect(ask('bills to pay')?.topic).toBe('unpaid_bills');
    expect(ask('gst payable this month')?.topic).toBe('tax');
    expect(ask('pending approvals')?.topic).toBe('pending');
    expect(ask('what did I spend on fuel this month')).toMatchObject({ topic: 'expenses', about: 'fuel' });
  });

  it('finds the customer or supplier a question is about (names may start with digits)', () => {
    expect(ask('how much does Ravi owe')).toMatchObject({ topic: 'party', party: 'ravi' });
    expect(ask('Hillora Tales balance')).toMatchObject({ topic: 'party', party: 'hillora tales' });
    expect(ask('ledger of 4L Fashion')).toMatchObject({ topic: 'party', party: '4l fashion' });
    expect(ask('how much did I pay AM Motors this month')).toMatchObject({ topic: 'paid', party: 'am motors' });
    expect(ask('sales to Hillora Tales this year')).toMatchObject({ topic: 'sales', party: 'hillora tales' });
    expect(ask('received from 4L fashion')).toMatchObject({ topic: 'received', party: '4l fashion' });
  });

  it('a money message is a transaction, a question is a question', () => {
    expect(ruleClassify('how much sales is Today', { today: TODAY })).toMatchObject({ intent: 'ask_books', confidence: 0.9 });
    expect(ruleClassify('sales today', { today: TODAY })?.intent).toBe('ask_books');
    expect(ruleClassify('payments to AM Motors last month', { today: TODAY })?.intent).toBe('ask_books');
    expect(ruleClassify('Ravi balance', { today: TODAY })?.intent).toBe('ask_books');
    expect(ruleClassify('sales 5000 ravi', { today: TODAY })?.intent).toBe('record_sale');
    expect(ruleClassify('Received Rs 6300 from 4L fashion', { today: TODAY })?.intent).toBe('payment_in');
    expect(ruleClassify('paid 500 for tea', { today: TODAY })?.intent).toBe('record_expense');
    expect(ruleClassify('report p&l last month', { today: TODAY })).toMatchObject({ intent: 'request_report', entities: { report: 'profit_and_loss', question: 'report p&l last month' } });
    expect(parsePeriod('in may', TODAY, 'IN')).toMatchObject({ from: '2026-05-01' });
    expect(parsePeriod('we may pay', TODAY, 'IN')).toBeUndefined(); // "may" the verb
  });
});

describe('answers and reports on WhatsApp, straight from ERPNext', () => {
  const c = testContainer();
  let app: FastifyInstance;
  let T: Awaited<ReturnType<typeof createTenant>>;
  let today: string;
  let conv = 15000;
  type Fake = { create: (d: string, x: Record<string, unknown>) => Promise<{ name: string }>; docs: Map<string, Map<string, Record<string, unknown>>>; reports: Record<string, unknown> };
  const reply = async (text: string) => {
    const id = ++conv;
    await postCw(app, cwMessage({ inboxId: T.tenant.cwInboxId!, phone: T.owner.phone!, content: text, conversationId: id }));
    return c.cws.get(T.tenant.id)!.lastText(id);
  };

  beforeAll(async () => {
    await seed(c.prisma);
    T = await createTenant(c.prisma, { name: 'Aiingo Technologies India LLP', settings: { companyAbbr: 'AIL', timezone: 'Asia/Kolkata' } });
    today = localDate('Asia/Kolkata');
    const month1 = `${today.slice(0, 8)}01`;
    const erp = c.erp(T.tenant) as unknown as Fake;
    const company = erpContext(T.tenant).company;
    const submitted = async (doctype: string, doc: Record<string, unknown>) => {
      const d = await erp.create(doctype, { company, ...doc });
      erp.docs.get(doctype)!.get(d.name)!.docstatus = 1;
    };
    for (const [name, root, type] of [
      ['Cash - AIL', 'Asset', 'Cash'], ['HDFC Bank - AIL', 'Asset', 'Bank'], ['Debtors - AIL', 'Asset', 'Receivable'],
      ['Sales - AIL', 'Income', ''], ['Rent - AIL', 'Expense', ''], ['Fuel Expenses - AIL', 'Expense', ''], ['Output Tax CGST - AIL', 'Liability', 'Tax'],
      ['Capital Account - AIL', 'Equity', ''],
    ] as const) {
      await erp.create('Account', { name, account_name: name.replace(/ - AIL$/, ''), company, is_group: 0, root_type: root, account_type: type });
    }
    const gl = (posting_date: string, account: string, debit: number, credit: number) =>
      erp.create('GL Entry', { company, is_cancelled: 0, posting_date, account, debit, credit });
    // today: two sales, rent and fuel paid, a payment received; earlier this month: capital
    await gl(month1, 'Cash - AIL', 50000, 0);
    await gl(month1, 'Capital Account - AIL', 0, 50000);
    await gl(today, 'Debtors - AIL', 11800, 0);
    await gl(today, 'Sales - AIL', 0, 10000);
    await gl(today, 'Output Tax CGST - AIL', 0, 1800);
    await gl(today, 'Rent - AIL', 15000, 0);
    await gl(today, 'Fuel Expenses - AIL', 500, 0);
    await gl(today, 'HDFC Bank - AIL', 0, 15500);
    await gl(today, 'HDFC Bank - AIL', 6300, 0);
    await gl(today, 'Debtors - AIL', 0, 6300);
    await submitted('Sales Invoice', { name: 'SINV-1', customer: 'Hillora Tales', base_grand_total: 8850, base_net_total: 7500, outstanding_amount: 8850, posting_date: today, due_date: '2026-10-24', is_return: 0 });
    await submitted('Sales Invoice', { name: 'SINV-2', customer: 'yuva enterprises', base_grand_total: 2950, base_net_total: 2500, outstanding_amount: 0, posting_date: today, due_date: today, is_return: 0 });
    await submitted('Payment Entry', { name: 'PE-1', payment_type: 'Receive', party: '4L fashion', base_paid_amount: 6300, posting_date: today, mode_of_payment: 'Bank Draft' });
    await erp.create('Customer', { name: 'Hillora Tales' });
    await erp.create('Customer', { name: 'yuva enterprises' });
    erp.reports['Accounts Receivable'] = {
      columns: [],
      result: [
        { party: 'Hillora Tales', outstanding: 8850, due_date: '2026-10-24', age: 25, range1: 8850 },
        { party: 'yuva enterprises', outstanding: 8850, due_date: '2026-10-27', age: 22, range1: 8850 },
        { party: 'yuva enterprises', outstanding: 7500, due_date: '2026-10-27', age: 22, range1: 7500 },
      ],
    };
    c.chatwoot(T.tenant);
    app = await buildApp(c);
  });
  afterAll(async () => {
    await app.close();
    await closeShared();
  });

  it('"how much sales is Today" gets today\'s sales, not the briefing', async () => {
    const text = await reply('how much sales is Today');
    expect(text).toMatch(/^📈 \*Sales · today \(.+\)\*\nSales: \*₹10,000.00\* · 2 invoices\nWith tax: ₹11,800.00 \(tax ₹1,800.00\)\nStill to collect: ₹8,850.00/);
    expect(text).toMatch(/\*By customer\*\n• Hillora Tales — ₹7,500.00\n• yuva enterprises — ₹2,500.00/);
    expect(text).not.toMatch(/☀️/);
  });

  it('expenses, profit, cash, money received', async () => {
    expect(await reply('expenses today')).toMatch(/💸 \*Expenses · today[^*]*\*\nTotal: \*₹15,500.00\*\n\n\*By account\*\n• Rent — ₹15,000.00\n• Fuel Expenses — ₹500.00/);
    expect(await reply('what did I spend on fuel this month')).toMatch(/Expenses on fuel · this month[\s\S]*Total: \*₹500.00\*/);
    const pl = await reply('profit this month');
    expect(pl).toMatch(/📊 \*Profit & Loss · this month[^*]*\*\nIncome: ₹10,000.00\nExpenses: ₹15,500.00\n🔻 Net loss: \*₹5,500.00\*/);
    expect(await reply('cash and bank balance')).toMatch(/🏦 \*Cash & bank · .+\*\nTotal: \*₹40,800.00\*\nCash: ₹50,000.00 · Bank: -₹9,200.00/);
    expect(await reply('payments received today')).toMatch(/💰 \*Money received · today[^*]*\*\nTotal: \*₹6,300.00\* · 1 payment\n\n\*By customer\*\n• 4L fashion — ₹6,300.00/);
    expect(await reply('gst payable this month')).toMatch(/🧮 \*GST · this month[^*]*\*\nNet GST payable: \*₹1,800.00\*/);
  });

  it('who owes me, one line per customer, and a customer\'s balance', async () => {
    const owed = await reply('who owes me?');
    expect(owed).toMatch(/💸 \*Customers owe you\*\nTotal: \*₹25,200.00\* · overdue ₹25,200.00\n\n• yuva enterprises — ₹16,350.00 \(22 days\)\n• Hillora Tales — ₹8,850.00 \(25 days\)/);
    expect(owed).toMatch(/Reply "remind yuva enterprises"/);
    const one = await reply('hillora tales balance');
    expect(one).toMatch(/👤 \*Hillora Tales\* \(customer\)\nOwes you: \*₹8,850.00\* · 1 unpaid invoice\nOverdue: ₹8,850.00[\s\S]*• SINV-1 · due 24 Oct — ₹8,850.00/);
    expect(await reply('balance of Nobody Here')).toMatch(/couldn't find "nobody here"/);
  });

  it('reports are laid out line by line, for the period asked', async () => {
    const pl = await reply('report p&l this month');
    expect(pl).toMatch(/📊 \*Profit & Loss · this month[\s\S]*\*Income\*\n• Sales — ₹10,000.00[\s\S]*\*Expenses\*\n• Rent — ₹15,000.00/);
    expect(pl).toMatch(/Full report: NextAi app → Reports\.$/);
    const bs = await reply('balance sheet');
    expect(bs).toMatch(/📒 \*Balance Sheet · as of .+\*\n\n\*Assets: ₹46,300.00\*/);
    expect(bs).toMatch(/\*Capital: ₹44,500.00\*\n• Capital Account — ₹50,000.00\n• Loss to date — -₹5,500.00/);
    expect(await reply('receivables report')).toMatch(/Customers owe you[\s\S]*yuva enterprises — ₹16,350.00/);
    expect(await reply('cash flow this month')).toMatch(/💧 \*Cash flow · this month[^*]*\*\nOpening cash & bank: ₹0.00\n\+ Received from customers: ₹6,300.00\n− Paid to suppliers: ₹0.00\n± Expenses, capital & other: ₹34,500.00\n\*Closing cash & bank: ₹40,800.00\*/);
  });

  it('a question it cannot place gets examples of what it can answer (no AI configured)', async () => {
    expect(await reply('what is the meaning of my books?')).toMatch(/I can answer questions about your books[\s\S]*Sales today/);
  });
});
