import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';
import { erpContext } from '../erpnext/mappers.js';
import { localNow, tzOf } from './util.js';

/** Live office view: one card per person plus office-wide counters. */
export async function officeFloor(c: Container, tenant: Tenant, now = new Date()) {
  const db = tenantDb(c.prisma, tenant.id);
  const { date } = localNow(tzOf(tenant), now);
  const [staff, attendance, standups, leaves, timers, approvals, meetings, announcements] = await Promise.all([
    db.staffMember.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    db.attendance.findMany({ where: { date } }),
    db.standup.findMany({ where: { date } }),
    db.leaveRequest.findMany({ where: { status: 'approved', fromDate: { lte: date }, toDate: { gte: date } } }),
    db.lifecycleTimer.findMany({ where: { status: 'open', rule: { enabled: true } }, include: { rule: { include: { levels: true } } } }),
    db.approval.count({ where: { status: 'pending' } }),
    db.meeting.findMany({ where: { status: 'scheduled', startsAt: { gte: new Date(now.getTime() - 3600_000), lte: new Date(now.getTime() + 24 * 3600_000) } }, orderBy: { startsAt: 'asc' } }),
    db.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 3 }),
  ]);
  const escalated = (t: (typeof timers)[number]) => t.rule.levels.some((l) => l.audience === 'escalation' && t.sentLevels.includes(l.level));
  const threshold = erpContext(tenant).settings.lifecycle.healthThreshold;
  const recentReviews = await db.lifecycleTimer.findMany({ where: { rule: { key: { in: ['review.day7', 'review.day30'] } }, updatedAt: { gte: new Date(now.getTime() - 30 * 86400_000) } } });
  const atRisk = recentReviews
    .map((t) => ({ customer: t.customerName ?? t.docName, project: t.docName, score: Number((t.context as Record<string, string>).health_score) }))
    .filter((x) => !Number.isNaN(x.score) && x.score < threshold);

  const cards = staff.map((s) => {
    const a = attendance.find((x) => x.staffId === s.id);
    const st = standups.find((x) => x.staffId === s.id);
    const mine = timers.filter((t) => t.ownerStaffId === s.id);
    const next = meetings.find((m) => m.attendeeIds.includes(s.id));
    return {
      id: s.id,
      name: s.name,
      roles: s.roles,
      presence: leaves.some((l) => l.staffId === s.id) ? 'leave' : s.presence,
      presenceNote: s.presenceNote,
      presenceAt: s.presenceAt,
      checkInAt: a?.checkInAt ?? null,
      checkOutAt: a?.checkOutAt ?? null,
      late: a?.late ?? false,
      plan: st?.plan ?? null,
      blockers: st?.blockers ?? null,
      done: st?.done ?? null,
      openSteps: mine.length,
      escalated: mine.filter(escalated).length,
      nextMeeting: next ? { code: next.code, title: next.title, startsAt: next.startsAt } : null,
    };
  });
  return {
    date,
    stats: {
      total: staff.length,
      in: cards.filter((x) => x.presence === 'in' || x.presence === 'busy').length,
      late: attendance.filter((a) => a.late).length,
      onLeave: cards.filter((x) => x.presence === 'leave').length,
      pendingApprovals: approvals,
      escalatedSteps: timers.filter(escalated).length,
      blockers: standups.filter((x) => x.blockers).length,
      atRiskCustomers: atRisk.length,
    },
    cards,
    meetings: meetings.map((m) => ({ code: m.code, title: m.title, startsAt: m.startsAt, attendees: staff.filter((s) => m.attendeeIds.includes(s.id)).map((s) => s.name) })),
    atRisk,
    announcements: announcements.map((a) => ({ id: a.id, text: a.text, createdAt: a.createdAt, recipients: a.recipientIds.length, acks: a.ackIds.length })),
  };
}
