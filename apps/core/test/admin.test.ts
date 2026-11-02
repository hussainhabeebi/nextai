import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { withSystemTx } from '../src/lib/db.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { closeShared, createTenant, drain, extractionBytes, testContainer } from './helpers.js';
import { cwMessage, postCw } from './webhook-helpers.js';

const c = testContainer();
let app: FastifyInstance;
let A: Awaited<ReturnType<typeof createTenant>>;
const ADMIN = '00000000-0000-4000-8000-000000000001';
const tok = (prole: 'super_admin' | 'reviewer' | 'support') => signAccess({ sub: ADMIN, prole, typ: 'admin' });
const h = async (prole: 'super_admin' | 'reviewer' | 'support') => ({ authorization: `Bearer ${await tok(prole)}` });

beforeAll(async () => {
  await seed(c.prisma);
  A = await createTenant(c.prisma, { settings: { companyAbbr: 'AIL' } });
  app = await buildApp(c);
});
afterAll(async () => {
  await app.close();
  await closeShared();
});

describe('admin API', () => {
  it('enforces platform roles', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/v1/dashboard' })).statusCode).toBe(401);
    const appTok = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'owner', typ: 'app' });
    expect((await app.inject({ method: 'GET', url: '/admin/v1/dashboard', headers: { authorization: `Bearer ${appTok}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/v1/dashboard', headers: await h('support') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/admin/v1/provision', headers: await h('reviewer'), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/admin/v1/review-queue', headers: await h('support') })).statusCode).toBe(403);
  });

  it('review queue: reviewer edits a low-confidence bill, returns it to the bot, user confirms', async () => {
    const url = 'https://app.aiingo.com/rails/active_storage/low.jpg';
    c.chatwoot(A.tenant);
    c.cws.get(A.tenant.id)!.attachments.set(url, { content: extractionBytes({ confidence: 0.4, invoiceNo: 'REV-1', supplierTaxId: null, tax: { cgst: 0, sgst: 0, igst: 0, vat: 0 }, total: 2500 }), mime: 'image/jpeg' });
    await postCw(app, cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, attachments: [{ file_type: 'image', data_url: url }], conversationId: 4242 }));
    await drain(c);
    const q = await app.inject({ method: 'GET', url: '/admin/v1/review-queue', headers: await h('reviewer') });
    const item = q.json().items.find((d: { tenantId: string }) => d.tenantId === A.tenant.id);
    expect(item.status).toBe('needs_review');
    const detail = await app.inject({ method: 'GET', url: `/admin/v1/review-queue/${item.id}`, headers: await h('reviewer') });
    expect(detail.json().extracted.invoiceNo).toBe('REV-1');
    expect(detail.json().documentUrl).toContain(`tenants/${A.tenant.id}/`);
    await app.inject({ method: 'PATCH', url: `/admin/v1/review-queue/${item.id}`, headers: await h('reviewer'), payload: { expenseAccount: 'Office Maintenance Expenses - AIL' } });
    const ret = await app.inject({ method: 'POST', url: `/admin/v1/review-queue/${item.id}/return`, headers: await h('reviewer') });
    expect(ret.statusCode).toBe(200);
    expect(c.cws.get(A.tenant.id)!.lastText(4242)).toMatch(/Checked by your accountant/);
    await postCw(app, cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, content: '1', conversationId: 4242 }));
    await drain(c);
    const posted = await withSystemTx(c.prisma, (tx) => tx.draft.findUniqueOrThrow({ where: { id: item.id } }));
    expect(posted.status).toBe('posted');
    const logs = await withSystemTx(c.prisma, (tx) => tx.auditLog.findMany({ where: { entityId: item.id }, orderBy: { createdAt: 'asc' } }));
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['review.view', 'draft.edit', 'review.return', 'draft.confirm', 'draft.posted']));
  });

  it('provisions a tenant step by step through the whitelisted provisioner', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/v1/provision', headers: await h('super_admin'), payload: { name: 'Gulf Spice Trading LLC', slug: 'gulfspice', country: 'AE', currency: 'AED', ownerPhone: '0501234567', ownerName: 'Fatima' } });
    expect(res.statusCode).toBe(201);
    const id = res.json().tenantId;
    const run = async (step: string, payload: unknown = {}) => app.inject({ method: 'POST', url: `/admin/v1/provision/${id}/steps/${step}`, headers: await h('super_admin'), payload: payload as object });
    expect((await run('erp_site')).json().status).toBe('done');
    expect((await run('erp_api_user')).json().status).toBe('done');
    expect((await run('erp_company')).json().note).toMatch(/Gulf Spice Trading LLC \(GSTL\)/);
    expect((await run('test_connections')).statusCode).toBe(500); // chatwoot not mapped yet → step failed
    expect((await run('chatwoot_inbox', { chatwoot: { accountId: 1, inboxId: 987654, botToken: 'bot-token-xyz' } })).json().status).toBe('done');
    expect((await run('erp_webhooks')).json().status).toBe('manual');
    expect((await run('test_connections')).json().status).toBe('done');
    expect((await run('invite_owner')).json().status).toBe('done');
    expect(c.provisioner.ops.map((o) => o.op)).toEqual(['new-site', 'install-app', 'enable-scheduler', 'set-config', 'create-api-user']);
    const tn = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id } }));
    expect(tn.erpSiteUrl).toBe('https://gulfspice.nextaierp.com');
    expect(tn.erpApiKeyEnc).not.toContain('fake-key');
    const detail = await app.inject({ method: 'GET', url: `/admin/v1/tenants/${id}`, headers: await h('support') });
    expect(JSON.stringify(detail.json())).not.toMatch(/erpApiKeyEnc|cwBotTokenEnc|bot-token-xyz/);
    expect(detail.json().connections.chatwoot.configured).toBe(true);
  });

  it('impersonation is read-only and audited', async () => {
    const r = await app.inject({ method: 'POST', url: `/admin/v1/tenants/${A.tenant.id}/impersonate`, headers: await h('support') });
    const token = r.json().accessToken;
    const view = await app.inject({ method: 'GET', url: '/v1/drafts', headers: { authorization: `Bearer ${token}` } });
    expect(view.statusCode).toBe(200);
    const write = await app.inject({ method: 'POST', url: '/v1/payments', headers: { authorization: `Bearer ${token}` }, payload: { direction: 'in', party: 'X', amount: 1 } });
    expect(write.statusCode).toBe(403);
    const logs = await withSystemTx(c.prisma, (tx) => tx.auditLog.findMany({ where: { tenantId: A.tenant.id, action: { startsWith: 'impersonate' } } }));
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['impersonate.start', 'impersonate.view']));
  });

  it('suspends and resumes tenants with audit', async () => {
    await app.inject({ method: 'POST', url: `/admin/v1/tenants/${A.tenant.id}/suspend`, headers: await h('support') });
    expect((await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: A.tenant.id } }))).status).toBe('suspended');
    await app.inject({ method: 'POST', url: `/admin/v1/tenants/${A.tenant.id}/resume`, headers: await h('support') });
    const audit = await app.inject({ method: 'GET', url: `/admin/v1/audit?tenantId=${A.tenant.id}&action=tenant.`, headers: await h('support') });
    expect(audit.json().items.map((x: { action: string }) => x.action)).toEqual(['tenant.resume', 'tenant.suspend']);
  });
});
