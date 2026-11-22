import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { hmacSha256 } from '../src/lib/crypto.js';
import { tenantDb, withSystemTx } from '../src/lib/db.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { sendInvoice, sendReminder } from '../src/modules/outbound/jobs.js';
import { closeShared, createTenant, testContainer } from './helpers.js';

const c = testContainer();
let app: FastifyInstance;
let A: Awaited<ReturnType<typeof createTenant>>;
let tok: string;
type Fake = { create: (d: string, x: Record<string, unknown>) => Promise<unknown>; docs: Map<string, Map<string, Record<string, unknown>>> };
const erpA = () => c.erp(A.tenant) as unknown as Fake;
const fresh = async () => withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: A.tenant.id } }));
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  await seed(c.prisma);
  A = await createTenant(c.prisma, { settings: { companyAbbr: 'AIL' } });
  await erpA().create('Account', { name: 'Bank Accounts - AIL', account_name: 'Bank Accounts', company: `Co ${A.tenant.slug}`, is_group: 1, root_type: 'Asset', account_type: 'Bank', parent_account: 'Current Assets - AIL' });
  await erpA().create('Customer', { name: 'Ravi Traders', customer_name: 'Ravi Traders', mobile_no: '+919812345678' });
  await erpA().create('Sales Invoice', { name: 'SINV-0041', customer: 'Ravi Traders', grand_total: 5000, outstanding_amount: 5000, due_date: '2026-11-30', currency: 'INR', docstatus: 1 });
  erpA().docs.get('Sales Invoice')!.get('SINV-0041')!.docstatus = 1; // submitted
  app = await buildApp(c);
  tok = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'owner', typ: 'app' });
});
afterAll(async () => {
  await app.close();
  await closeShared();
});

