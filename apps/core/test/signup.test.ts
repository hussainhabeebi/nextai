import { QUEUES } from '@nextai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { resetEnvCache } from '../src/config/env.js';
import { decrypt } from '../src/lib/crypto.js';
import { withSystemTx } from '../src/lib/db.js';
import { setupTenantErp, uniqueAbbr } from '../src/modules/erpnext/company-setup.js';
import { closeShared, createTenant, testContainer } from './helpers.js';

const c = testContainer();
let app: FastifyInstance;
const phone = () => `+9198${Math.floor(10000000 + Math.random() * 89999999)}`;
const body = (over: Record<string, unknown> = {}) => ({
  businessName: 'Kochi Spice Traders',
  ownerName: 'Anu Thomas',
  email: `anu.${Math.random().toString(36).slice(2, 8)}@example.com`,
  phone: phone(),
  country: 'IN',
  ...over,
});
const post = (url: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload, headers });

beforeAll(async () => {
  process.env.ADMIN_REPORT_EMAILS = 'ops@nextaierp.test';
  resetEnvCache();
  await seed(c.prisma);
  app = await buildApp(c);
});
afterEach(() => {
  delete process.env.ERPNEXT_SHARED_URL;
  delete process.env.ERPNEXT_SHARED_API_KEY;
  delete process.env.ERPNEXT_SHARED_API_SECRET;
  resetEnvCache();
});
afterAll(async () => {
  delete process.env.ADMIN_REPORT_EMAILS;
  resetEnvCache();
  await app.close();
  await closeShared();
});

