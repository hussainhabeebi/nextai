import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { tenantDb } from '../src/lib/db.js';
import { localHour, scanReminders, sendDailySummary, sendInvoice, sendReceipt, sendReminder } from '../src/modules/outbound/jobs.js';
import { closeShared, createTenant, drain, testContainer } from './helpers.js';
import { cwMessage, postCw } from './webhook-helpers.js';
import { jobHandlers } from '../src/jobs/handlers.js';
import { sendWhatsApp } from '../src/modules/outbound/whatsapp.js';

const c = testContainer();
let app: FastifyInstance;
let A: Awaited<ReturnType<typeof createTenant>>;
let conv = 20000;

beforeAll(async () => {
  await seed(c.prisma);
  A = await createTenant(c.prisma, { settings: { companyAbbr: 'AIL', timezone: 'Asia/Kolkata' } });
  app = await buildApp(c);
  const erp = c.erp(A.tenant) as unknown as { create: (d: string, x: Record<string, unknown>) => Promise<unknown> };
  await erp.create('Customer', { name: 'Ravi Traders', customer_name: 'Ravi Traders', mobile_no: '9847012345' });
});
beforeEach(() => {
  c.queue.jobs = [];
});
afterAll(async () => {
  await app.close();
  await closeShared();
});
const say = (text: string, conversationId: number) =>
  postCw(app, cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, content: text, conversationId }));

/** run all queued jobs including outbound ones */
async function drainAll() {
  const h = jobHandlers(c);
  while (c.queue.jobs.length) {
    const j = c.queue.jobs.shift()!;
    await h[j.name]?.(j.data);
  }
}

describe('sales → invoice PDF on WhatsApp', () => {
  it('posts a sales invoice from chat and sends the PDF to the customer via template', async () => {
    const id = ++conv;
    await say('sold 5000 to Ravi Traders', id);
    await say('1', id);
    await drainAll();
    const erp = c.erps.get(A.tenant.id)!;
    const si = [...erp.docs.get('Sales Invoice')!.values()][0]!;
    expect(si).toMatchObject({ customer: 'Ravi Traders', docstatus: 1 });
    const cw = c.cws.get(A.tenant.id)!;
    const tpl = cw.sent.find((m) => m.kind === 'template' && m.template?.name === 'nextai_invoice')!;
    expect(tpl.template!.params[0]).toBe('Ravi Traders');
    expect(cw.sent.some((m) => m.kind === 'file' && m.filename === `${si.name}.pdf`)).toBe(true);
    // second send is deduplicated
    expect(await sendInvoice(c, { tenantId: A.tenant.id, invoiceName: si.name as string })).toEqual({ skipped: 'already_sent' });
    const usage = await tenantDb(c.prisma, A.tenant.id).usageCounter.findFirst();
    expect(usage?.invoicesSent).toBe(1);
  });
});

describe('payments', () => {
  it('records payment received and sends a receipt', async () => {
    const id = ++conv;
    await say('Ravi Traders paid 2000', id);
    await say('1', id);
    await drain(c);
    const erp = c.erps.get(A.tenant.id)!;
    const pe = [...erp.docs.get('Payment Entry')!.values()][0]!;
    expect(pe).toMatchObject({ payment_type: 'Receive', party_type: 'Customer', party: 'Ravi Traders', paid_amount: 2000, docstatus: 1, paid_to: 'Cash - AIL' }); // no mode mentioned → cash
    expect(await sendReceipt(c, { tenantId: A.tenant.id, paymentName: pe.name as string })).toEqual({ sent: true });
    expect(c.cws.get(A.tenant.id)!.sent.some((m) => m.template?.name === 'nextai_receipt')).toBe(true);
  });
});

