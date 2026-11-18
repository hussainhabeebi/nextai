import { randomBytes } from 'node:crypto';
import { QUEUES } from '@nextai/shared';
import type { Prisma, Tenant } from '@prisma/client';
import { env } from '../../config/env.js';
import type { Container } from '../../container.js';
import { withSystemTx } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { reportEmail } from '../email/templates.js';
import { clearAccountCache } from '../erpnext/mappers.js';
import { uniqueAbbr } from '../erpnext/company-setup.js';
import { sealErpKey, sealErpSecret } from '../tenants/secrets.js';

/**
 * Self-signup with a dedicated ERPNext site per client ("<slug>.nextaierp.com"), built through the
 * provisioner on the ERPNext host. Runs as the tenant.setup job.
 *
 * Every step is idempotent and its result is stored in tenant.settings.provisioning, so a retry resumes
 * where it stopped. The provisioner runs one bench command at a time: when it is busy with another
 * client, the job reschedules itself instead of failing. Errors are retried with growing delays;
 * after MAX_ATTEMPTS the platform admins get an email and the client sees "setup needs attention".
 */
export const OWN_SITE_STEPS = ['site_create', 'site_apps', 'site_setup', 'site_config', 'site_api_user'] as const;
export type OwnSiteStep = (typeof OWN_SITE_STEPS)[number];

export type ErpSetupStatus = 'queued' | 'running' | 'ready' | 'failed';
export interface ErpSetupState {
  mode: 'site' | 'shared' | 'manual';
  status: ErpSetupStatus;
  site?: string;
  step?: string;
  attempts?: number;
  error?: string;
  at: string;
}

const MAX_ATTEMPTS = 6;
const BUSY_DELAY_MS = 60_000;
export const SITE_DOMAIN = 'nextaierp.com';
const SITE_LABEL = /^[a-z0-9][a-z0-9-]{1,38}$/;

/** DNS label for the client's site; slugs are already [a-z0-9-], this only guards length/shape. */
export function siteLabel(slug: string): string {
  let s = slug.replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').slice(0, 39).replace(/-+$/, '');
  if (!SITE_LABEL.test(s)) s = `nx-${s || 'client'}`.slice(0, 39);
  return s;
}
export const siteHost = (t: Pick<Tenant, 'slug'>) => `${siteLabel(t.slug)}.${SITE_DOMAIN}`;

/** Fiscal year containing `d`: April–March in India, calendar year in the UAE. */
export function fiscalYear(country: 'IN' | 'AE', d = new Date()): { start: string; end: string } {
  if (country === 'AE') return { start: `${d.getFullYear()}-01-01`, end: `${d.getFullYear()}-12-31` };
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return { start: `${y}-04-01`, end: `${y + 1}-03-31` };
}

/** ERPNext company name: letters, digits and simple punctuation (the provisioner rejects anything else). */
export function companyNameFor(name: string): string {
  const clean = name
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} &.,()'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  return /^[\p{L}\p{N}]/u.test(clean) ? clean : `Company ${clean}`.trim();
}

type Progress = Record<string, { status: 'done' | 'failed'; at: string; note?: string }>;

function readState(t: Tenant): { settings: Record<string, unknown>; progress: Progress; setup?: ErpSetupState } {
  const settings = (t.settings ?? {}) as Record<string, unknown>;
  return { settings, progress: (settings.provisioning as Progress) ?? {}, setup: settings.erpSetup as ErpSetupState | undefined };
}

async function save(c: Container, tenantId: string, patch: { step?: [string, Progress[string]]; setup?: Partial<ErpSetupState>; settings?: Record<string, unknown>; data?: Prisma.TenantUpdateInput }): Promise<Tenant> {
  return withSystemTx(c.prisma, async (tx) => {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const { settings, progress, setup } = readState(t);
    const next: Record<string, unknown> = { ...settings, ...(patch.settings ?? {}) };
    if (patch.step) next.provisioning = { ...progress, [patch.step[0]]: patch.step[1] };
    if (patch.setup) next.erpSetup = { ...(setup ?? { mode: 'site', status: 'running' }), ...patch.setup, at: new Date().toISOString() };
    // Merge, don't re-parse: the settings schema would strip keys it doesn't model (provisioning progress).
    return tx.tenant.update({ where: { id: tenantId }, data: { ...(patch.data ?? {}), settings: next as Prisma.InputJsonValue } });
  });
}

