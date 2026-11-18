import { randomBytes } from 'node:crypto';
import { COUNTRIES, LANGUAGES, PLAN_CODES, normalizePhone, type TenantCreate } from '@nextai/shared';
import { QUEUES } from '@nextai/shared';
import { z } from 'zod';
import { env, isProd } from '../../config/env.js';
import type { Container } from '../../container.js';
import { randomOtp, safeEqual, sha256 } from '../../lib/crypto.js';
import { withSystemTx } from '../../lib/db.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../audit/audit.js';
import { reportEmail } from '../email/templates.js';
import { createTenantRecord } from '../tenants/service.js';
import { signupErpMode } from '../erpnext/company-setup.js';
import { markSiteQueued } from '../provisioning/own-site.js';

export const signupRequestSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  phone: z.string().trim().min(8).max(20),
  country: z.enum(COUNTRIES),
  language: z.enum(LANGUAGES).default('en'),
  plan: z.enum(PLAN_CODES).optional(),
  utm: z.record(z.string().max(200)).optional(),
  /** Honeypot: humans never see or fill this field. */
  website: z.string().max(200).optional(),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

const PENDING_TTL = 30 * 60; // seconds to enter the email code
const MAGIC_TTL = 15 * 60; // seconds to use the "open the app" link
const pendingKey = (id: string) => `signup:${id}`;
const throttleKey = (email: string) => `signup:rate:${sha256(email)}`;
const magicKey = (token: string) => `magic:${sha256(token)}`;
const codeHash = (code: string) => sha256(`${env().JWT_REFRESH_SECRET}:signup:${code}`);

type Pending = { req: SignupRequest; phone: string; h: string; a: number };

async function phoneTaken(c: Container, phone: string) {
  return withSystemTx(c.prisma, (tx) => tx.user.findFirst({ where: { phone, tenantId: { not: null } }, select: { id: true } }));
}

/** Step 1: validate, store the request for 30 min and email a 6-digit code. Nothing is created yet. */
export async function startSignup(c: Container, input: SignupRequest): Promise<{ signupId: string; devCode?: string }> {
  const signupId = randomBytes(16).toString('hex');
  if (input.website) return { signupId }; // bot: look successful, do nothing
  if (!env().SIGNUP_ENABLED) throw badRequest('Signups are paused. Please contact us on WhatsApp or email.');
  const phone = normalizePhone(input.phone, input.country);
  if (await phoneTaken(c, phone)) throw conflict('This WhatsApp number already has a NextAi account. Log in at the app instead.');
  if (!c.mailer.configured && isProd()) throw badRequest('Signup is temporarily unavailable. Please contact us on WhatsApp.');

  const n = await c.redis.incr(throttleKey(input.email));
  if (n === 1) await c.redis.expire(throttleKey(input.email), 3600);
  if (n > 5) throw badRequest('Too many attempts for this email. Please try again in an hour.');

  const code = randomOtp();
  const pending: Pending = { req: { ...input, website: undefined }, phone, h: codeHash(code), a: 0 };
  await c.redis.set(pendingKey(signupId), JSON.stringify(pending), 'EX', PENDING_TTL);
  const mail = reportEmail({
    title: `Your NextAi code: ${code}`,
    intro: `Hi ${input.ownerName}, enter this code to start your free trial for ${input.businessName}. It expires in 30 minutes.`,
    rows: [{ label: 'Verification code', value: code }],
    footer: 'If you did not sign up for NextAi, ignore this email.',
  });
  if (c.mailer.configured) {
    await c.mailer.send({ to: [input.email], subject: `${code} is your NextAi code`, html: mail.html, text: mail.text, tags: { kind: 'signup_code' } });
  }
  return { signupId, devCode: isProd() ? undefined : code };
}

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'business'
  );
}

