import { LIFECYCLE_ROLES, REMINDER_AUDIENCES, lifecycleSettingsSchema, normalizePhone, tenantSettingsSchema } from '@nextai/shared';
import type { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { Container } from '../../container.js';
import { randomToken } from '../../lib/crypto.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../modules/audit/audit.js';
import { installDefaultPlaybook } from '../../modules/lifecycle/engine.js';
import { lifecycleReport } from '../../modules/lifecycle/report.js';
import { sealLeadWebhookSecret } from '../../modules/tenants/secrets.js';

const tenantParam = z.object({ id: z.string().uuid() });
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
 * Lifecycle (lead-to-customer) admin: staff, playbook rules and their reminder levels — each level can be
 * created, edited, switched off or deleted per tenant. Tenant-scoped through tenantDb (RLS) for the tenant
 * chosen in the URL; every change is audited.
 */
export const lifecycleAdminRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    const anyAdmin = { onRequest: app.requireAdmin() };
    const ops = { onRequest: app.requireAdmin(['super_admin', 'support']) };
    const logChange = (req: FastifyRequest, tenantId: string, action: string, entity: string, entityId?: string, before?: unknown, after?: unknown) =>
      audit(c.prisma, { tenantId, actorId: req.admin!.sub, actorType: 'admin', channel: 'admin', action, entity, entityId, before, after, ip: req.ip });
    const tenantOr404 = async (id: string) => {
      const t = await withSystemTx(c.prisma, (tx) => tx.tenant.findUnique({ where: { id } }));
      if (!t) throw notFound('Tenant');
      return t;
    };

    app.get('/tenants/:id/lifecycle', { ...anyAdmin, schema: { tags: ['admin'], params: tenantParam } }, async (req) => {
      const t = await tenantOr404(req.params.id);
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

    app.post('/tenants/:id/lifecycle/install', { ...ops, schema: { tags: ['admin'], params: tenantParam } }, async (req) => {
      const t = await tenantOr404(req.params.id);
      const r = await installDefaultPlaybook(c.prisma, t.id);
      await logChange(req, t.id, 'lifecycle.install', 'lifecycle_rule', undefined, undefined, r);
      return r;
    });

    // ---------------- Rules ----------------
    app.patch(
      '/tenants/:id/lifecycle/rules/:ruleId',
      {
        ...ops,
        schema: {
          tags: ['admin'],
          params: tenantParam.extend({ ruleId: z.string().uuid() }),
          body: z.object({ enabled: z.boolean(), name: z.string().min(2).max(140), ownerRole: role, escalationRole: role }).partial(),
        },
      },
      async (req) => {
        const db = tenantDb(c.prisma, (await tenantOr404(req.params.id)).id);
        const before = await db.lifecycleRule.findFirst({ where: { id: req.params.ruleId } });
        if (!before) throw notFound('Rule');
        const after = await db.lifecycleRule.update({ where: { id: before.id }, data: req.body });
        await logChange(req, req.params.id, 'lifecycle.rule.update', 'lifecycle_rule', after.id, before, after);
        return after;
      },
    );

    // ---------------- Reminder levels ----------------
    app.post(
      '/tenants/:id/lifecycle/rules/:ruleId/levels',
      { ...ops, schema: { tags: ['admin'], params: tenantParam.extend({ ruleId: z.string().uuid() }), body: levelBody } },
      async (req) => {
        const tenantId = (await tenantOr404(req.params.id)).id;
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
      '/tenants/:id/lifecycle/levels/:levelId',
      { ...ops, schema: { tags: ['admin'], params: tenantParam.extend({ levelId: z.string().uuid() }), body: levelBody.partial() } },
      async (req) => {
        const tenantId = (await tenantOr404(req.params.id)).id;
        const db = tenantDb(c.prisma, tenantId);
        const before = await db.reminderLevel.findFirst({ where: { id: req.params.levelId } });
        if (!before) throw notFound('Reminder level');
        if (Object.keys(req.body).length === 0) throw badRequest('Nothing to change');
        const after = await db.reminderLevel.update({ where: { id: before.id }, data: req.body });
        await logChange(req, tenantId, 'lifecycle.level.update', 'reminder_level', after.id, before, after);
        return after;
      },
    );

    app.delete('/tenants/:id/lifecycle/levels/:levelId', { ...ops, schema: { tags: ['admin'], params: tenantParam.extend({ levelId: z.string().uuid() }) } }, async (req) => {
      const tenantId = (await tenantOr404(req.params.id)).id;
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

    app.post('/tenants/:id/staff', { ...ops, schema: { tags: ['admin'], params: tenantParam, body: staffBody } }, async (req) => {
      const t = await tenantOr404(req.params.id);
      const db = tenantDb(c.prisma, t.id);
      const created = await db.staffMember.create({ data: { ...req.body, phone: phoneFor(req.body.phone, t.country), tenantId: t.id } });
      await logChange(req, t.id, 'lifecycle.staff.create', 'staff_member', created.id, undefined, created);
      return created;
    });

    app.patch(
      '/tenants/:id/staff/:staffId',
      { ...ops, schema: { tags: ['admin'], params: tenantParam.extend({ staffId: z.string().uuid() }), body: staffBody.partial() } },
      async (req) => {
        const t = await tenantOr404(req.params.id);
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
      '/tenants/:id/lifecycle/timers',
      { ...anyAdmin, schema: { tags: ['admin'], params: tenantParam, querystring: z.object({ status: z.enum(['open', 'done', 'cancelled']).default('open'), ruleKey: z.string().max(60).optional() }) } },
      async (req) => {
        const db = tenantDb(c.prisma, (await tenantOr404(req.params.id)).id);
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
      '/tenants/:id/lifecycle/timers/:timerId/close',
      { ...ops, schema: { tags: ['admin'], params: tenantParam.extend({ timerId: z.string().uuid() }), body: z.object({ status: z.enum(['done', 'cancelled']).default('done') }) } },
      async (req) => {
        const tenantId = (await tenantOr404(req.params.id)).id;
        const db = tenantDb(c.prisma, tenantId);
        const r = await db.lifecycleTimer.updateMany({ where: { id: req.params.timerId, status: 'open' }, data: { status: req.body.status, completedAt: new Date() } });
        if (r.count === 0) throw notFound('Open timer');
        await logChange(req, tenantId, 'lifecycle.timer.close', 'lifecycle_timer', req.params.timerId, undefined, req.body);
        return { ok: true };
      },
    );

    // ---------------- Settings & report ----------------
    app.patch('/tenants/:id/lifecycle/settings', { ...ops, schema: { tags: ['admin'], params: tenantParam, body: lifecycleSettingsSchema.partial() } }, async (req) => {
      const t = await tenantOr404(req.params.id);
      const current = tenantSettingsSchema.parse(t.settings ?? {});
      const lifecycle = lifecycleSettingsSchema.parse({ ...current.lifecycle, ...req.body });
      const settings = { ...(t.settings as object), lifecycle } as Prisma.InputJsonValue;
      await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: t.id }, data: { settings } }));
      await logChange(req, t.id, 'lifecycle.settings', 'tenant', t.id, current.lifecycle, lifecycle);
      return lifecycle;
    });

    app.get(
      '/tenants/:id/lifecycle/report',
      { ...anyAdmin, schema: { tags: ['admin'], params: tenantParam, querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) } },
      async (req) => lifecycleReport(c, (await tenantOr404(req.params.id)).id, req.query.days),
    );

    // ---------------- Lead webhook secret ----------------
    /** Generates (or rotates) the Leadvyne signing secret. It is shown once; only the ciphertext is stored. */
    app.post('/tenants/:id/lifecycle/lead-webhook-secret', { onRequest: app.requireAdmin(['super_admin']), schema: { tags: ['admin'], params: tenantParam } }, async (req) => {
      const t = await tenantOr404(req.params.id);
      const secret = randomToken(32);
      await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: t.id }, data: { leadWebhookSecretEnc: sealLeadWebhookSecret(t.id, secret) } }));
      await logChange(req, t.id, 'lifecycle.lead_webhook.rotate', 'tenant', t.id);
      return { secret, url: `${env().API_URL}/webhooks/leadvyne/${t.slug}` };
    });
  };