const isBusy = (err: unknown) => /another operation is running|\b429\b/i.test((err as Error).message ?? '');

/** Mark a new signup as waiting for its own site (called right after the tenant is created). */
export async function markSiteQueued(c: Container, tenantId: string) {
  const t = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
  await save(c, tenantId, { setup: { mode: 'site', status: 'queued', site: siteHost(t), attempts: 0 } });
}

/** Admin "Retry setup": fresh attempt budget; finished steps stay done and are skipped. */
export async function retryOwnSite(c: Container, tenantId: string) {
  await save(c, tenantId, { setup: { status: 'queued', attempts: 0, error: undefined } });
  await c.queue.enqueue(QUEUES.tenantSetup, { tenantId }, { jobId: `setup-${tenantId}-manual-${Date.now()}` });
}

export async function provisionOwnSite(c: Container, tenantId: string): Promise<{ status: string; note: string }> {
  let tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
  const site = siteHost(tenant);
  const state = readState(tenant);
  if (state.setup?.status === 'ready' && tenant.erpApiKeyEnc) return { status: 'skipped', note: 'Site already ready' };
  const attempts = (state.setup?.attempts ?? 0) + 1;
  tenant = await save(c, tenantId, { setup: { mode: 'site', status: 'running', site, attempts, error: undefined } });

  let current: OwnSiteStep = 'site_create';
  try {
    for (const step of OWN_SITE_STEPS) {
      current = step;
      if (readState(tenant).progress[step]?.status === 'done') continue;
      await save(c, tenantId, { setup: { step } });
      const note = await runStep(c, tenant, step, site);
      tenant = await save(c, tenantId, { step: [step, { status: 'done', at: new Date().toISOString(), note: note.text }], settings: note.settings, data: note.data });
    }
    clearAccountCache(tenantId);
    await save(c, tenantId, { setup: { status: 'ready', step: undefined, error: undefined } });
    logger.info({ tenantId, site }, 'own ERPNext site ready');
    return { status: 'done', note: `Site ${site} ready` };
  } catch (err) {
    const msg = (err as Error).message.slice(0, 300);
    if (isBusy(err)) {
      // Not a failure: another signup holds the provisioner. Try again shortly, without using up an attempt.
      await save(c, tenantId, { setup: { status: 'queued', attempts: attempts - 1, step: current } });
      await c.queue.enqueue(QUEUES.tenantSetup, { tenantId }, { jobId: `setup-${tenantId}-wait-${Date.now()}`, delayMs: BUSY_DELAY_MS });
      return { status: 'waiting', note: 'Provisioner busy; rescheduled' };
    }
    await save(c, tenantId, { step: [current, { status: 'failed', at: new Date().toISOString(), note: msg }] });
    if (attempts < MAX_ATTEMPTS) {
      const delayMs = Math.min(30, 2 ** attempts) * 60_000; // 2, 4, 8, 16, 30 min
      await save(c, tenantId, { setup: { status: 'queued', error: msg, step: current } });
      await c.queue.enqueue(QUEUES.tenantSetup, { tenantId }, { jobId: `setup-${tenantId}-retry-${attempts}`, delayMs });
      logger.warn({ tenantId, site, step: current, attempts, err: msg }, 'own site provisioning failed; will retry');
      return { status: 'retrying', note: msg };
    }
    await save(c, tenantId, { setup: { status: 'failed', error: msg, step: current } });
    logger.error({ tenantId, site, step: current, err: msg }, 'own site provisioning gave up');
    await alertAdmins(c, tenant, site, current, msg).catch(() => undefined);
    return { status: 'failed', note: msg };
  }
}

