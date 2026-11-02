import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { QUEUES, draftPayloadSchema, planLimitsSchema, t, tenantCreateSchema, type DraftPayload, type Language } from '@nextai/shared';
import type { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { Container } from '../../container.js';
import { randomToken } from '../../lib/crypto.js';
import { withSystemTx } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { BullJobQueue } from '../../lib/queue.js';
import { audit } from '../../modules/audit/audit.js';
import { signAccess } from '../../modules/auth/tokens.js';
import { CHOICES, confirmDraft, getDraft, summaryText, updateDraftPayload } from '../../modules/drafts/service.js';
import { PROVISION_STEPS, runProvisionStep } from '../../modules/provisioning/wizard.js';
import { createTenantRecord } from '../../modules/tenants/service.js';
import { currentPeriod } from '../../modules/usage/usage.js';
import { planLimits } from '../../modules/billing/gating.js';
import { R2Storage } from '../../storage/storage.js';

const uuidParam = z.object({ id: z.string().uuid() });

/** Platform admin API. Cross-tenant reads use the system (RLS bypass) context; every change is audited. */
export const platformRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    const anyAdmin = { onRequest: app.requireAdmin() };
    const superOnly = { onRequest: app.requireAdmin(['super_admin']) };
    const reviewers = { onRequest: app.requireAdmin(['super_admin', 'reviewer']) };
    const ops = { onRequest: app.requireAdmin(['super_admin', 'support']) };
    const sys = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => withSystemTx(c.prisma, fn);
    const adminAudit = (req: FastifyRequest, action: string, entity: string, entityId?: string, before?: unknown, after?: unknown, tenantId?: string) =>
      audit(c.prisma, { tenantId, actorId: req.admin!.sub, actorType: 'admin', channel: 'admin', action, entity, entityId, before, after, ip: req.ip });

    // ---------------- Dashboard ----------------
    app.get('/dashboard', { ...anyAdmin, schema: { tags: ['admin'] } }, async () => {
      const period = currentPeriod();
      const [byStatus, subs, usage, plans] = await sys(async (tx) =>
        Promise.all([
          tx.tenant.groupBy({ by: ['status'], _count: true }),
          tx.subscription.findMany({ where: { status: { in: ['active', 'trialing', 'past_due'] } }, include: { tenant: true } }),
          tx.usageCounter.findMany({ where: { period } }),
          tx.plan.findMany(),
        ]),
      );
      const count = (s: string) => byStatus.find((x) => x.status === s)?._count ?? 0;
      const mrr: Record<string, number> = {};
      for (const s of subs.filter((x) => x.status === 'active')) {
        const plan = plans.find((p) => p.code === s.planCode);
        const cur = s.tenant.currency;
        mrr[cur] = (mrr[cur] ?? 0) + Number((plan?.priceMonthly as Record<string, number>)?.[cur] ?? 0);
      }
      const series = await c.redis.hgetall(`metrics:messages:${period}`);
      let failedJobs = 0;
      if (c.queue instanceof BullJobQueue) {
        for (const q of c.queue.allQueues()) failedJobs += await q.getFailedCount();
      }
      return {
        tenants: { active: count('active'), trial: count('trial'), pastDue: count('past_due'), suspended: count('suspended') },
        mrr,
        messagesThisMonth: usage.reduce((s, u) => s + u.messages, 0),
        ocrPagesThisMonth: usage.reduce((s, u) => s + u.ocrPages, 0),
        aiCostUsd: usage.reduce((s, u) => s + Number(u.aiCostMicros), 0) / 1e6,
        messagesPerDay: Object.entries(series).sort().map(([day, cum]) => ({ day, cumulative: Number(cum) })),
        failedJobs,
        reviewQueue: await sys((tx) => tx.draft.count({ where: { status: { in: ['needs_review', 'failed'] } } })),
      };
    });

    // ---------------- Tenants ----------------
    app.get(
      '/tenants',
      { ...anyAdmin, schema: { tags: ['admin'], querystring: z.object({ q: z.string().max(100).optional(), status: z.enum(['trial', 'active', 'past_due', 'suspended']).optional() }) } },
      async (req) => {
        const items = await sys((tx) =>
          tx.tenant.findMany({
            where: {
              status: req.query.status,
              ...(req.query.q ? { OR: [{ name: { contains: req.query.q, mode: 'insensitive' } }, { slug: { contains: req.query.q } }] } : {}),
            },
            include: { plan: true, _count: { select: { users: true } } },
            orderBy: { createdAt: 'desc' },
            take: 200,
          }),
        );
        return { items: items.map((x) => ({ id: x.id, name: x.name, slug: x.slug, country: x.country, currency: x.currency, status: x.status, plan: x.plan?.code ?? null, users: x._count.users, createdAt: x.createdAt })) };
      },
    );

    app.get('/tenants/:id', { ...anyAdmin, schema: { tags: ['admin'], params: uuidParam } }, async (req) => {
      const tenant = await sys((tx) => tx.tenant.findUnique({ where: { id: req.params.id }, include: { plan: true, users: true, subscriptions: true, usageCounters: { orderBy: { period: 'desc' }, take: 6 } } }));
      if (!tenant) throw notFound('Tenant');
      const health = await c.redis.get(`health:erp:${tenant.id}`);
      const { erpApiKeyEnc, erpApiSecretEnc, cwBotTokenEnc, erpWebhookSecretEnc, ...safe } = tenant;
      return {
        ...safe,
        usageCounters: tenant.usageCounters.map((u) => ({ ...u, aiCostMicros: Number(u.aiCostMicros) })),
        users: tenant.users.map((u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role, status: u.status, lastLoginAt: u.lastLoginAt })),
        connections: {
          erpnext: { configured: !!(erpApiKeyEnc && erpApiSecretEnc), siteUrl: tenant.erpSiteUrl, health: health ? JSON.parse(health) : null },
          chatwoot: { configured: !!cwBotTokenEnc, accountId: tenant.cwAccountId, inboxId: tenant.cwInboxId },
          erpWebhook: { configured: !!erpWebhookSecretEnc },
        },
        limits: await planLimits(c, tenant),
      };
    });

    for (const [action, status] of [['suspend', 'suspended'], ['resume', 'active']] as const) {
      app.post(`/tenants/:id/${action}`, { ...ops, schema: { tags: ['admin'], params: uuidParam } }, async (req) => {
        const before = await sys((tx) => tx.tenant.findUniqueOrThrow({ where: { id: req.params.id } }));
        const after = await sys((tx) => tx.tenant.update({ where: { id: req.params.id }, data: { status } }));
        await adminAudit(req, `tenant.${action}`, 'tenant', after.id, { status: before.status }, { status }, after.id);
        return { id: after.id, status: after.status };
      });
    }

    app.patch(
      '/tenants/:id/settings',
      { ...superOnly, schema: { tags: ['admin'], params: uuidParam, body: z.object({ settings: z.record(z.unknown()), planCode: z.enum(['starter', 'business', 'pro']).optional() }) } },
      async (req) => {
        const before = await sys((tx) => tx.tenant.findUniqueOrThrow({ where: { id: req.params.id } }));
        const plan = req.body.planCode ? await c.prisma.plan.findUnique({ where: { code: req.body.planCode } }) : null;
        const settings = { ...(before.settings as object), ...req.body.settings } as Prisma.InputJsonValue;
        const after = await sys((tx) => tx.tenant.update({ where: { id: before.id }, data: { settings, planId: plan?.id ?? undefined } }));
        await adminAudit(req, 'tenant.settings', 'tenant', after.id, { settings: before.settings, planId: before.planId }, { settings, planId: after.planId }, after.id);
        return { ok: true };
      },
    );

    /** Read-only "view as tenant": short-lived app token with the imp claim; every request under it is audited. */
    app.post('/tenants/:id/impersonate', { ...ops, schema: { tags: ['admin'], params: uuidParam } }, async (req) => {
      const owner = await sys((tx) => tx.user.findFirst({ where: { tenantId: req.params.id, role: 'owner' } }));
      if (!owner) throw notFound('Tenant owner');
      await adminAudit(req, 'impersonate.start', 'tenant', req.params.id, undefined, undefined, req.params.id);
      const accessToken = await signAccess({ sub: owner.id, tid: req.params.id, role: 'staff', typ: 'app', imp: req.admin!.sub });
      return { accessToken, url: `${env().APP_URL}/#imp=${accessToken}` };
    });

    // ---------------- Provisioning ----------------
    app.post('/provision', { ...superOnly, schema: { tags: ['admin'], body: tenantCreateSchema } }, async (req, reply) => {
      const exists = await sys((tx) => tx.tenant.findUnique({ where: { slug: req.body.slug } }));
      if (exists) throw badRequest('Slug already in use');
      const { tenant } = await createTenantRecord(c.prisma, req.body);
      await adminAudit(req, 'provision.create', 'tenant', tenant.id, undefined, { name: tenant.name, slug: tenant.slug }, tenant.id);
      return reply.code(201).send({ tenantId: tenant.id, steps: PROVISION_STEPS });
    });

    app.post(
      '/provision/:id/steps/:step',
      {
        ...superOnly,
        schema: {
          tags: ['admin'],
          params: z.object({ id: z.string().uuid(), step: z.enum(PROVISION_STEPS) }),
          body: z.object({ chatwoot: z.object({ accountId: z.number().int(), inboxId: z.number().int(), botToken: z.string().min(8) }).optional() }).default({}),
        },
      },
      async (req) => {
        const r = await runProvisionStep(c, req.params.id, req.params.step, req.body, req.admin!.sub);
        return { step: req.params.step, status: r.status, note: r.note, progress: (r.tenant.settings as { provisioning?: unknown }).provisioning };
      },
    );

    // ---------------- Review queue ----------------
    app.get('/review-queue', { ...reviewers, schema: { tags: ['admin'], querystring: z.object({ tenantId: z.string().uuid().optional() }) } }, async (req) => {
      const items = await sys((tx) =>
        tx.draft.findMany({
          where: { status: { in: ['needs_review', 'failed'] }, tenantId: req.query.tenantId },
          include: { tenant: { select: { name: true, currency: true } } },
          orderBy: { createdAt: 'asc' },
          take: 100,
        }),
      );
      return { items };
    });

    app.get('/review-queue/:id', { ...reviewers, schema: { tags: ['admin'], params: uuidParam } }, async (req) => {
      const d = await sys((tx) => tx.draft.findUnique({ where: { id: req.params.id }, include: { tenant: { select: { id: true, name: true, currency: true, country: true } }, document: true } }));
      if (!d) throw notFound('Draft');
      await adminAudit(req, 'review.view', 'draft', d.id, undefined, undefined, d.tenantId);
      const documentUrl = d.document ? await c.storage.signedUrl(d.tenantId, d.document.r2Key, 600) : null;
      return { ...d, documentUrl, extracted: d.document?.extracted ?? null };
    });

    const loadTenantFor = async (draftId: string) => {
      const d = await sys((tx) => tx.draft.findUnique({ where: { id: draftId }, include: { tenant: true } }));
      if (!d) throw notFound('Draft');
      return d;
    };
    const adminActor = (req: FastifyRequest) => ({ id: req.admin!.sub, type: 'admin' as const, channel: 'admin' as const, ip: req.ip });

    app.patch('/review-queue/:id', { ...reviewers, schema: { tags: ['admin'], params: uuidParam, body: draftPayloadSchema.partial() } }, async (req) => {
      const d = await loadTenantFor(req.params.id);
      return updateDraftPayload(c, d.tenant, d.id, req.body as Partial<DraftPayload>, adminActor(req));
    });

    app.post('/review-queue/:id/post', { ...reviewers, schema: { tags: ['admin'], params: uuidParam } }, async (req) => {
      const d = await loadTenantFor(req.params.id);
      if (d.status === 'failed') await sys((tx) => tx.draft.update({ where: { id: d.id }, data: { status: 'needs_review' } }));
      return confirmDraft(c, d.tenant, d.id, adminActor(req));
    });

    /** Hand the draft back to the bot: user gets the corrected summary with 1/2/3 choices. */
    app.post('/review-queue/:id/return', { ...reviewers, schema: { tags: ['admin'], params: uuidParam } }, async (req) => {
      const d = await loadTenantFor(req.params.id);
      if (!d.conversationId) throw badRequest('Draft has no WhatsApp conversation');
      await sys((tx) => tx.draft.update({ where: { id: d.id }, data: { status: 'pending', reviewedBy: req.admin!.sub } }));
      const fresh = await getDraft(c, d.tenantId, d.id);
      const lang = (d.tenant.language as Language) ?? 'en';
      const cw = c.chatwoot(d.tenant);
      await cw.sendChoices(d.conversationId, `✅ Checked by your accountant.\n\n${summaryText(fresh, lang)}`, CHOICES);
      await cw.toggleStatus(d.conversationId, 'pending'); // back to the bot
      await c.conversations.set(d.tenantId, d.conversationId, { step: 'awaiting_confirm', draftId: d.id });
      await adminAudit(req, 'review.return', 'draft', d.id, { status: d.status }, { status: 'pending' }, d.tenantId);
      void t;
      return { ok: true };
    });

    // ---------------- Platform users ----------------
    app.get('/users', { ...superOnly, schema: { tags: ['admin'] } }, async () => {
      const users = await sys((tx) => tx.user.findMany({ where: { platformRole: { not: null } }, orderBy: { createdAt: 'asc' } }));
      return { items: users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.platformRole, status: u.status, totp: !!u.totpSecretEnc, lastLoginAt: u.lastLoginAt })) };
    });
    app.post(
      '/users',
      { ...superOnly, schema: { tags: ['admin'], body: z.object({ email: z.string().email(), name: z.string().min(1), role: z.enum(['super_admin', 'reviewer', 'support']) }) } },
      async (req, reply) => {
        const tempPassword = randomToken(12);
        const u = await sys((tx) => tx.user.create({ data: { email: req.body.email.toLowerCase(), name: req.body.name, platformRole: req.body.role, passwordHash: bcrypt.hashSync(tempPassword, 12) } }));
        await adminAudit(req, 'admin_user.create', 'user', u.id, undefined, { email: u.email, role: u.platformRole });
        return reply.code(201).send({ id: u.id, tempPassword }); // shown once; TOTP enrolment forced on first login
      },
    );
    app.patch('/users/:id', { ...superOnly, schema: { tags: ['admin'], params: uuidParam, body: z.object({ status: z.enum(['active', 'disabled']).optional(), role: z.enum(['super_admin', 'reviewer', 'support']).optional(), resetTotp: z.boolean().optional() }) } }, async (req) => {
      if (req.params.id === req.admin!.sub && req.body.status === 'disabled') throw badRequest('You cannot disable yourself');
      const before = await sys((tx) => tx.user.findFirstOrThrow({ where: { id: req.params.id, platformRole: { not: null } } }));
      const after = await sys((tx) => tx.user.update({ where: { id: before.id }, data: { status: req.body.status, platformRole: req.body.role, totpSecretEnc: req.body.resetTotp ? null : undefined } }));
      if (req.body.status === 'disabled') await sys((tx) => tx.session.updateMany({ where: { userId: after.id, revokedAt: null }, data: { revokedAt: new Date() } }));
      await adminAudit(req, 'admin_user.update', 'user', after.id, { status: before.status, role: before.platformRole }, { status: after.status, role: after.platformRole, resetTotp: !!req.body.resetTotp });
      return { ok: true };
    });

    // ---------------- Plans & subscriptions ----------------
    app.get('/plans', { ...anyAdmin, schema: { tags: ['admin'] } }, async () => ({ items: await c.prisma.plan.findMany({ orderBy: { code: 'asc' } }) }));
    app.patch(
      '/plans/:code',
      { ...superOnly, schema: { tags: ['admin'], params: z.object({ code: z.enum(['starter', 'business', 'pro']) }), body: z.object({ name: z.string().optional(), priceMonthly: z.record(z.number()).optional(), limits: planLimitsSchema.optional(), providerPriceIds: z.record(z.record(z.string())).optional(), active: z.boolean().optional() }) } },
      async (req) => {
        const before = await c.prisma.plan.findUniqueOrThrow({ where: { code: req.params.code } });
        const after = await c.prisma.plan.update({ where: { code: req.params.code }, data: req.body });
        await adminAudit(req, 'plan.update', 'plan', after.id, before, after);
        return after;
      },
    );
    app.get('/subscriptions', { ...anyAdmin, schema: { tags: ['admin'] } }, async () => ({
      items: await sys((tx) => tx.subscription.findMany({ include: { tenant: { select: { name: true, slug: true, status: true } } }, orderBy: { updatedAt: 'desc' }, take: 200 })),
    }));

    // ---------------- Usage & cost ----------------
    app.get('/usage', { ...anyAdmin, schema: { tags: ['admin'], querystring: z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }) } }, async (req) => {
      const rows = await sys((tx) => tx.usageCounter.findMany({ where: { period: req.query.period ?? currentPeriod() }, include: { tenant: { select: { name: true, slug: true } } }, orderBy: { aiCostMicros: 'desc' } }));
      return { items: rows.map((r) => ({ tenant: r.tenant.name, slug: r.tenant.slug, tenantId: r.tenantId, period: r.period, messages: r.messages, ocrPages: r.ocrPages, aiTokens: r.aiTokens, aiCostUsd: Number(r.aiCostMicros) / 1e6, invoicesSent: r.invoicesSent })) };
    });

    // ---------------- Templates ----------------
    app.get('/templates', { ...anyAdmin, schema: { tags: ['admin'] } }, async () => ({ items: await c.prisma.messageTemplate.findMany({ orderBy: [{ key: 'asc' }, { language: 'asc' }] }) }));
    app.put(
      '/templates',
      { ...superOnly, schema: { tags: ['admin'], body: z.object({ key: z.string().min(2), name: z.string().min(2), language: z.enum(['en', 'ml', 'ar']), params: z.array(z.string()), category: z.string().default('UTILITY') }) } },
      async (req) => {
        const r = await c.prisma.messageTemplate.upsert({ where: { key_language: { key: req.body.key, language: req.body.language } }, update: req.body, create: req.body });
        await adminAudit(req, 'template.upsert', 'template', r.id, undefined, req.body);
        return r;
      },
    );

    // ---------------- Audit log ----------------
    app.get(
      '/audit',
      {
        ...anyAdmin,
        schema: { tags: ['admin'], querystring: z.object({ tenantId: z.string().uuid().optional(), action: z.string().max(80).optional(), actorId: z.string().uuid().optional(), from: z.string().optional(), to: z.string().optional(), cursor: z.string().uuid().optional() }) },
      },
      async (req) => {
        const q = req.query;
        const items = await sys((tx) =>
          tx.auditLog.findMany({
            where: {
              tenantId: q.tenantId,
              actorId: q.actorId,
              action: q.action ? { startsWith: q.action } : undefined,
              createdAt: { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined },
            },
            orderBy: { createdAt: 'desc' },
            take: 101,
            ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
          }),
        );
        return { items: items.slice(0, 100), nextCursor: items.length > 100 ? items[99]!.id : null };
      },
    );

    // ---------------- Feature flags ----------------
    app.get('/flags', { ...anyAdmin, schema: { tags: ['admin'] } }, async () => ({ items: await sys((tx) => tx.featureFlag.findMany({ orderBy: { key: 'asc' } })) }));
    app.put('/flags', { ...superOnly, schema: { tags: ['admin'], body: z.object({ key: z.string().regex(/^[a-z0-9_:.-]+$/), tenantId: z.string().uuid().nullable(), enabled: z.boolean() }) } }, async (req) => {
      const existing = await sys((tx) => tx.featureFlag.findFirst({ where: { key: req.body.key, tenantId: req.body.tenantId } }));
      const flag = existing
        ? await sys((tx) => tx.featureFlag.update({ where: { id: existing.id }, data: { enabled: req.body.enabled } }))
        : await sys((tx) => tx.featureFlag.create({ data: req.body }));
      await adminAudit(req, 'flag.set', 'feature_flag', flag.id, existing, flag, req.body.tenantId ?? undefined);
      return flag;
    });

    // ---------------- System health ----------------
    app.get('/health', { ...anyAdmin, schema: { tags: ['admin'] } }, async () => {
      const check = async (f: () => Promise<unknown>) => {
        const start = Date.now();
        try {
          await f();
          return { ok: true, latencyMs: Date.now() - start };
        } catch (e) {
          return { ok: false, latencyMs: Date.now() - start, error: (e as Error).message.slice(0, 120) };
        }
      };
      const tenants = await sys((tx) => tx.tenant.findMany({ where: { status: { not: 'suspended' } }, select: { id: true, name: true, erpSiteUrl: true } }));
      const erp = await Promise.all(
        tenants.map(async (tn) => {
          const h = await c.redis.get(`health:erp:${tn.id}`);
          return { tenantId: tn.id, name: tn.name, siteUrl: tn.erpSiteUrl, ...(h ? JSON.parse(h) : { ok: null }) };
        }),
      );
      return {
        postgres: await check(() => c.prisma.$queryRaw`SELECT 1`),
        redis: await check(() => c.redis.ping()),
        r2: await check(async () => {
          if (c.storage instanceof R2Storage) await (c.storage as unknown as { s3: { send: (x: unknown) => Promise<unknown> } }).s3.send(new HeadObjectCommand({ Bucket: env().R2_BUCKET, Key: 'healthcheck' })).catch((e: { name?: string }) => {
            if (e.name !== 'NotFound') throw e;
          });
        }),
        chatwoot: await check(async () => {
          const r = await fetch(env().CHATWOOT_BASE_URL, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
          if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
        }),
        erpnext: erp,
      };
    });

    // ---------------- Jobs ----------------
    app.get('/jobs', { ...superOnly, schema: { tags: ['admin'] } }, async () => {
      if (!(c.queue instanceof BullJobQueue)) return { queues: [] };
      const queues = await Promise.all(
        [...c.queue.allQueues()].map(async (q) => ({ name: q.name, counts: await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed') })),
      );
      return { queues };
    });
    app.post('/jobs/:queue/retry-failed', { ...superOnly, schema: { tags: ['admin'], params: z.object({ queue: z.enum(Object.values(QUEUES) as [string, ...string[]]) }) } }, async (req) => {
      if (!(c.queue instanceof BullJobQueue)) return { retried: 0 };
      const q = c.queue.queue(req.params.queue as never);
      const failed = await q.getFailed(0, 500);
      await Promise.all(failed.map((j) => j.retry()));
      await adminAudit(req, 'jobs.retry_failed', 'queue', req.params.queue, undefined, { count: failed.length });
      return { retried: failed.length };
    });
  };