/** Step 2: check the code, create the business (trial) + owner, queue ERPNext setup, return a one-time app link. */
export async function verifySignup(c: Container, signupId: string, code: string, ip?: string): Promise<{ tenantId: string; loginUrl: string }> {
  const raw = await c.redis.get(pendingKey(signupId));
  if (!raw) throw badRequest('This signup has expired. Please start again.');
  const p = JSON.parse(raw) as Pending;
  if (p.a >= 5) {
    await c.redis.del(pendingKey(signupId));
    throw badRequest('Too many wrong codes. Please start again.');
  }
  if (!safeEqual(p.h, codeHash(code))) {
    await c.redis.set(pendingKey(signupId), JSON.stringify({ ...p, a: p.a + 1 }), 'KEEPTTL');
    throw badRequest('That code is not right.');
  }
  // One verification only (double-clicks, replays).
  if ((await c.redis.del(pendingKey(signupId))) === 0) throw badRequest('This signup was already completed.');
  if (await phoneTaken(c, p.phone)) throw conflict('This WhatsApp number already has a NextAi account. Log in at the app instead.');

  const base = slugify(p.req.businessName);
  let slug = base;
  for (let i = 0; await withSystemTx(c.prisma, (tx) => tx.tenant.findUnique({ where: { slug }, select: { id: true } })); i++) {
    slug = `${base}-${randomBytes(2).toString('hex')}`;
    if (i > 10) throw badRequest('Could not create the business. Please try again.');
  }
  const create: TenantCreate = {
    name: p.req.businessName,
    slug,
    country: p.req.country,
    currency: p.req.country === 'IN' ? 'INR' : 'AED',
    language: p.req.language,
    planCode: p.req.plan ?? 'growth',
    ownerPhone: p.phone,
    ownerName: p.req.ownerName,
    ownerEmail: p.req.email,
  };
  const { tenant, ownerId } = await createTenantRecord(c.prisma, create);
  await withSystemTx(c.prisma, (tx) =>
    tx.tenant.update({
      where: { id: tenant.id },
      data: { settings: { ...(tenant.settings as object), signup: { at: new Date().toISOString(), utm: p.req.utm ?? {}, source: 'website' } } },
    }),
  );
  await audit(c.prisma, { tenantId: tenant.id, actorId: ownerId, actorType: 'user', channel: 'app', action: 'tenant.signup', entity: 'tenant', entityId: tenant.id, after: { name: tenant.name, slug, plan: create.planCode, country: create.country }, ip });
  if (signupErpMode() === 'site') await markSiteQueued(c, tenant.id); // the app shows "setting up your books" until ready
  await c.queue.enqueue(QUEUES.tenantSetup, { tenantId: tenant.id }, { jobId: `setup-${tenant.id}` });

  const token = randomBytes(24).toString('base64url');
  await c.redis.set(magicKey(token), ownerId, 'EX', MAGIC_TTL);
  const loginUrl = `${env().APP_URL.replace(/\/+$/, '')}/login#t=${token}`;
  await notify(c, tenant.id, create).catch((err) => logger.warn({ err: (err as Error).message }, 'signup notification failed'));
  return { tenantId: tenant.id, loginUrl };
}

/** One-time "open the app" token from signup → owner user id (single use). */
export async function consumeMagicToken(c: Container, token: string): Promise<string | undefined> {
  const k = magicKey(token);
  const userId = await c.redis.get(k);
  if (!userId) return undefined;
  return (await c.redis.del(k)) === 1 ? userId : undefined;
}

async function notify(c: Container, tenantId: string, t: TenantCreate) {
  if (!c.mailer.configured) return;
  const e = env();
  const app = e.APP_URL.replace(/\/+$/, '');
  const welcome = reportEmail({
    title: `Welcome to NextAi, ${t.ownerName}!`,
    intro: `${t.name} is on a 14-day free trial. We are setting up your own ERPNext books now (a few minutes), and our team will connect your WhatsApp Business number (usually within one business day). Meanwhile you can capture bills in the app.`,
    rows: [
      { label: 'Business', value: t.name },
      { label: 'WhatsApp number', value: t.ownerPhone },
      { label: 'Plan', value: t.planCode },
    ],
    cta: { label: 'Open NextAi', url: app },
    footer: 'Log in with your WhatsApp number; until WhatsApp is connected, the login code comes by email.',
  });
  await c.mailer.send({ to: [t.ownerEmail!], subject: 'Welcome to NextAi', html: welcome.html, text: welcome.text, tags: { kind: 'welcome' } });
  if (e.ADMIN_REPORT_EMAILS.length) {
    const admin = reportEmail({
      title: `New signup: ${t.name}`,
      intro: 'A new client signed up on the website. Connect their WhatsApp Business number in Chatwoot, then in Admin → Integrations.',
      rows: [
        { label: 'Business', value: `${t.name} (${t.country}, ${t.currency})` },
        { label: 'Owner', value: `${t.ownerName} · ${t.ownerPhone} · ${t.ownerEmail}` },
        { label: 'Plan', value: t.planCode },
      ],
      cta: { label: 'Open Integrations', url: `${app}/admin/integrations` },
      footer: `Tenant ${tenantId}`,
    });
    await c.mailer.send({ to: e.ADMIN_REPORT_EMAILS, subject: `New NextAi signup: ${t.name}`, html: admin.html, text: admin.text, tags: { kind: 'signup_admin' } });
  }
}
