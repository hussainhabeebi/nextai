import { LIFECYCLE_ROLES, officeSettingsSchema, tenantSettingsSchema } from '@nextai/shared';
import type { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../modules/audit/audit.js';
import { officeFloor } from '../../modules/office/floor.js';
import { computePerformance } from '../../modules/office/performance.js';
import { announce, decideApproval } from '../../modules/office/service.js';
import { addDays, localNow, tzOf } from '../../modules/office/util.js';

function requireRole(req: FastifyRequest, roles: string[]) {
  if (!req.user?.role || !roles.includes(req.user.role)) throw forbidden('Only the business owner can do this');
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Virtual office for the logged-in business: live floor, attendance, stand-ups, approvals, announcements, meetings, performance, settings. */
export const officeRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    // Owner manages; the business's accountant can view. Business = the logged-in user's (never from the URL).
    const viewer = { preHandler: async (req: FastifyRequest) => requireRole(req, ['owner', 'tenant_accountant']) };
    const owner = { preHandler: async (req: FastifyRequest) => requireRole(req, ['owner']) };
    const logChange = (req: FastifyRequest, tenantId: string, action: string, entity: string, entityId?: string, before?: unknown, after?: unknown) =>
      audit(c.prisma, { tenantId, actorId: req.user!.sub, actorType: 'user', channel: 'app', action, entity, entityId, before, after, ip: req.ip });

    app.get('/office/floor', { ...viewer, schema: { tags: ['app'] } }, async (req) => officeFloor(c, req.tenant!));

    app.get(
      '/office/attendance',
      { ...viewer, schema: { tags: ['app'], querystring: z.object({ from: isoDate.optional(), to: isoDate.optional() }) } },
      async (req) => {
        const t = req.tenant!;
        const today = localNow(tzOf(t)).date;
        const to = req.query.to ?? today;
        const from = req.query.from ?? addDays(to, -6);
        const db = tenantDb(c.prisma, t.id);
        const [staff, rows, leaves] = await Promise.all([
          db.staffMember.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
          db.attendance.findMany({ where: { date: { gte: from, lte: to } }, orderBy: { date: 'desc' } }),
          db.leaveRequest.findMany({ where: { toDate: { gte: from }, fromDate: { lte: to } }, orderBy: { fromDate: 'desc' } }),
        ]);
        return {
          from,
          to,
          staff: staff.map((s) => ({ id: s.id, name: s.name })),
          rows: rows.map((r) => ({ ...r, staffName: staff.find((s) => s.id === r.staffId)?.name ?? '' })),
          leaves: leaves.map((l) => ({ ...l, staffName: staff.find((s) => s.id === l.staffId)?.name ?? '' })),
        };
      },
    );

    app.get('/office/standups', { ...viewer, schema: { tags: ['app'], querystring: z.object({ date: isoDate.optional() }) } }, async (req) => {
      const t = req.tenant!;
      const date = req.query.date ?? localNow(tzOf(t)).date;
      const db = tenantDb(c.prisma, t.id);
      const [staff, rows] = await Promise.all([db.staffMember.findMany({ where: { active: true }, orderBy: { name: 'asc' } }), db.standup.findMany({ where: { date } })]);
      return {
        date,
        items: staff.map((s) => {
          const r = rows.find((x) => x.staffId === s.id);
          return { staffId: s.id, name: s.name, plan: r?.plan ?? null, blockers: r?.blockers ?? null, done: r?.done ?? null, handover: r?.handover ?? null, handoverTo: staff.find((x) => x.id === r?.handoverToId)?.name ?? null };
        }),
      };
    });

    // ---------------- Approvals ----------------
    app.get(
      '/office/approvals',
      { ...viewer, schema: { tags: ['app'], querystring: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('pending') }) } },
      async (req) => {
        const t = req.tenant!;
        const db = tenantDb(c.prisma, t.id);
        const [items, staff] = await Promise.all([
          db.approval.findMany({ where: req.query.status === 'all' ? {} : { status: req.query.status }, orderBy: { code: 'desc' }, take: 200 }),
          db.staffMember.findMany(),
        ]);
        const nameOf = (id?: string | null) => (id?.startsWith('admin:') ? 'Admin' : id?.startsWith('app:') ? 'Owner' : (staff.find((s) => s.id === id)?.name ?? null));
        return { items: items.map((a) => ({ ...a, requestedBy: nameOf(a.requestedById), decidedByName: nameOf(a.decidedBy) })) };
      },
    );

    app.post(
      '/office/approvals/:code/decide',
      { ...owner, schema: { tags: ['app'], params: z.object({ code: z.coerce.number().int().positive() }), body: z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(500).optional() }) } },
      async (req) => {
        const t = req.tenant!;
        const r = await decideApproval(c, t, req.params.code, req.body.decision, { userId: req.user!.sub }, req.body.note);
        if ('error' in r) throw badRequest(r.error!);
        await logChange(req, t.id, `office.approval.${req.body.decision}`, 'approval', r.approval.id, undefined, req.body);
        return r.approval;
      },
    );

    // ---------------- Announcements ----------------
    app.get('/office/announcements', { ...viewer, schema: { tags: ['app'] } }, async (req) => {
      const t = req.tenant!;
      const db = tenantDb(c.prisma, t.id);
      const [items, staff] = await Promise.all([db.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }), db.staffMember.findMany()]);
      const name = (id: string) => staff.find((s) => s.id === id)?.name ?? '?';
      return {
        items: items.map((a) => ({
          id: a.id,
          text: a.text,
          roles: a.roles,
          createdAt: a.createdAt,
          from: a.fromStaffId ? name(a.fromStaffId) : 'Admin',
          acked: a.ackIds.map(name),
          pending: a.recipientIds.filter((r) => !a.ackIds.includes(r)).map(name),
        })),
      };
    });

    app.post(
      '/office/announcements',
      { ...owner, schema: { tags: ['app'], body: z.object({ text: z.string().min(1).max(2000), roles: z.array(z.enum(LIFECYCLE_ROLES)).default([]) }) } },
      async (req) => {
        const t = req.tenant!;
        const r = await announce(c, t, null, req.body.roles, req.body.text);
        await logChange(req, t.id, 'office.announce', 'announcement', r.announcement.id, undefined, req.body);
        return { id: r.announcement.id, recipients: r.recipients };
      },
    );

    // ---------------- Meetings ----------------
    app.get('/office/meetings', { ...viewer, schema: { tags: ['app'] } }, async (req) => {
      const t = req.tenant!;
      const db = tenantDb(c.prisma, t.id);
      const [items, staff] = await Promise.all([
        db.meeting.findMany({ where: { startsAt: { gte: new Date(Date.now() - 30 * 86400_000) } }, orderBy: { startsAt: 'desc' }, take: 100 }),
        db.staffMember.findMany(),
      ]);
      return {
        items: items.map((m) => ({
          ...m,
          organizer: staff.find((s) => s.id === m.organizerId)?.name ?? null,
          attendees: m.attendeeIds.map((id) => staff.find((s) => s.id === id)?.name ?? '?'),
        })),
      };
    });

    // ---------------- Performance ----------------
    app.get(
      '/office/performance',
      { ...viewer, schema: { tags: ['app'], querystring: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }) } },
      async (req) => ({ days: req.query.days, items: await computePerformance(c, req.tenant!, req.query.days) }),
    );

    // ---------------- Settings ----------------
    app.get('/office/settings', { ...viewer, schema: { tags: ['app'] } }, async (req) => {
      const t = req.tenant!;
      const staff = await tenantDb(c.prisma, t.id).staffMember.findMany({ orderBy: { name: 'asc' } });
      return {
        settings: tenantSettingsSchema.parse(t.settings ?? {}).office,
        /** The team's WhatsApp number is connected by NextAi support (Admin → Tenants); shown here, not editable. */
        staffNumberConnected: !!t.cwStaffInboxId,
        staff: staff.map((s) => ({ id: s.id, name: s.name, active: s.active, backupStaffId: s.backupStaffId, erpEmployee: s.erpEmployee })),
      };
    });

    app.patch('/office/settings', { ...owner, schema: { tags: ['app'], body: z.object({ settings: officeSettingsSchema.partial() }) } }, async (req) => {
      const t = req.tenant!;
      const current = tenantSettingsSchema.parse(t.settings ?? {});
      const office = officeSettingsSchema.parse({ ...current.office, ...req.body.settings });
      await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: t.id }, data: { settings: { ...(t.settings as object), office } as Prisma.InputJsonValue } }));
      await logChange(req, t.id, 'office.settings', 'tenant', t.id, current.office, office);
      return { settings: office };
    });

    app.patch(
      '/office/staff/:staffId',
      {
        ...owner,
        schema: {
          tags: ['app'],
          params: z.object({ staffId: z.string().uuid() }),
          body: z.object({ backupStaffId: z.string().uuid().nullable().optional(), erpEmployee: z.string().max(140).nullable().optional() }),
        },
      },
      async (req) => {
        const t = req.tenant!;
        const db = tenantDb(c.prisma, t.id);
        const before = await db.staffMember.findFirst({ where: { id: req.params.staffId } });
        if (!before) throw notFound('Staff member');
        if (req.body.backupStaffId === before.id) throw badRequest('Someone cannot be their own backup.');
        if (req.body.backupStaffId && !(await db.staffMember.findFirst({ where: { id: req.body.backupStaffId } }))) throw notFound('Backup');
        const after = await db.staffMember.update({ where: { id: before.id }, data: req.body });
        await logChange(req, t.id, 'office.staff.update', 'staff_member', after.id, { backupStaffId: before.backupStaffId, erpEmployee: before.erpEmployee }, req.body);
        return { id: after.id, backupStaffId: after.backupStaffId, erpEmployee: after.erpEmployee };
      },
    );
  };
