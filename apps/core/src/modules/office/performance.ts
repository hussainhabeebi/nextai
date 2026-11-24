import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';
import { addDays, localNow, officeSettings, tzOf, weekdayOf } from './util.js';

export interface PerformanceRow {
  staffId: string;
  name: string;
  roles: string[];
  daysPresent: number;
  workDays: number;
  late: number;
  leaveDays: number;
  stepsDone: number;
  onTime: number; // done without an escalation level having fired
  escalated: number;
  openNow: number;
  dealsWon: number;
  issuesResolved: number;
  standups: number;
}

/** Per-person numbers for the last `days` days (attendance, lifecycle steps, deals, support). */
export async function computePerformance(c: Container, tenant: Tenant, days: number, now = new Date()): Promise<PerformanceRow[]> {
  const db = tenantDb(c.prisma, tenant.id);
  const tz = tzOf(tenant);
  const cfg = officeSettings(tenant);
  const today = localNow(tz, now).date;
  const from = addDays(today, -(days - 1));
  const since = new Date(now.getTime() - days * 86400_000);
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const workDates = dates.filter((d) => cfg.workDays.includes(weekdayOf(d)));

  const [staff, attendance, standups, leaves, done, open] = await Promise.all([
    db.staffMember.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    db.attendance.findMany({ where: { date: { gte: from, lte: today } } }),
    db.standup.findMany({ where: { date: { gte: from, lte: today } } }),
    db.leaveRequest.findMany({ where: { status: 'approved', toDate: { gte: from }, fromDate: { lte: today } } }),
    db.lifecycleTimer.findMany({ where: { status: 'done', completedAt: { gte: since } }, include: { rule: { include: { levels: true } } } }),
    db.lifecycleTimer.findMany({ where: { status: 'open' }, include: { rule: { include: { levels: true } } } }),
  ]);
  const escalatedT = (t: (typeof done)[number]) => t.rule.levels.some((l) => l.audience === 'escalation' && t.sentLevels.includes(l.level));
  // Notice-only steps (assignment, deal won, go-live…) have no deadline; they are not counted as work done.
  const isWork = (t: (typeof done)[number]) => t.rule.levels.some((l) => l.audience === 'escalation');

  return staff.map((s) => {
    const mine = done.filter((t) => t.ownerStaffId === s.id);
    const work = mine.filter(isWork);
    const leaveDays = workDates.filter((d) => leaves.some((l) => l.staffId === s.id && l.fromDate <= d && l.toDate >= d)).length;
    const att = attendance.filter((a) => a.staffId === s.id && a.checkInAt);
    return {
      staffId: s.id,
      name: s.name,
      roles: s.roles,
      daysPresent: att.length,
      workDays: workDates.length - leaveDays,
      late: att.filter((a) => a.late).length,
      leaveDays,
      stepsDone: work.length,
      onTime: work.filter((t) => !escalatedT(t)).length,
      escalated: [...work, ...open.filter((t) => t.ownerStaffId === s.id)].filter(escalatedT).length,
      openNow: open.filter((t) => t.ownerStaffId === s.id && isWork(t)).length,
      dealsWon: done.filter((t) => t.rule.key === 'deal.won' && t.ownerStaffId === s.id).length + open.filter((t) => t.rule.key === 'deal.won' && t.ownerStaffId === s.id && t.createdAt >= since).length,
      issuesResolved: mine.filter((t) => t.rule.key === 'support.issue').length,
      standups: standups.filter((x) => x.staffId === s.id && (x.plan || x.done)).length,
    };
  });
}

export function formatPerformance(rows: PerformanceRow[], period: string): string {
  const lines = [`📈 Team performance — ${period}`];
  for (const r of rows) {
    const onTimePct = r.stepsDone ? Math.round((r.onTime / r.stepsDone) * 100) : null;
    const parts = [
      `${r.daysPresent}/${r.workDays} days${r.late ? `, ${r.late} late` : ''}${r.leaveDays ? `, ${r.leaveDays} leave` : ''}`,
      `${r.stepsDone} steps${onTimePct !== null ? ` (${onTimePct}% on time)` : ''}`,
      r.escalated ? `${r.escalated} escalated` : '',
      r.openNow ? `${r.openNow} open` : '',
      r.dealsWon ? `${r.dealsWon} won` : '',
      r.issuesResolved ? `${r.issuesResolved} issues fixed` : '',
    ].filter(Boolean);
    lines.push(`• ${r.name}: ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}
