import { QUEUES } from '@nextai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { resetEnvCache } from '../src/config/env.js';
import { decrypt } from '../src/lib/crypto.js';
import { tenantDb, withSystemTx } from '../src/lib/db.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { createDraft, confirmDraft, postDraft } from '../src/modules/drafts/service.js';
import { setupTenantErp } from '../src/modules/erpnext/company-setup.js';
import { companyNameFor, fiscalYear, retryOwnSite, siteLabel } from '../src/modules/provisioning/own-site.js';
import { closeShared, testContainer } from './helpers.js';

const c = testContainer();
let app: FastifyInstance;
const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, payload });
const rand = () => Math.floor(10000000 + Math.random() * 89999999);

async function signUp(over: Record<string, unknown> = {}) {
  const s = await post('/v1/signup', {
    businessName: `Spice Traders ${rand()}`,
    ownerName: 'Anu Thomas',
    email: `anu.${rand()}@example.com`,
    phone: `+9198${rand()}`,
    country: 'IN',
    ...over,
  });
  expect(s.statusCode, s.body).toBe(200);
  const v = await post('/v1/signup/verify', { signupId: s.json().signupId, code: s.json().devCode });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().tenantId as string;
}
const tenantOf = (id: string) => withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id } }));
const setupOf = async (id: string) => ((await tenantOf(id)).settings as { erpSetup?: Record<string, unknown> }).erpSetup;

beforeAll(async () => {
  process.env.SIGNUP_ERP_MODE = 'site';
  process.env.ADMIN_REPORT_EMAILS = 'ops@nextaierp.test';
  resetEnvCache();
  await seed(c.prisma);
  app = await buildApp(c);
});
beforeEach(() => {
  c.provisioner.ops = [];
  c.provisioner.failNext = {};
  c.provisioner.busy = 0;
  c.queue.jobs = [];
});
afterEach(() => resetEnvCache());
afterAll(async () => {
  delete process.env.SIGNUP_ERP_MODE;
  delete process.env.ADMIN_REPORT_EMAILS;
  resetEnvCache();
  await app.close();
  await closeShared();
});