describe('website self-signup', () => {
  it('emails a code and creates nothing until it is verified; then trial business + owner + ERPNext setup job', async () => {
    const b = body();
    const start = await post('/v1/signup', b);
    expect(start.statusCode).toBe(200);
    const { signupId, devCode } = start.json();
    expect(devCode).toMatch(/^\d{6}$/);
    const codeMail = c.mailer.sent.at(-1)!;
    expect(codeMail.to).toEqual([b.email]);
    expect(codeMail.subject).toBe(`${devCode} is your NextAi code`);
    expect(await withSystemTx(c.prisma, (tx) => tx.user.findFirst({ where: { email: b.email } }))).toBeNull();

    const wrong = await post('/v1/signup/verify', { signupId, code: devCode === '000000' ? '111111' : '000000' });
    expect(wrong.statusCode).toBe(400);

    c.queue.jobs = [];
    const ok = await post('/v1/signup/verify', { signupId, code: devCode });
    expect(ok.statusCode).toBe(200);
    const { tenantId, loginUrl } = ok.json();
    expect(loginUrl).toMatch(/\/login#t=[\w-]{20,}$/);

    const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { plan: true, users: true } }));
    expect(tenant).toMatchObject({ name: 'Kochi Spice Traders', country: 'IN', currency: 'INR', status: 'trial' });
    expect(tenant.slug).toMatch(/^kochi-spice-traders/);
    expect(tenant.plan?.code).toBe('growth');
    expect(tenant.trialEndsAt!.getTime()).toBeGreaterThan(Date.now() + 13 * 86400_000);
    expect(tenant.users[0]).toMatchObject({ role: 'owner', email: b.email, name: 'Anu Thomas', phone: b.phone });
    expect((tenant.settings as { signup?: { source: string } }).signup?.source).toBe('website');
    expect(c.queue.jobs.map((j) => [j.name, j.data])).toContainEqual([QUEUES.tenantSetup, { tenantId }]);
    expect(c.mailer.sent.some((m) => m.to[0] === b.email && m.subject === 'Welcome to NextAi')).toBe(true);
    expect(c.mailer.sent.some((m) => m.to[0] === 'ops@nextaierp.test' && m.subject === 'New NextAi signup: Kochi Spice Traders')).toBe(true);

    // single use
    expect((await post('/v1/signup/verify', { signupId, code: devCode })).statusCode).toBe(400);

    // the "open NextAi" link logs the owner in once
    const token = loginUrl.split('#t=')[1];
    const magic = await post('/v1/auth/magic', { token });
    expect(magic.statusCode).toBe(200);
    expect(magic.json()).toMatchObject({ tenantId, memberships: [{ tenantId, name: 'Kochi Spice Traders' }] });
    expect((await post('/v1/auth/magic', { token })).statusCode).toBe(401);

    // until WhatsApp is connected, login codes go by email
    const otp = await post('/v1/auth/otp/request', { phone: b.phone });
    expect(otp.json()).toMatchObject({ sent: true, channel: 'email' });
    expect(c.mailer.sent.at(-1)!.subject).toBe(`${otp.json().devCode} is your NextAi login code`);
    expect((await post('/v1/auth/otp/verify', { phone: b.phone, code: otp.json().devCode })).statusCode).toBe(200);
  });

  it('rejects a WhatsApp number that already has an account, and silently drops bots (honeypot)', async () => {
    const existing = await createTenant(c.prisma);
    const dup = await post('/v1/signup', body({ phone: existing.owner.phone }));
    expect(dup.statusCode).toBe(409);

    const before = c.mailer.sent.length;
    const bot = await post('/v1/signup', body({ website: 'http://spam.example' }));
    expect(bot.statusCode).toBe(200);
    expect(bot.json().devCode).toBeUndefined();
    expect(c.mailer.sent.length).toBe(before);
  });

  it('validates input and uses AED for the UAE', async () => {
    expect((await post('/v1/signup', body({ email: 'not-an-email' }))).statusCode).toBe(400);
    const s = await post('/v1/signup', body({ country: 'AE', phone: `+9715${Math.floor(10000000 + Math.random() * 89999999)}`, plan: 'base' }));
    expect(s.statusCode, s.body).toBe(200);
    const v = await post('/v1/signup/verify', { signupId: s.json().signupId, code: s.json().devCode });
    expect(v.statusCode, v.body).toBe(200);
    const t = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: v.json().tenantId }, include: { plan: true } }));
    expect(t).toMatchObject({ country: 'AE', currency: 'AED' });
    expect(t.plan?.code).toBe('base');
  });

  it('lets only the website call /v1/signup cross-origin; app endpoints stay app-only', async () => {
    const pre = (url: string) =>
      app.inject({ method: 'OPTIONS', url, headers: { origin: 'https://nextaierp.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    expect((await pre('/v1/signup')).headers['access-control-allow-origin']).toBe('https://nextaierp.com');
    expect((await pre('/v1/signup')).headers['access-control-allow-credentials']).toBeUndefined();
    expect((await pre('/v1/dashboard')).headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('tenant.setup: the client gets its own company in the shared ERPNext site', () => {
  it('without a shared site it is left for an admin to connect', async () => {
    const T = await createTenant(c.prisma);
    await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: T.tenant.id }, data: { erpApiKeyEnc: null, erpApiSecretEnc: null } }));
    expect(await setupTenantErp(c, T.tenant.id)).toMatchObject({ status: 'manual' });
  });

  it('creates the company once (idempotent), stores encrypted shared credentials and the company/abbr', async () => {
    process.env.ERPNEXT_SHARED_URL = 'https://books.nextaierp.test/';
    process.env.ERPNEXT_SHARED_API_KEY = 'shared-key';
    process.env.ERPNEXT_SHARED_API_SECRET = 'shared-secret';
    resetEnvCache();
    const T = await createTenant(c.prisma, { name: 'Kochi Spice Traders', country: 'IN', currency: 'INR' });
    await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: T.tenant.id }, data: { erpApiKeyEnc: null, erpApiSecretEnc: null, erpSiteUrl: null } }));
    const erp = c.erp(T.tenant) as unknown as { create: (d: string, x: Record<string, unknown>) => Promise<unknown>; docs: Map<string, Map<string, Record<string, unknown>>> };
    await erp.create('Company', { name: 'Kochi Spice Traders', abbr: 'KST', company_description: 'someone else' }); // name and abbr taken

    const r = await setupTenantErp(c, T.tenant.id, erp as never);
    expect(r.status).toBe('done');
    const companies = [...erp.docs.get('Company')!.values()];
    const mine = companies.find((x) => String(x.company_description).includes(`nextai:${T.tenant.id}`))!;
    expect(mine).toMatchObject({ company_name: `Kochi Spice Traders (${T.tenant.slug})`, abbr: 'KST2', country: 'India', default_currency: 'INR', chart_of_accounts: 'Standard' });
    expect(r.note).toMatch(/tax template "Input GST In-state - KST2" missing \(install India Compliance/);

    const saved = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: T.tenant.id } }));
    expect(saved.erpSiteUrl).toBe('https://books.nextaierp.test');
    expect(decrypt(saved.erpApiKeyEnc!, `erp_key:${T.tenant.id}`)).toBe('shared-key');
    expect(saved.settings).toMatchObject({ erpCompany: mine.name, companyAbbr: 'KST2', provisioning: { erp_company: { status: 'done' } } });

    // retry after a crash between "create" and "save": reuses the marked company
    await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: T.tenant.id }, data: { erpApiKeyEnc: null } }));
    await setupTenantErp(c, T.tenant.id, erp as never);
    expect([...erp.docs.get('Company')!.values()]).toHaveLength(2);
    // already connected → skipped
    expect(await setupTenantErp(c, T.tenant.id, erp as never)).toMatchObject({ status: 'skipped' });
  });

  it('abbreviations: initials, unique, start with a letter', () => {
    expect(uniqueAbbr('Kochi Spice Traders', new Set())).toBe('KST');
    expect(uniqueAbbr('Kochi Spice Traders', new Set(['kst', 'KST2']))).toBe('KST3');
    expect(uniqueAbbr('Aiingo', new Set())).toBe('AII');
    expect(uniqueAbbr('7 Stars Bakery', new Set())).toBe('C7SB');
  });
});