async function runStep(c: Container, tenant: Tenant, step: OwnSiteStep, site: string): Promise<{ text: string; settings?: Record<string, unknown>; data?: Prisma.TenantUpdateInput }> {
  const p = c.provisioner;
  switch (step) {
    case 'site_create': {
      const st = await p.run({ op: 'site-status', site });
      if (st.data?.exists === '1') return { text: `Site ${site} already exists` };
      await p.run({ op: 'new-site', site, adminPassword: randomBytes(24).toString('base64url') });
      return { text: `Site ${site} created with ERPNext` };
    }
    case 'site_apps': {
      const st = await p.run({ op: 'site-status', site });
      const apps = new Set((st.data?.apps ?? '').split(',').filter(Boolean));
      const want: Array<'erpnext' | 'india_compliance'> = tenant.country === 'IN' ? ['erpnext', 'india_compliance'] : ['erpnext'];
      const missing = want.filter((a) => !apps.has(a));
      for (const app of missing) await p.run({ op: 'install-app', site, app });
      return { text: missing.length ? `Installed ${missing.join(', ')}` : 'Apps already installed' };
    }
    case 'site_setup': {
      // ERPNext setup wizard: company, chart of accounts, fiscal year, country tax templates.
      const fy = fiscalYear(tenant.country);
      const r = await p.run({
        op: 'complete-setup',
        site,
        companyName: companyNameFor(tenant.name),
        abbr: uniqueAbbr(tenant.name, new Set()),
        country: tenant.country === 'IN' ? 'India' : 'United Arab Emirates',
        currency: tenant.country === 'IN' ? 'INR' : 'AED',
        timezone: tenant.country === 'IN' ? 'Asia/Kolkata' : 'Asia/Dubai',
        fyStart: fy.start,
        fyEnd: fy.end,
      });
      const company = r.data?.company;
      const abbr = r.data?.abbr;
      if (!company || !abbr) throw new Error('Setup wizard did not report the company');
      return { text: `Company ${company} (${abbr}), fiscal year ${fy.start} – ${fy.end}`, settings: { erpCompany: company, companyAbbr: abbr } };
    }
    case 'site_config':
      await p.run({ op: 'enable-scheduler', site });
      await p.run({ op: 'set-config', site, key: 'host_name', value: `https://${site}` });
      return { text: 'Scheduler on, host name set' };
    case 'site_api_user': {
      const r = await p.run({ op: 'create-api-user', site, email: `nextai-bot@${site}` });
      if (!r.data?.apiKey || !r.data.apiSecret) throw new Error('Provisioner did not return API keys');
      return {
        text: 'nextai-bot API keys stored (encrypted)',
        data: { erpSiteUrl: `https://${site}`, erpApiKeyEnc: sealErpKey(tenant.id, r.data.apiKey), erpApiSecretEnc: sealErpSecret(tenant.id, r.data.apiSecret) },
      };
    }
  }
}

async function alertAdmins(c: Container, tenant: Tenant, site: string, step: string, error: string) {
  const e = env();
  if (!c.mailer.configured || !e.ADMIN_REPORT_EMAILS.length) return;
  const mail = reportEmail({
    title: `Signup setup failed: ${tenant.name}`,
    intro: `NextAi could not finish building this client's ERPNext site after ${MAX_ATTEMPTS} attempts. Fix the cause, then press "Retry setup" on the client's page in the admin console (completed steps are skipped).`,
    rows: [
      { label: 'Site', value: site },
      { label: 'Failed step', value: step },
      { label: 'Error', value: error },
    ],
    cta: { label: 'Open admin', url: `${e.APP_URL.replace(/\/+$/, '')}/admin/tenants/${tenant.id}` },
    footer: `Tenant ${tenant.id}`,
  });
  await c.mailer.send({ to: e.ADMIN_REPORT_EMAILS, subject: `Signup setup failed: ${tenant.name}`, html: mail.html, text: mail.text, tags: { kind: 'signup_setup_failed' } });
}
