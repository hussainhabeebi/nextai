import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { withSystemTx } from '../src/lib/db.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { billingSync } from '../src/modules/billing/service.js';
import { incrementUsage } from '../src/modules/usage/usage.js';
import { closeShared, createTenant, testContainer } from './helpers.js';
import { cwMessage, postCw } from './webhook-helpers.js';

const c = testContainer();
let app: FastifyInstance;
let A: Awaited<ReturnType<typeof createTenant>>;
let owner: string;
const tenantOf = () => withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: A.tenant.id }, include: { plan: true } }));
let n = 0;
const hook = (evt: Record<string, unknown>, sig = 'valid') =>
  app.inject({ method: 'POST', url: '/webhooks/stripe', payload: JSON.stringify({ eventId: `evt_${++n}_${Date.now()}`, ...evt }), headers: { 'content-type': 'application/json', 'stripe-signature': sig } });

beforeAll(async () => {
  await seed(c.prisma);
  await c.prisma.plan.update({ where: { code: 'pro' }, data: { providerPriceIds: { stripe: { INR: 'price_pro_inr', AED: 'price_pro_aed' } } } });
  A = await createTenant(c.prisma);
  await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: A.tenant.id }, data: { status: 'trial', trialEndsAt: new Date(Date.now() + 5 * 86400_000) } }));
  owner = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'owner', typ: 'app' });
  app = await buildApp(c);
});
afterAll(async () => {
  await app.close();
  await closeShared();
});

describe('Stripe billing', () => {
  it('creates a checkout with the remaining trial and the plan price for the tenant currency', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/billing/checkout', headers: { authorization: `Bearer ${owner}` }, payload: { plan: 'pro' } });
    expect(r.json().url).toMatch(/checkout\.stripe\.test/);
    expect(c.payments.checkouts[0]).toMatchObject({ tenantId: A.tenant.id, priceId: 'price_pro_inr', trialDays: 5 });
    const staff = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'staff', typ: 'app' });
    expect((await app.inject({ method: 'POST', url: '/v1/billing/checkout', headers: { authorization: `Bearer ${staff}` }, payload: { plan: 'pro' } })).statusCode).toBe(403);
  });

  it('rejects bad signatures and is idempotent by event id', async () => {
    expect((await hook({ kind: 'invoice_paid', customerId: 'cus_x' }, 'bad')).statusCode).toBe(400);
    const body = JSON.stringify({ eventId: 'evt_dup', kind: 'checkout_completed', tenantId: A.tenant.id, customerId: `cus_${A.tenant.id.slice(0, 8)}`, subscriptionId: 'sub_1' });
    const send = () => app.inject({ method: 'POST', url: '/webhooks/stripe', payload: body, headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' } });
    expect((await send()).json().status).toBe('linked');
    expect((await send()).json().status).toBe('duplicate');
  });

  it('drives the tenant lifecycle: active → past_due (+WhatsApp notice) → active → suspended', async () => {
    const customerId = `cus_${A.tenant.id.slice(0, 8)}`;
    const upd = (status: string) => hook({ kind: 'subscription_updated', customerId, subscriptionId: 'sub_1', status, priceId: 'price_pro_inr', cancelAtPeriodEnd: false, currentPeriodEnd: '2026-12-02T00:00:00Z' });
    expect((await upd('active')).json().status).toBe('active');
    let t = await tenantOf();
    expect(t.status).toBe('active');
    expect(t.plan?.code).toBe('pro');

    expect((await hook({ kind: 'invoice_payment_failed', customerId, subscriptionId: 'sub_1' })).json().status).toBe('past_due');
    expect((await tenantOf()).status).toBe('past_due');
    expect(c.cws.get(A.tenant.id)!.sent.some((m) => m.template?.name === 'nextai_billing_notice')).toBe(true);

    await hook({ kind: 'invoice_paid', customerId, subscriptionId: 'sub_1' });
    expect((await tenantOf()).status).toBe('active');

    await hook({ kind: 'subscription_deleted', customerId, subscriptionId: 'sub_1' });
    t = await tenantOf();
    expect(t.status).toBe('suspended');
    // suspended: bot replies with billing link; app is read-only
    await postCw(app, cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, content: 'paid 100 for tea', conversationId: 31 }));
    expect(c.cws.get(A.tenant.id)!.lastText(31)).toMatch(/suspended.*billing/);
    expect((await app.inject({ method: 'POST', url: '/v1/payments', headers: { authorization: `Bearer ${owner}` }, payload: { direction: 'in', party: 'X', amount: 1 } })).statusCode).toBe(402);
    expect((await app.inject({ method: 'GET', url: '/v1/billing', headers: { authorization: `Bearer ${owner}` } })).json().status).toBe('suspended');
    const logs = await withSystemTx(c.prisma, (tx) => tx.auditLog.findMany({ where: { tenantId: A.tenant.id, action: 'billing.status' } }));
    expect(logs.length).toBeGreaterThanOrEqual(4);
  });

  it('billing.sync expires trials and suspends after the past-due grace period', async () => {
    const B = await createTenant(c.prisma);
    await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: B.tenant.id }, data: { status: 'trial', trialEndsAt: new Date(Date.now() - 86400_000) } }));
    await billingSync(c);
    expect((await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: B.tenant.id } }))).status).toBe('past_due');
    await billingSync(c, new Date(Date.now() + 8 * 86400_000));
    expect((await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: B.tenant.id } }))).status).toBe('suspended');
  });
});

describe('plan gating on WhatsApp', () => {
  it('blocks bill scanning beyond the monthly OCR page limit', async () => {
    const G = await createTenant(c.prisma); // business plan: 500 pages
    await incrementUsage(c.prisma, G.tenant.id, { ocrPages: 500 });
    c.chatwoot(G.tenant);
    const url = 'https://app.aiingo.com/rails/active_storage/over.jpg';
    c.cws.get(G.tenant.id)!.attachments.set(url, { content: new TextEncoder().encode('x'), mime: 'image/jpeg' });
    const r = await postCw(app, cwMessage({ inboxId: G.tenant.cwInboxId!, phone: G.owner.phone!, attachments: [{ file_type: 'image', data_url: url }], conversationId: 55 }));
    expect(r.json().status).toBe('billing_blocked');
    expect(c.cws.get(G.tenant.id)!.lastText(55)).toMatch(/plan limit.*bill scanning/);
    expect(c.queue.jobs.filter((j) => j.name === 'ocr.process' && j.data.tenantId === G.tenant.id)).toHaveLength(0);
  });
});
