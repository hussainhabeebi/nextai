import { LIFECYCLE_ROLES, REMINDER_AUDIENCES, lifecycleSettingsSchema, normalizePhone, tenantSettingsSchema } from '@nextai/shared';
import type { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { Container } from '../../container.js';
import { randomToken } from '../../lib/crypto.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../modules/audit/audit.js';
import { installDefaultPlaybook } from '../../modules/lifecycle/engine.js';
import { lifecycleReport } from '../../modules/lifecycle/report.js';
import { sealLeadWebhookSecret } from '../../modules/tenants/secrets.js';

function requireRole(req: FastifyRequest, roles: string[]) {
  if (!req.user?.role || !roles.includes(req.user.role)) throw forbidden('Only the business owner can do this');
}

const role = z.enum(LIFECYCLE_ROLES);
const audience = z.enum(REMINDER_AUDIENCES);
/** -60 days … +400 days, in minutes. */
const offset = z.number().int().min(-60 * 1440).max(400 * 1440);
const phoneFor = (raw: string, country: 'IN' | 'AE') => {
  try {
    return normalizePhone(raw, country);
  } catch {
    throw badRequest('Invalid phone number');
  }
};
const levelBody = z.object({
  offsetMinutes: offset,
  audience,
  templateKey: z.string().regex(/^[a-z0-9_]{2,60}$/).default('lifecycle_notice'),
  message: z.string().min(1).max(1000),
  enabled: z.boolean().default(true),
});

/**
 * Sales pipeline (lead-to-customer lifecycle) for the logged-in business: staff, playbook rules and their
 * reminder levels (each can be created, edited, switched off or deleted), timers, report and settings.
 * Tenant-scoped through tenantDb (RLS) for the business in the login token; every change is audited.
 */
export const lifecycleRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    // Owner manages; the business's accountant can view. Business = the logged-in user's (never from the URL).
    const viewer = { preHandler: async (req: FastifyRequest) => requireRole(req, ['owner', 'tenant_accountant']) };
    const owner = { preHandler: async (req: FastifyRequest) => requireRole(req, ['owner']) };
    const logChange = (req: FastifyRequest, tenantId: string, action: string, entity: string, entityId?: string, before?: unknown, after?: unknown) =>
      audit(c.prisma, { tenantId, actorId: req.user!.sub, actorType: 'user', channel: 'app', action, entity, entityId, before, after, ip: req.ip });

    app.get('/lifecycle', { ...viewer, schema: { tags: ['app'] } }, async (req) => {
      const t = req.tenant!;
      const db = tenantDb(c.prisma, t.id);
      const [rules, staff, open] = await Promise.all([
        db.lifecycleRule.findMany({ include: { levels: { orderBy: { level: 'asc' } } }, orderBy: [{ stage: 'asc' }, { key: 'asc' }] }),
        db.staffMember.findMany({ orderBy: { name: 'asc' } }),
        db.lifecycleTimer.groupBy({ by: ['ruleId'], where: { status: 'open' }, _count: true }),
      ]);
      return {
        rules: rules.map((r) => ({ ...r, openTimers: open.find((o) => o.ruleId === r.id)?._count ?? 0 })),
        staff,
        leadWebhook: { configured: !!t.leadWebhookSecretEnc, url: `${env().API_URL}/webhooks/leadvyne/${t.slug}` },
        erpWebhookUrl: `${env().API_URL}/webhooks/erpnext/${t.slug}`,
        settings: tenantSettingsSchema.parse(t.settings ?? {}).lifecycle,
      };
    });

    app.post('/lifecycle/install', { ...owner, schema: { tags: ['app'] } }, async (req) => {
      const t = req.tenant!;
      const r = await installDefaultPlaybook(c.prisma, t.id);
      await logChange(req, t.id, 'lifecycle.install', 'lifecycle_rule', undefined, undefined, r);
      return r;
    });

    // ---------------- Rules ----------------
    app.patch(
      '/lifecycle/rules/:ruleId',
      {
        ...owner,
        schema: {
          tags: ['app'],
          params: z.object({ ruleId: z.string().uuid() }),
          body: z.object({ enabled: z.boolean(), name: z.string().min(2).max(140), ownerRole: role, escalationRole: role }).partial(),
        },
      },
      async (req) => {
        const db = tenantDb(c.prisma, req.tenant!.id);
        const before = await db.lifecycleRule.findFirst({ where: { id: req.params.ruleId } });
        if (!before) throw notFound('Rule');
        const after = await db.lifecycleRule.update({ where: { id: before.id }, data: req.body });
        await logChange(req, req.tenant!.id, 'lifecycle.rule.update', 'lifecycle_rule', after.id, before, after);
        return after;
      },
    );

    // ---------------- Reminder levels ----------------
    app.post(
      '/lifecycle/rules/:ruleId/levels',
      { ...owner, schema: { tags: ['app'], params: z.object({ ruleId: z.string().uuid() }), body: levelBody } },
      async (req) => {
        const tenantId = req.tenant!.id;
        const db = tenantDb(c.prisma, tenantId);
        const rule = await db.lifecycleRule.findFirst({ where: { id: req.params.ruleId }, include: { levels: true } });
        if (!rule) throw notFound('Rule');
        const level = Math.max(0, ...rule.levels.map((l) => l.level)) + 1;
        const created = await db.reminderLevel.create({ data: { ...req.body, tenantId, ruleId: rule.id, level } });
        await logChange(req, tenantId, 'lifecycle.level.create', 'reminder_level', created.id, undefined, created);
        return created;
      },
    );

    app.patch(
      '/lifecycle/levels/:levelId',
      { ...owner, schema: { tags: ['app'], params: z.object({ levelId: z.string().uuid() }), body: levelBody.partial() } },
      async (req) => {
        const tenantId = req.tenant!.id;
        const db = tenantDb(c.prisma, tenantId);
        const before = await db.reminderLevel.findFirst({ where: { id: req.params.levelId } });
        if (!before) throw notFound('Reminder level');
        if (Object.keys(req.body).length === 0) throw badRequest('Nothing to change');
        const after = await db.reminderLevel.update({ where: { id: before.id }, data: req.body });
        await logChange(req, tenantId, 'lifecycle.level.update', 'reminder_level', after.id, before, after);
        return after;
      },
    );

    app.delete('/lifecycle/levels/:levelId', { ...owner, schema: { tags: ['app'], params: z.object({ levelId: z.string().uuid() }) } }, async (req) => {
      const tenantId = req.tenant!.id;
      const db = tenantDb(c.prisma, tenantId);
      const before = await db.reminderLevel.findFirst({ where: { id: req.params.levelId } });
      if (!before) throw notFound('Reminder level');
      await db.reminderLevel.delete({ where: { id: before.id } });
      await logChange(req, tenantId, 'lifecycle.level.delete', 'reminder_level', before.id, before, undefined);
      return { ok: true };
    });

    // ---------------- Staff ----------------
    const staffBody = z.object({
      name: z.string().min(1).max(100),
      phone: z.string().min(5).max(30),
      erpUser: z.string().max(140).nullable().optional(),
      roles: z.array(role).min(1),
      active: z.boolean().default(true),
    });

    app.post('/staff', { ...owner, schema: { tags: ['app'], body: staffBody } }, async (req) => {
      const t = req.tenant!;
      const db = tenantDb(c.prisma, t.id);
      const created = await db.staffMember.create({ data: { ...req.body, phone: phoneFor(req.body.phone, t.country), tenantId: t.id } });
      await logChange(req, t.id, 'lifecycle.staff.create', 'staff_member', created.id, undefined, created);
      return created;
    });

    app.patch(
      '/staff/:staffId',
      { ...owner, schema: { tags: ['app'], params: z.object({ staffId: z.string().uuid() }), body: staffBody.partial() } },
      async (req) => {
        const t = req.tenant!;
        const db = tenantDb(c.prisma, t.id);
        const before = await db.staffMember.findFirst({ where: { id: req.params.staffId } });
        if (!before) throw notFound('Staff member');
        const data = { ...req.body, ...(req.body.phone ? { phone: phoneFor(req.body.phone, t.country) } : {}) };
        const after = await db.staffMember.update({ where: { id: before.id }, data });
        await logChange(req, t.id, 'lifecycle.staff.update', 'staff_member', after.id, before, after);
        return after;
      },
    );

    // ---------------- Timers ----------------
    app.get(
      '/lifecycle/timers',
      { ...viewer, schema: { tags: ['app'], querystring: z.object({ status: z.enum(['open', 'done', 'cancelled']).default('open'), ruleKey: z.string().max(60).optional() }) } },
      async (req) => {
        const db = tenantDb(c.prisma, req.tenant!.id);
        const items = await db.lifecycleTimer.findMany({
          where: { status: req.query.status, ...(req.query.ruleKey ? { rule: { key: req.query.ruleKey } } : {}) },
          include: { rule: { select: { key: true, name: true, stage: true } }, owner: { select: { name: true } } },
          orderBy: { anchorAt: req.query.status === 'open' ? 'asc' : 'desc' },
          take: 200,
        });
        return { items };
      },
    );

    app.post(
      '/lifecycle/timers/:timerId/close',
      { ...owner, schema: { tags: ['app'], params: z.object({ timerId: z.string().uuid() }), body: z.object({ status: z.enum(['done', 'cancelled']).default('done') }) } },
      async (req) => {
        const tenantId = req.tenant!.id;
        const db = tenantDb(c.prisma, tenantId);
        const r = await db.lifecycleTimer.updateMany({ where: { id: req.params.timerId, status: 'open' }, data: { status: req.body.status, completedAt: new Date() } });
        if (r.count === 0) throw notFound('Open timer');
        await logChange(req, tenantId, 'lifecycle.timer.close', 'lifecycle_timer', req.params.timerId, undefined, req.body);
        return { ok: true };
      },
    );

    // ---------------- Settings & report ----------------
    app.patch('/lifecycle/settings', { ...owner, schema: { tags: ['app'], body: lifecycleSettingsSchema.partial() } }, async (req) => {
      const t = req.tenant!;
      const current = tenantSettingsSchema.parse(t.settings ?? {});
      const lifecycle = lifecycleSettingsSchema.parse({ ...current.lifecycle, ...req.body });
      const settings = { ...(t.settings as object), lifecycle } as Prisma.InputJsonValue;
      await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: t.id }, data: { settings } }));
      await logChange(req, t.id, 'lifecycle.settings', 'tenant', t.id, current.lifecycle, lifecycle);
      return lifecycle;
    });

    app.get(
      '/lifecycle/report',
      { ...viewer, schema: { tags: ['app'], querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) } },
      async (req) => lifecycleReport(c, req.tenant!.id, req.query.days),
    );

    // ---------------- Lead webhook secret ----------------
    /** Generates (or rotates) the Leadvyne signing secret. It is shown once; only the ciphertext is stored. */
    app.post('/lifecycle/lead-webhook-secret', { ...owner, schema: { tags: ['app'] } }, async (req) => {
      const t = req.tenant!;
      const secret = randomToken(32);
      await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: t.id }, data: { leadWebhookSecretEnc: sealLeadWebhookSecret(t.id, secret) } }));
      await logChange(req, t.id, 'lifecycle.lead_webhook.rotate', 'tenant', t.id);
      return { secret, url: `${env().API_URL}/webhooks/leadvyne/${t.slug}` };
    });
  };