describe('website signup → its own ERPNext site, automatically', () => {
  it('queues the site at signup, shows progress in /me, then builds and connects it', async () => {
    const id = await signUp({ businessName: 'Kochi Spice Traders' });
    const t0 = await tenantOf(id);
    const site = `${t0.slug}.nextaierp.com`;
    expect(await setupOf(id)).toMatchObject({ mode: 'site', status: 'queued', site });
    expect(c.queue.jobs.map((j) => j.name)).toContain(QUEUES.tenantSetup);

    const owner = await withSystemTx(c.prisma, (tx) => tx.user.findFirstOrThrow({ where: { tenantId: id, role: 'owner' } }));
    const tok = await signAccess({ sub: owner.id, tid: id, role: 'owner', typ: 'app' });
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${tok}` } });
    expect(me.json().tenant.setup).toMatchObject({ status: 'queued', site });

    expect(await setupTenantErp(c, id)).toMatchObject({ status: 'done' });
    expect(c.provisioner.ops.map((o) => o.op)).toEqual(['site-status', 'new-site', 'site-status', 'install-app', 'complete-setup', 'enable-scheduler', 'set-config', 'create-api-user']);
    expect(c.provisioner.ops).toContainEqual({ op: 'install-app', site, app: 'india_compliance' });
    const fy = fiscalYear('IN');
    expect(c.provisioner.ops.find((o) => o.op === 'complete-setup')).toMatchObject({ companyName: 'Kochi Spice Traders', abbr: 'KST', country: 'India', currency: 'INR', timezone: 'Asia/Kolkata', fyStart: fy.start, fyEnd: fy.end });
    expect(fy.start).toMatch(/-04-01$/);

    const t = await tenantOf(id);
    expect(t.erpSiteUrl).toBe(`https://${site}`);
    expect(decrypt(t.erpApiKeyEnc!, `erp_key:${id}`)).toBe('fake-key');
    expect(t.settings).toMatchObject({ erpCompany: 'Kochi Spice Traders', companyAbbr: 'KST', erpSetup: { status: 'ready' } });
    expect(Object.keys((t.settings as { provisioning: object }).provisioning).sort()).toEqual(['site_api_user', 'site_apps', 'site_config', 'site_create', 'site_setup']);

    // A re-run does nothing
    c.provisioner.ops = [];
    expect(await setupTenantErp(c, id)).toMatchObject({ status: 'skipped' });
    expect(c.provisioner.ops).toHaveLength(0);
  });

  it('resumes after a failure without redoing finished steps, and waits when the provisioner is busy', async () => {
    const id = await signUp();
    c.provisioner.failNext['complete-setup'] = 'Fiscal Year overlap';
    expect(await setupTenantErp(c, id)).toMatchObject({ status: 'retrying' });
    expect(await setupOf(id)).toMatchObject({ status: 'queued', step: 'site_setup', attempts: 1, error: expect.stringContaining('Fiscal Year overlap') });
    expect(c.queue.jobs.filter((j) => j.name === QUEUES.tenantSetup)).toHaveLength(2); // signup + retry

    c.provisioner.ops = [];
    c.provisioner.busy = 1;
    expect(await setupTenantErp(c, id)).toMatchObject({ status: 'waiting' });
    expect(await setupOf(id)).toMatchObject({ status: 'queued', attempts: 1 }); // busy does not use an attempt

    c.provisioner.ops = [];
    expect(await setupTenantErp(c, id)).toMatchObject({ status: 'done' });
    expect(c.provisioner.ops.map((o) => o.op)).toEqual(['complete-setup', 'enable-scheduler', 'set-config', 'create-api-user']);
    expect(await setupOf(id)).toMatchObject({ status: 'ready', attempts: 2 });
  });

  it('holds entries made while the site is being built and posts them once it is ready', async () => {
    const id = await signUp();
    const t = await tenantOf(id);
    const owner = await withSystemTx(c.prisma, (tx) => tx.user.findFirstOrThrow({ where: { tenantId: id, role: 'owner' } }));
    const actor = { id: owner.id, type: 'user' as const, channel: 'app' as const };
    const d = await createDraft(c, t, { userId: owner.id, type: 'payment_in', payload: { partyName: 'Acme', date: '2026-11-18', currency: 'INR', lines: [], total: 500, paymentMode: 'cash', validationIssues: [] }, actor });
    await confirmDraft(c, t, d.id, actor);
    c.queue.jobs = [];
    const held = await postDraft(c, id, d.id);
    expect(held.status).toBe('confirmed');
    expect(c.queue.jobs).toEqual([{ name: QUEUES.draftPost, data: { tenantId: id, draftId: d.id } }]);

    await setupTenantErp(c, id);
    expect((await postDraft(c, id, d.id)).status).toBe('posted');
    expect((await tenantDb(c.prisma, id).draft.findUniqueOrThrow({ where: { id: d.id } })).erpName).toBeTruthy();
  });

  it('gives up after repeated failures and emails the platform admins', async () => {
    const id = await signUp({ businessName: 'Broken Books' });
    for (let i = 0; i < 6; i++) {
      c.provisioner.failNext['new-site'] = 'MariaDB unreachable';
      await setupTenantErp(c, id);
    }
    expect(await setupOf(id)).toMatchObject({ status: 'failed', step: 'site_create', attempts: 6 });
    expect(c.mailer.sent.at(-1)).toMatchObject({ to: ['ops@nextaierp.test'], subject: 'Signup setup failed: Broken Books' });

    // Admin fixes the cause and presses "Retry setup": a fresh attempt budget, and it completes.
    c.queue.jobs = [];
    await retryOwnSite(c, id);
    expect(await setupOf(id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(c.queue.jobs.map((j) => j.name)).toEqual([QUEUES.tenantSetup]);
    expect(await setupTenantErp(c, id)).toMatchObject({ status: 'done' });
    expect(await setupOf(id)).toMatchObject({ status: 'ready', attempts: 1 });
  });

  it('UAE: no India Compliance, calendar fiscal year, AED and Dubai time', async () => {
    const id = await signUp({ country: 'AE', phone: `+9715${rand()}`, businessName: 'Al Rayyan Trading LLC' });
    await setupTenantErp(c, id);
    expect(c.provisioner.ops.some((o) => o.op === 'install-app')).toBe(false);
    const y = new Date().getFullYear();
    expect(c.provisioner.ops.find((o) => o.op === 'complete-setup')).toMatchObject({ country: 'United Arab Emirates', currency: 'AED', timezone: 'Asia/Dubai', fyStart: `${y}-01-01`, fyEnd: `${y}-12-31` });
  });

  it('names: DNS-safe site labels and ERPNext-safe company names', () => {
    expect(siteLabel('kochi-spice-traders')).toBe('kochi-spice-traders');
    expect(siteLabel('a')).toBe('nx-a');
    expect(siteLabel('x'.repeat(50))).toHaveLength(39);
    expect(companyNameFor('Kochi Spice Traders (P) Ltd.')).toBe('Kochi Spice Traders (P) Ltd.');
    expect(companyNameFor('A+B "Foods" <Kochi>')).toBe('A B Foods Kochi');
    expect(companyNameFor('مطعم الريان')).toBe('مطعم الريان');
    expect(companyNameFor('#1 Pharmacy')).toBe('1 Pharmacy');
  });
});