describe('Razorpay payment links', () => {
  let webhookSecret = '';

  it('connects only valid keys, owner only, India only, and sets ERPNext up', async () => {
    const staff = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'staff', typ: 'app' });
    expect((await app.inject({ method: 'POST', url: '/v1/payments/razorpay', headers: auth(staff), payload: { keyId: 'rzp_test_abc12345', keySecret: 'secret123456' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/payments/razorpay', headers: auth(tok), payload: { keyId: 'not-a-key-1', keySecret: 'secret123456' } })).statusCode).toBe(400);

    const uae = await createTenant(c.prisma, { country: 'AE', currency: 'AED' });
    const uaeTok = await signAccess({ sub: uae.owner.id, tid: uae.tenant.id, role: 'owner', typ: 'app' });
    const refused = await app.inject({ method: 'POST', url: '/v1/payments/razorpay', headers: auth(uaeTok), payload: { keyId: 'rzp_test_abc12345', keySecret: 'secret123456' } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toMatch(/Indian rupees/);

    const res = await app.inject({ method: 'POST', url: '/v1/payments/razorpay', headers: auth(tok), payload: { keyId: 'rzp_test_abc12345', keySecret: 'secret123456' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    webhookSecret = body.webhook.secret;
    expect(body.webhook.url).toMatch(new RegExp(`/webhooks/razorpay/${A.tenant.slug}$`));
    expect(body.erp).toEqual({ ledger: 'Razorpay Clearing - AIL', modeOfPayment: 'Razorpay', razorpaySettings: 'not_installed' });
    expect(erpA().docs.get('Account')!.get('Razorpay Clearing - AIL')).toMatchObject({ parent_account: 'Bank Accounts - AIL', account_type: 'Bank', is_group: 0 });
    expect(erpA().docs.get('Mode of Payment')!.get('Razorpay')).toMatchObject({ type: 'Bank', accounts: [{ company: `Co ${A.tenant.slug}`, default_account: 'Razorpay Clearing - AIL' }] });

    const t = await fresh();
    expect(t.rzpKeyId).toBe('rzp_test_abc12345');
    expect(t.rzpKeySecretEnc).not.toContain('secret123456'); // sealed
    const status = (await app.inject({ method: 'GET', url: '/v1/payments/razorpay', headers: auth(tok) })).json();
    expect(status).toMatchObject({ available: true, connected: true, mode: 'test', account: 'Razorpay Clearing - AIL', modeOfPayment: 'Razorpay' });
    expect(JSON.stringify(status)).not.toContain('secret123456');
  });

  it('fills in ERPNext Razorpay Settings when the payments app is installed, and rejects keys Razorpay refuses', async () => {
    const B = await createTenant(c.prisma, { settings: { companyAbbr: 'BB' } });
    const erpB = c.erp(B.tenant) as unknown as Fake;
    await erpB.create('Account', { name: 'Bank Accounts - BB', account_name: 'Bank Accounts', company: `Co ${B.tenant.slug}`, is_group: 1, root_type: 'Asset', account_type: 'Bank' });
    await erpB.create('Razorpay Settings', { name: 'Razorpay Settings' });
    const tokB = await signAccess({ sub: B.owner.id, tid: B.tenant.id, role: 'owner', typ: 'app' });
    const ok = await app.inject({ method: 'POST', url: '/v1/payments/razorpay', headers: auth(tokB), payload: { keyId: 'rzp_live_xyz98765', keySecret: 'livesecret987' } });
    expect(ok.json().erp.razorpaySettings).toBe('updated');
    expect(erpB.docs.get('Razorpay Settings')!.get('Razorpay Settings')).toMatchObject({ api_key: 'rzp_live_xyz98765', api_secret: 'livesecret987' });

    const C = await createTenant(c.prisma);
    c.rzps.set(C.tenant.id, Object.assign(new (c.rzps.get(B.tenant.id)!.constructor as new () => never)(), { invalidKeys: true }));
    const tokC = await signAccess({ sub: C.owner.id, tid: C.tenant.id, role: 'owner', typ: 'app' });
    const bad = await app.inject({ method: 'POST', url: '/v1/payments/razorpay', headers: auth(tokC), payload: { keyId: 'rzp_live_wrong123', keySecret: 'wrongsecret1' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/did not accept these keys/);
  });

  it('adds the link to invoices and reminders, reuses it, and uses the link template once approved', async () => {
    const tenant = await fresh();
    expect(await sendInvoice(c, { tenantId: tenant.id, invoiceName: 'SINV-0041' })).toEqual({ sent: true });
    const rzp = c.rzps.get(tenant.id)!;
    expect([...rzp.links.values()]).toEqual([expect.objectContaining({ referenceId: 'SINV-0041', amount: 5000, currency: 'INR', customer: { name: 'Ravi Traders', contact: '+919812345678' } })]);
    const sent = c.cws.get(tenant.id)!.sent;
    const invMsg = sent.find((m) => m.kind === 'template')!;
    // the link template isn't approved yet → the approved invoice template; the text carries the link
    expect(invMsg.template).toMatchObject({ name: 'nextai_invoice', params: ['Ravi Traders', tenant.name, 'SINV-0041', '₹5,000.00', '2026-11-30'] });
    expect(invMsg.content).toMatch(/Pay online: https:\/\/rzp\.io\/i\/plink_1/);

    await c.prisma.messageTemplate.update({ where: { key_language: { key: 'reminder_pay', language: 'en' } }, data: { approved: true } });
    try {
      await sendReminder(c, { tenantId: tenant.id, invoiceName: 'SINV-0041' });
    } finally {
      await c.prisma.messageTemplate.update({ where: { key_language: { key: 'reminder_pay', language: 'en' } }, data: { approved: false } });
    }
    const rem = sent.filter((m) => m.kind === 'template').at(-1)!;
    expect(rem.template).toMatchObject({ name: 'nextai_payment_reminder_pay', params: ['Ravi Traders', tenant.name, '₹5,000.00', 'SINV-0041', '2026-11-30', 'https://rzp.io/i/plink_1'] });
    expect(rzp.links.size).toBe(1); // same amount → same link

    // part payment elsewhere: a new link for what's left, the old one cancelled
    erpA().docs.get('Sales Invoice')!.get('SINV-0041')!.outstanding_amount = 3000;
    const res = await app.inject({ method: 'POST', url: '/v1/invoices/SINV-0041/payment-link', headers: auth(tok) });
    expect(res.json()).toEqual({ url: 'https://rzp.io/i/plink_2', amount: 3000 });
    expect(rzp.links.get('plink_1')!.status).toBe('cancelled');
    expect(rzp.links.get('plink_2')).toMatchObject({ referenceId: 'SINV-0041-2', amount: 3000 });
  });

  it('records a paid link as a Payment Entry against the invoice, once, and tells the owner', async () => {
    const tenant = await fresh();
    const body = JSON.stringify({
      event: 'payment_link.paid',
      payload: { payment_link: { entity: { id: 'plink_2', status: 'paid' } }, payment: { entity: { id: 'pay_N1', amount: 300000, method: 'upi' } } },
    });
    const post = (sig: string) =>
      app.inject({ method: 'POST', url: `/webhooks/razorpay/${tenant.slug}`, payload: body, headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_1' } });
    expect((await post('0'.repeat(64))).statusCode).toBe(401);
    const ok = await post(hmacSha256(webhookSecret, body));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'recorded' });

    const pe = [...erpA().docs.get('Payment Entry')!.values()].at(-1)!;
    expect(pe).toMatchObject({
      docstatus: 1,
      payment_type: 'Receive',
      party_type: 'Customer',
      party: 'Ravi Traders',
      paid_to: 'Razorpay Clearing - AIL',
      mode_of_payment: 'Razorpay',
      paid_amount: 3000,
      reference_no: 'pay_N1',
      references: [{ reference_doctype: 'Sales Invoice', reference_name: 'SINV-0041', allocated_amount: 3000 }],
    });
    const link = await tenantDb(c.prisma, tenant.id).paymentLink.findUnique({ where: { providerId: 'plink_2' } });
    expect(link).toMatchObject({ status: 'paid', paymentId: 'pay_N1', erpPaymentEntry: pe.name });
    expect(c.queue.jobs.some((j) => j.name === 'outbound.receipt' && (j.data as unknown as { paymentName: string }).paymentName === pe.name)).toBe(true);
    expect(c.cws.get(tenant.id)!.sent.at(-1)!.content).toMatch(/Ravi Traders paid ₹3,000.00 online for invoice SINV-0041/);

    expect((await post(hmacSha256(webhookSecret, body))).json()).toEqual({ status: 'duplicate' });
    expect([...erpA().docs.get('Payment Entry')!.values()].filter((p) => p.reference_no === 'pay_N1')).toHaveLength(1);
  });
});