describe('reminders', () => {
  it('sends a reminder on request and rate-limits repeats', async () => {
    const erp = c.erps.get(A.tenant.id)!;
    const si = [...erp.docs.get('Sales Invoice')!.values()][0]!;
    Object.assign(si, { outstanding_amount: 3000, grand_total: 5000, due_date: '2026-10-01' });
    const id = ++conv;
    await say('remind Ravi Traders', id);
    await drainAll();
    const cw = c.cws.get(A.tenant.id)!;
    expect(cw.sent.filter((m) => m.template?.name === 'nextai_payment_reminder')).toHaveLength(1);
    expect(cw.lastText(id)).toMatch(/Sent 1 reminder to Ravi Traders/);
    const again = await sendReminder(c, { tenantId: A.tenant.id, party: 'Ravi', conversationId: id });
    expect(again).toEqual({ sent: 0, recent: 1 });
    expect(cw.lastText(id)).toMatch(/Already reminded about .* I wait 20 hours/);
  });

  it('without a WhatsApp number, explains why and hands the owner a ready reminder to forward', async () => {
    const erp = c.erp(A.tenant) as unknown as { create: (d: string, x: Record<string, unknown>) => Promise<{ name: string }>; docs: Map<string, Map<string, Record<string, unknown>>> };
    await erp.create('Customer', { name: 'Nexora Academy', customer_name: 'Nexora Academy' });
    const si = await erp.create('Sales Invoice', { customer: 'Nexora Academy', grand_total: 41300, outstanding_amount: 41300, due_date: '2026-10-20', currency: 'INR' });
    erp.docs.get('Sales Invoice')!.get(si.name)!.docstatus = 1;
    const id = ++conv;
    expect(await sendReminder(c, { tenantId: A.tenant.id, party: 'Nexora', conversationId: id })).toEqual({ sent: 0, noPhone: 1 });
    const texts = c.cws.get(A.tenant.id)!.sent.filter((m) => m.conversationId === id).map((m) => m.content);
    expect(texts[0]).toMatch(/No WhatsApp number on file for Nexora Academy[\s\S]*ready reminder below[\s\S]*Customer → Mobile No/);
    expect(texts[1]).toMatch(/Hi Nexora Academy 👋[\s\S]*friendly payment reminder from \*.+\*[\s\S]*🧾 Invoice \*.+\*\n💰 Amount due: \*₹41,300.00\*\n📅 Due date: 20 Oct 2026 \(\d+ days overdue\)/);
  });

  it('scans invoices due per configured offsets in tenant timezone', async () => {
    const erp = c.erps.get(A.tenant.id)!;
    const si = [...erp.docs.get('Sales Invoice')!.values()][0]!;
    const at = new Date('2026-11-10T04:30:00Z'); // 10:00 IST
    expect(localHour('Asia/Kolkata', at)).toBe(10);
    si.due_date = '2026-11-03'; // 7 days overdue → matches default offset 7
    expect(await scanReminders(c, A.tenant, at)).toBe(1);
    expect(c.queue.take('outbound.reminder')[0]!.data).toMatchObject({ tenantId: A.tenant.id, invoiceName: si.name });
    si.due_date = '2026-11-05';
    expect(await scanReminders(c, A.tenant, at)).toBe(0);
  });
});

describe('daily summary', () => {
  it('sends owners an evening summary: plain text inside the 24h window, the template outside it', async () => {
    const cw = c.cws.get(A.tenant.id)!;
    // The owner wrote today (earlier tests), so plain text is allowed and always delivers.
    const before = cw.sent.length;
    await sendDailySummary(c, A.tenant);
    expect(cw.sent.slice(before).some((m) => m.kind === 'text')).toBe(true);
    expect(cw.sent.slice(before).some((m) => m.kind === 'template')).toBe(false);

    await c.redis.del(`wa:window:${A.tenant.id}:${A.owner.phone}`);
    await c.redis.del(`summary:${A.tenant.id}:${new Date().toISOString().slice(0, 10)}`);
    const vars = await sendDailySummary(c, A.tenant);
    expect(vars.pending).toBeDefined();
    const sent = cw.sent.filter((m) => m.template?.name === 'nextai_daily_summary');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.template!.params[2]).toMatch(/5,05,000/); // cash 25000 + bank 480000 from fake balances
  });
});

describe('outbound conversation reuse', () => {
  it('sends to the same conversation for the same phone instead of opening a new one', async () => {
    const opts = { kind: 'notice' as const, phone: '+919800000001', name: 'Reuse test', templateKey: 'connection_test', params: [], fallbackText: 'hello' };
    const first = await sendWhatsApp(c, A.tenant, opts);
    const second = await sendWhatsApp(c, A.tenant, { ...opts, fallbackText: 'again' });
    expect(second.conversationId).toBe(first.conversationId);
  });
});
