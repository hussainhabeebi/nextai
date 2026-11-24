import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';
import { incrementUsage } from '../usage/usage.js';
import { setAwait } from './assistant.js';
import { computePerformance, formatPerformance } from './performance.js';
import { meetingWhen } from './service.js';
import { activeStaff, fmtTime, hhmmToMinutes, localNow, officeSettings, once, sendStaff, sendStaffMany, staffWithRole, tzOf } from './util.js';

/** Scheduled office actions fire inside this window after their time (a worker restart later in the day does not send stale nudges). */
const WINDOW_MIN = 120;
const inWindow = (minutes: number, at: number) => minutes >= at && minutes < at + WINDOW_MIN;

/**
 * office.tick — every 5 minutes for tenants with staff and the office enabled:
 *   daily presence reset (leave / out) · late check-in nudge + management list · end-of-day check-out prompt ·
 *   AI team summary · meeting reminders and notes requests · weekly performance report.
 */
export async function officeTick(c: Container, tenant: Tenant, now = new Date()) {
  const cfg = officeSettings(tenant);
  if (!cfg.enabled || !tenant.cwBotTokenEnc) return { skipped: true };
  const db = tenantDb(c.prisma, tenant.id);
  const staff = await activeStaff(c.prisma, tenant.id);
  if (staff.length === 0) return { skipped: true };
  const tz = tzOf(tenant);
  const { date, minutes, weekday } = localNow(tz, now);
  const workday = cfg.workDays.includes(weekday);
  const key = (k: string) => `office:${k}:${tenant.id}:${date}`;
  const done: string[] = [];

  const leaves = await db.leaveRequest.findMany({ where: { status: 'approved', fromDate: { lte: date }, toDate: { gte: date } } });
  const onLeave = new Set(leaves.map((l) => l.staffId));
  const attendance = await db.attendance.findMany({ where: { date } });
  const att = new Map(attendance.map((a) => [a.staffId, a]));

  // 1. New day: people on leave show as 🌴, everyone else who is not checked in today shows as out.
  await once(c, key('reset'), 30 * 3600, async () => {
    for (const s of staff) {
      const presence = onLeave.has(s.id) ? 'leave' : att.get(s.id)?.checkInAt && !att.get(s.id)?.checkOutAt ? s.presence : 'out';
      if (presence !== s.presence) await db.staffMember.update({ where: { id: s.id }, data: { presence, presenceNote: null, presenceAt: now } });
    }
    done.push('reset');
  });

  const lateAt = hhmmToMinutes(cfg.workStart) + cfg.lateAfterMinutes;
  const eod = hhmmToMinutes(cfg.endOfDay);
  const mgmt = await staffWithRole(c.prisma, tenant.id, 'management');

  // 2. Late: nudge everyone not checked in; tell management who is missing / on leave.
  if (workday && inWindow(minutes, lateAt)) {
    await once(c, key('late'), 30 * 3600, async () => {
      const missing = staff.filter((s) => !onLeave.has(s.id) && !att.get(s.id)?.checkInAt);
      for (const s of missing) await sendStaff(c, tenant, s, `⏰ Good morning ${s.name.split(' ')[0]}! You haven't checked in yet — reply "in" when you start.`, `office:nudge:${date}:${s.id}`);
      const leaveNames = staff.filter((s) => onLeave.has(s.id)).map((s) => s.name);
      if (missing.length || leaveNames.length) {
        const msg = [`🕘 ${cfg.workStart} check-in — ${staff.length - missing.length - leaveNames.length}/${staff.length} in.`];
        if (missing.length) msg.push(`Not checked in: ${missing.map((s) => s.name).join(', ')}`);
        if (leaveNames.length) msg.push(`On leave: ${leaveNames.join(', ')}`);
        await sendStaffMany(c, tenant, mgmt.filter((m) => !missing.some((x) => x.id === m.id)), msg.join('\n'), `office:late:${date}`);
      }
      done.push('late');
    });
  }

  // 3. End of day: ask whoever is still checked in to check out and share what they finished.
  if (workday && inWindow(minutes, eod)) {
    await once(c, key('eod'), 30 * 3600, async () => {
      for (const a of attendance.filter((x) => x.checkInAt && !x.checkOutAt)) {
        const s = staff.find((x) => x.id === a.staffId);
        if (s) await sendStaff(c, tenant, s, `🌇 It's ${cfg.endOfDay}. Reply "out" when you leave, and I'll ask what you finished today.`, `office:eod:${date}:${s.id}`);
      }
      done.push('eod');
    });
  }

  // 4. Team summary (AI) to management, an hour after end of day.
  if (workday && cfg.teamSummaryEnabled && inWindow(minutes, eod + 60) && mgmt.length) {
    await once(c, key('summary'), 30 * 3600, async () => {
      const standups = await db.standup.findMany({ where: { date } });
      const lines = staff.map((s) => {
        const a = att.get(s.id);
        const st = standups.find((x) => x.staffId === s.id);
        const status = onLeave.has(s.id) ? 'on leave' : !a?.checkInAt ? 'absent / not checked in' : `in ${fmtTime(a.checkInAt, tz)}${a.late ? ' (late)' : ''}${a.checkOutAt ? `, out ${fmtTime(a.checkOutAt, tz)}` : ', not checked out'}`;
        return [`${s.name}: ${status}`, st?.plan && `  plan: ${st.plan}`, st?.blockers && `  BLOCKER: ${st.blockers}`, st?.done && `  done: ${st.done}`, st?.handover && `  handover: ${st.handover}`].filter(Boolean).join('\n');
      });
      const context = `Team day ${date}\n${lines.join('\n')}`;
      const { text, usage } = await c.ai.llm.summarize('Summarise the team\'s day for the manager: attendance, what got done, blockers and risks for tomorrow.', context);
      if (usage.tokens) await incrementUsage(c.prisma, tenant.id, { aiTokens: usage.tokens, aiCostMicros: usage.costMicros });
      const inCount = staff.filter((s) => att.get(s.id)?.checkInAt).length;
      await sendStaffMany(c, tenant, mgmt, `📊 Team day — ${date} (${inCount}/${staff.length} in)\n${text || lines.join('\n')}`, `office:summary:${date}`);
      done.push('summary');
    });
  }

  // 5. Meetings: reminder before; notes request to the organizer after it ends.
  const soon = new Date(now.getTime() + cfg.meetingReminderMinutes * 60000);
  for (const m of await db.meeting.findMany({ where: { status: 'scheduled', remindedAt: null, startsAt: { lte: soon, gt: now } } })) {
    const claim = await db.meeting.updateMany({ where: { id: m.id, remindedAt: null }, data: { remindedAt: now } });
    if (claim.count === 0) continue;
    const who = staff.filter((s) => m.attendeeIds.includes(s.id));
    await sendStaffMany(c, tenant, who, `⏰ Meeting #${m.code} "${m.title}" starts at ${fmtTime(m.startsAt, tz)} (${who.map((s) => s.name).join(', ')}).`, `office:remind:${m.id}`);
    done.push(`remind#${m.code}`);
  }
  const ended = await db.meeting.findMany({ where: { status: 'scheduled', notesAskedAt: null, startsAt: { lte: now, gte: new Date(now.getTime() - 24 * 3600_000) } } });
  for (const m of ended.filter((x) => x.startsAt.getTime() + x.durationMin * 60000 <= now.getTime())) {
    const claim = await db.meeting.updateMany({ where: { id: m.id, notesAskedAt: null }, data: { notesAskedAt: now } });
    if (claim.count === 0) continue;
    const organizer = staff.find((s) => s.id === (m.organizerId ?? m.attendeeIds[0]));
    if (!organizer) continue;
    await setAwait(c, tenant.id, organizer.id, { kind: 'notes', code: m.code }, 12 * 3600);
    await sendStaff(
      c,
      tenant,
      organizer,
      `📝 Meeting #${m.code} "${m.title}" (${meetingWhen(tenant, m.startsAt)}) — send the notes. Lines starting with "-" become tasks, e.g.\n- Esha: update the menu by Friday\n- Akshay: test checkout`,
      `office:notesask:${m.id}`,
    );
    done.push(`notes#${m.code}`);
  }

  // 6. Weekly performance report to management.
  if (cfg.weeklyReport.enabled && weekday === cfg.weeklyReport.weekday && inWindow(minutes, cfg.weeklyReport.hourLocal * 60) && mgmt.length) {
    await once(c, key('weekly'), 8 * 86400, async () => {
      const perf = await computePerformance(c, tenant, 7, now);
      await sendStaffMany(c, tenant, mgmt, formatPerformance(perf, 'last 7 days'), `office:weekly:${date}`);
      done.push('weekly');
    });
  }
  return { done };
}
