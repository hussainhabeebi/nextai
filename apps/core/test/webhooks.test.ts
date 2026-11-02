import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { tenantDb, withSystemTx } from '../src/lib/db.js';
import { sealErpWebhookSecret } from '../src/modules/tenants/secrets.js';
import { closeShared, createTenant, testContainer } from './helpers.js';
import { cwMessage, postCw } from './webhook-helpers.js';
import { ipAllowed } from '../src/modules/webhooks/verify.js';

const c = testContainer();
let app: FastifyInstance;
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;

beforeAll(async () => {
  await seed(c.prisma);
  A = await createTenant(c.prisma);
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

describe('chatwoot webhook', () => {
  it('rejects invalid signatures and accepts the URL token form', async () => {
    const body = JSON.stringify(cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, content: 'hi' }));
    const bad = await app.inject({ method: 'POST', url: '/webhooks/chatwoot', payload: body, headers: { 'content-type': 'application/json', 'x-chatwoot-signature': 'sha256=00', 'x-chatwoot-timestamp': String(Math.floor(Date.now() / 1000)) } });
    expect(bad.statusCode).toBe(401);
    const none = await app.inject({ method: 'POST', url: '/webhooks/chatwoot', payload: body, headers: { 'content-type': 'application/json' } });
    expect(none.statusCode).toBe(401);
    const tok = await app.inject({ method: 'POST', url: `/webhooks/chatwoot?token=${process.env.CHATWOOT_WEBHOOK_SECRET}`, payload: body, headers: { 'content-type': 'application/json' } });
    expect(tok.statusCode).toBe(200);
  });

  it('enforces the source IP allowlist (incl. CIDR)', () => {
    expect(ipAllowed('10.1.2.3', ['10.1.0.0/16'])).toBe(true);
    expect(ipAllowed('10.2.2.3', ['10.1.0.0/16'])).toBe(false);
    expect(ipAllowed('::ffff:127.0.0.1', ['127.0.0.1'])).toBe(true);
  });

  it('routes by inbox, is idempotent by message id and ignores outgoing (loop guard)', async () => {
    const msg = cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, content: 'help', conversationId: 501 });
    expect((await postCw(app, msg)).json().status).toBe('text_handled');
    expect((await postCw(app, msg)).json().status).toBe('duplicate');
    expect(c.cws.get(A.tenant.id)!.sent.filter((m) => m.conversationId === 501)).toHaveLength(1);
    expect(c.cws.get(B.tenant.id)?.sent ?? []).toHaveLength(0);
    const out = cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, content: 'x', message_type: 'outgoing' });
    expect((await postCw(app, out)).json().status).toBe('ignored');
  });

  it('a phone registered on tenant B is unknown on tenant A inbox (no cross-tenant user resolution)', async () => {
    const msg = cwMessage({ inboxId: A.tenant.cwInboxId!, phone: B.owner.phone!, content: 'hi', conversationId: 777 });
    expect((await postCw(app, msg)).json().status).toBe('ignored_unknown_user');
    const again = cwMessage({ inboxId: A.tenant.cwInboxId!, phone: B.owner.phone!, content: 'hi again', conversationId: 777 });
    await postCw(app, again);
    expect(c.cws.get(A.tenant.id)!.sent.filter((m) => m.conversationId === 777)).toHaveLength(1); // onboarding sent once
  });

  it('stores attachments under the tenant R2 prefix, dedupes by sha256, enqueues jobs with tenantId', async () => {
    const url = 'https://app.aiingo.com/rails/active_storage/bill1.jpg';
    c.chatwoot(A.tenant); // init fake
    c.cws.get(A.tenant.id)!.attachments.set(url, { content: new TextEncoder().encode('bill-bytes-1'), mime: 'image/jpeg' });
    const msg = cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, attachments: [{ file_type: 'image', data_url: url }], conversationId: 600 });
    expect((await postCw(app, msg)).json().status).toBe('attachments_queued');
    const jobs = c.queue.take('ocr.process');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data.tenantId).toBe(A.tenant.id);
    const doc = await tenantDb(c.prisma, A.tenant.id).document.findUniqueOrThrow({ where: { id: jobs[0]!.data.documentId as string } });
    expect(doc.r2Key.startsWith(`tenants/${A.tenant.id}/docs/`)).toBe(true);
    expect(c.storage.objects.has(doc.r2Key)).toBe(true);

    const dup = cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, attachments: [{ file_type: 'image', data_url: url }], conversationId: 600 });
    await postCw(app, dup);
    expect(c.queue.take('ocr.process')).toHaveLength(0);
    expect(c.cws.get(A.tenant.id)!.lastText(600)).toMatch(/already recorded/);

    const voice = 'https://app.aiingo.com/rails/active_storage/v.ogg';
    c.cws.get(A.tenant.id)!.attachments.set(voice, { content: new TextEncoder().encode('paid 500 for tea'), mime: 'audio/ogg' });
    await postCw(app, cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, attachments: [{ file_type: 'audio', data_url: voice }] }));
    expect(c.queue.take('voice.process')[0]!.data.r2Key).toMatch(new RegExp(`^tenants/${A.tenant.id}/voice/`));
  });
});

describe('erpnext webhook', () => {
  it('verifies the per-tenant HMAC and enqueues outbound jobs idempotently', async () => {
    await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: A.tenant.id }, data: { erpWebhookSecretEnc: sealErpWebhookSecret(A.tenant.id, 'hook-secret') } }));
    const body = JSON.stringify({ doctype: 'Sales Invoice', name: 'SINV-0001', event: 'on_submit' });
    const sig = (s: string) => createHmac('sha256', s).update(body).digest('base64');
    const url = `/webhooks/erpnext/${A.tenant.slug}`;
    const bad = await app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json', 'x-frappe-webhook-signature': sig('wrong') } });
    expect(bad.statusCode).toBe(401);
    // B's slug with A's secret must fail
    const cross = await app.inject({ method: 'POST', url: `/webhooks/erpnext/${B.tenant.slug}`, payload: body, headers: { 'content-type': 'application/json', 'x-frappe-webhook-signature': sig('hook-secret') } });
    expect(cross.statusCode).toBe(404);
    const ok = await app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json', 'x-frappe-webhook-signature': sig('hook-secret') } });
    expect(ok.json().status).toBe('accepted');
    const dup = await app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json', 'x-frappe-webhook-signature': sig('hook-secret') } });
    expect(dup.json().status).toBe('duplicate');
    const jobs = c.queue.take('outbound.invoice');
    expect(jobs).toEqual([{ name: 'outbound.invoice', data: { tenantId: A.tenant.id, invoiceName: 'SINV-0001', source: 'erpnext' } }]);
  });
});
