import { QUEUES } from '@nextai/shared';
import type { Approval, LifecycleRole, StaffMember, Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { CF } from '../lifecycle/events.js';
import {
  activeStaff,
  addDays,
  fmtDay,
  fmtTime,
  hhmmToMinutes,
  localNow,
  localToUtc,
  nextCode,
  officeSettings,
  parseDate,
  sendStaff,
  sendStaffMany,
  staffMentioned,
  staffWithRole,
  tzOf,
} from './util.js';

export const PROJECT_STAGES = ['Kickoff', 'Data Collection', 'Build', 'QA', 'Testing', 'Live', 'Hypercare'] as const;

// ---------------- Attendance ----------------

export async function checkIn(c: Container, tenant: Tenant, staff: StaffMember, note: string | undefined, now = new Date()) {
  const tz = tzOf(tenant);
  const cfg = officeSettings(tenant);
  const { date, minutes } = localNow(tz, now);
  const db = tenantDb(c.prisma, tenant.id);
  const existing = await db.attendance.findUnique({ where: { staffId_date: { staffId: staff.id, date } } });
  if (existing?.checkInAt && !existing.checkOutAt) return { already: true, attendance: existing, late: existing.late };
  const late = minutes > hhmmToMinutes(cfg.workStart) + cfg.lateAfterMinutes;
  const attendance = existing
    ? await db.attendance.update({ where: { id: existing.id }, data: { checkOutAt: null, note: note ?? existing.note } }) // back after checking out
    : await db.attendance.create({ data: { tenantId: tenant.id, staffId: staff.id, date, checkInAt: now, late, note } });
  await db.staffMember.update({ where: { id: staff.id }, data: { presence: 'in', presenceNote: note ?? null, presenceAt: now } });
  return { already: false, attendance, late: attendance.late };
}

export async function checkOut(c: Container, tenant: Tenant, staff: StaffMember, now = new Date()) {
  const tz = tzOf(tenant);
  const { date } = localNow(tz, now);
  const db = tenantDb(c.prisma, tenant.id);
  const a = await db.attendance.findUnique({ where: { staffId_date: { staffId: staff.id, date } } });
  await db.staffMember.update({ where: { id: staff.id }, data: { presence: 'out', presenceNote: null, presenceAt: now } });
  if (!a?.checkInAt) return { attendance: null, minutes: 0 };
  const attendance = await db.attendance.update({ where: { id: a.id }, data: { checkOutAt: now } });
  const cfg = officeSettings(tenant);
  if (cfg.attendanceErpSync && staff.erpEmployee && !a.erpSynced) {
    try {
      const erp = c.erp(tenant);
      const doc = await erp.create('Attendance', { employee: staff.erpEmployee, attendance_date: date, status: 'Present', late_entry: a.late ? 1 : 0 });
      await erp.submit('Attendance', String(doc.name));
      await db.attendance.update({ where: { id: a.id }, data: { erpSynced: true } });
    } catch (err) {
      logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'erp attendance sync failed');
    }
  }
  return { attendance, minutes: Math.round((now.getTime() - a.checkInAt.getTime()) / 60000) };
}

export async function setPresence(c: Container, tenant: Tenant, staff: StaffMember, presence: 'in' | 'busy', note?: string) {
  await tenantDb(c.prisma, tenant.id).staffMember.update({ where: { id: staff.id }, data: { presence, presenceNote: note ?? null, presenceAt: new Date() } });
}

// ---------------- Stand-up ----------------

const BLOCKER = /(?:^|\n)\s*(?:blocker|blocked|blocking|stuck|issue)s?\b\s*[:-]?\s*(.+)/i;

export async function saveStandup(c: Container, tenant: Tenant, staff: StaffMember, part: 'plan' | 'done', text: string, now = new Date()) {
  const { date } = localNow(tzOf(tenant), now);
  const db = tenantDb(c.prisma, tenant.id);
  const blockers = part === 'plan' ? (BLOCKER.exec(text)?.[1]?.trim() ?? null) : undefined;
  const data = part === 'plan' ? { plan: text, blockers } : { done: text };
  const row = await db.standup.upsert({
    where: { staffId_date: { staffId: staff.id, date } },
    create: { tenantId: tenant.id, staffId: staff.id, date, ...data },
    update: data,
  });
  if (blockers) {
    const mgmt = (await staffWithRole(c.prisma, tenant.id, 'management')).filter((m) => m.id !== staff.id);
    await sendStaffMany(c, tenant, mgmt, `🚧 Blocker from ${staff.name}: ${blockers}`, `office:blocker:${row.id}`);
  }
  const handover = /handover\s+(?:to\s+)?([\p{L}]+)\s*[:-]\s*([\s\S]+)/iu.exec(text);
  if (part === 'done' && handover) await handoverTo(c, tenant, staff, handover[1]!, handover[2]!.trim(), now);
  return { row, blockers };
}

export async function handoverTo(c: Container, tenant: Tenant, from: StaffMember, toName: string, note: string, now = new Date()) {
  const staff = await activeStaff(c.prisma, tenant.id);
  const to = staffMentioned(toName, staff).find((s) => s.id !== from.id);
  if (!to) return null;
  const { date } = localNow(tzOf(tenant), now);
  await tenantDb(c.prisma, tenant.id).standup.upsert({
    where: { staffId_date: { staffId: from.id, date } },
    create: { tenantId: tenant.id, staffId: from.id, date, handover: note, handoverToId: to.id },
    update: { handover: note, handoverToId: to.id },
  });
  await sendStaff(c, tenant, to, `🔁 Handover from ${from.name}:\n${note}`, `office:handover:${from.id}:${date}`);
  return to;
}

// ---------------- My work ----------------

export type WorkItem =
  | { type: 'step'; id: string; label: string; doctype: string; docName: string; escalated: boolean; due: Date }
  | { type: 'task'; name: string; label: string; due: string | null };

/** Open lifecycle steps owned by the person + open ERPNext Tasks assigned to them. */
export async function myWork(c: Container, tenant: Tenant, staff: StaffMember): Promise<WorkItem[]> {
  const db = tenantDb(c.prisma, tenant.id);
  const timers = await db.lifecycleTimer.findMany({
    where: { status: 'open', ownerStaffId: staff.id, rule: { enabled: true } },
    include: { rule: { include: { levels: true } } },
    orderBy: { anchorAt: 'asc' },
    take: 50,
  });
  const items: WorkItem[] = timers.map((t) => {
    const lv = t.rule.levels.filter((l) => l.enabled && l.audience !== 'customer').sort((a, b) => a.offsetMinutes - b.offsetMinutes);
    const next = lv.find((l) => !t.sentLevels.includes(l.level)) ?? lv.at(-1);
    return {
      type: 'step',
      id: t.id,
      label: `${t.rule.name} — ${t.customerName ?? t.docName}`,
      doctype: t.doctype,
      docName: t.docName,
      escalated: t.rule.levels.some((l) => l.audience === 'escalation' && t.sentLevels.includes(l.level)),
      due: new Date(t.anchorAt.getTime() + (next?.offsetMinutes ?? 0) * 60000),
    };
  });
  // Tasks already tracked as a step are not listed twice.
  const tracked = new Set(timers.filter((t) => t.doctype === 'Task').map((t) => t.docName));
  if (staff.erpUser && tenant.erpApiKeyEnc) {
    try {
      const tasks = await c.erp(tenant).list('Task', {
        filters: [['_assign', 'like', `%${staff.erpUser}%`], ['status', 'in', ['Open', 'Working', 'Pending Review', 'Overdue']]],
        fields: ['name', 'subject', 'exp_end_date', 'project'],
        limit: 30,
      });
      for (const t of tasks) {
        if (tracked.has(String(t.name))) continue;
        items.push({ type: 'task', name: String(t.name), label: `${t.subject ?? t.name}${t.project ? ` (${t.project})` : ''}`, due: (t.exp_end_date as string) ?? null });
      }
    } catch (err) {
      logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'erp task list failed');
    }
  }
  return items;
}

const listKey = (tenantId: string, staffId: string) => `office:list:${tenantId}:${staffId}`;

export async function rememberList(c: Container, tenantId: string, staffId: string, items: WorkItem[]) {
  await c.redis.set(listKey(tenantId, staffId), JSON.stringify(items.map((i) => (i.type === 'step' ? { type: 'step', id: i.id } : { type: 'task', name: i.name }))), 'EX', 24 * 3600);
}

/** "done 2 interested" — closes the numbered item from the person's last list. */
export async function completeItem(c: Container, tenant: Tenant, staff: StaffMember, n: number, note: string) {
  const raw = await c.redis.get(listKey(tenant.id, staff.id));
  const list = raw ? (JSON.parse(raw) as Array<{ type: 'step'; id: string } | { type: 'task'; name: string }>) : [];
  const item = list[n - 1];
  if (!item) return null;
  const db = tenantDb(c.prisma, tenant.id);
  const erp = tenant.erpApiKeyEnc ? c.erp(tenant) : null;
  const comment = (doctype: string, name: string) =>
    erp?.create('Comment', { comment_type: 'Comment', reference_doctype: doctype, reference_name: name, content: `Done by ${staff.name} on WhatsApp${note ? `: ${note}` : ''}` }).catch(() => undefined);
  if (item.type === 'task') {
    await erp?.update('Task', item.name, { status: 'Completed' });
    await comment('Task', item.name);
    return { label: `Task ${item.name}` };
  }
  const t = await db.lifecycleTimer.findFirst({ where: { id: item.id }, include: { rule: true } });
  if (!t || t.status !== 'open') return { label: 'That step', already: true };
  await db.lifecycleTimer.update({ where: { id: t.id }, data: { status: 'done', completedAt: new Date(), context: { ...(t.context as object), done_note: note, done_by: staff.name } } });
  if (t.doctype === 'Task') await erp?.update('Task', t.docName, { status: 'Completed' }).catch(() => undefined);
  if (!t.docName.includes('@')) await comment(t.doctype, t.docName);
  return { label: `${t.rule.name} — ${t.customerName ?? t.docName}` };
}

// ---------------- Customers ----------------

export async function customerStatus(c: Container, tenant: Tenant, q: string) {
  const db = tenantDb(c.prisma, tenant.id);
  const timers = await db.lifecycleTimer.findMany({
    where: { customerName: { contains: q, mode: 'insensitive' } },
    include: { rule: true, owner: true },
    orderBy: { updatedAt: 'desc' },
    take: 40,
  });
  if (timers.length === 0) return null;
  const name = timers[0]!.customerName!;
  const open = timers.filter((t) => t.status === 'open' && t.customerName === name);
  const health = timers.map((t) => (t.context as Record<string, string>).health_score).find(Boolean);
  let stage: string | undefined;
  if (tenant.erpApiKeyEnc) {
    const projects = await c.erp(tenant).list('Project', { filters: [['customer', 'like', `%${q}%`]], fields: ['name', CF.projectStage], limit: 1 }).catch(() => []);
    stage = projects[0] ? `${projects[0].name}: ${projects[0][CF.projectStage] ?? '—'}` : undefined;
  }
  const lines = [`📋 ${name}`];
  if (stage) lines.push(`Project ${stage}`);
  if (health) lines.push(`Health: ${health}/100`);
  lines.push(open.length ? `Open steps (${open.length}):` : 'No open steps.');
  for (const t of open.slice(0, 8)) lines.push(`• ${t.rule.name} — ${t.owner?.name ?? 'unassigned'}`);
  const last = timers.find((t) => t.status === 'done' && t.customerName === name);
  if (last) lines.push(`Last done: ${last.rule.name}`);
  return lines.join('\n');
}

export async function moveProject(c: Container, tenant: Tenant, customerQ: string, stageQ: string) {
  const stage = PROJECT_STAGES.find((s) => s.toLowerCase().startsWith(stageQ.trim().toLowerCase().slice(0, 4)));
  if (!stage) return { error: `Unknown stage. Use one of: ${PROJECT_STAGES.join(', ')}` };
  const erp = c.erp(tenant);
  const projects = await erp.list('Project', { filters: [['customer', 'like', `%${customerQ.trim()}%`]], fields: ['name', 'customer'], limit: 2 });
  if (projects.length === 0) return { error: `No project found for "${customerQ}".` };
  const name = String(projects[0]!.name);
  await erp.update('Project', name, { [CF.projectStage]: stage });
  await c.queue.enqueue(QUEUES.lifecycleEvent, { tenantId: tenant.id, doctype: 'Project', name, event: 'on_update' }, { jobId: `lc-move-${tenant.id}-${name}-${Date.now()}` });
  return { project: name, stage };
}

// ---------------- Approvals & leave ----------------

async function approvers(c: Container, tenant: Tenant, role: LifecycleRole, excludeId?: string | null) {
  let list = (await staffWithRole(c.prisma, tenant.id, role)).filter((s) => s.id !== excludeId);
  if (list.length === 0 && role !== 'management') list = (await staffWithRole(c.prisma, tenant.id, 'management')).filter((s) => s.id !== excludeId);
  return list;
}

export async function createApproval(
  c: Container,
  tenant: Tenant,
  a: { kind: string; title: string; details?: string; amount?: string; ref?: string; requestedBy?: StaffMember | null; approverRole?: LifecycleRole },
) {
  const db = tenantDb(c.prisma, tenant.id);
  let row: Approval | null = null;
  for (let attempt = 0; attempt < 3 && !row; attempt++) {
    try {
      row = await db.approval.create({
        data: {
          tenantId: tenant.id,
          code: await nextCode(c.prisma, tenant.id, 'approval'),
          kind: a.kind,
          title: a.title,
          details: a.details,
          amount: a.amount,
          ref: a.ref,
          requestedById: a.requestedBy?.id,
          approverRole: a.approverRole ?? 'management',
        },
      });
    } catch (err) {
      if (attempt === 2) throw err; // code collision under concurrency → retry
    }
  }
  const to = await approvers(c, tenant, row!.approverRole, a.requestedBy?.id);
  const who = a.requestedBy ? ` from ${a.requestedBy.name}` : '';
  await sendStaffMany(
    c,
    tenant,
    to,
    `🙋 Approval #${row!.code}${who}: ${a.title}${a.amount && !a.title.includes(a.amount) ? ` (${a.amount})` : ''}${a.details ? `\n${a.details}` : ''}\n\nReply "approve ${row!.code}" or "reject ${row!.code} <reason>".`,
    `office:approval:${row!.id}`,
  );
  return row!;
}

export async function decideApproval(
  c: Container,
  tenant: Tenant,
  code: number,
  decision: 'approved' | 'rejected',
  by: { staff?: StaffMember; adminId?: string },
  note?: string,
) {
  const db = tenantDb(c.prisma, tenant.id);
  const a = await db.approval.findFirst({ where: { code } });
  if (!a) return { error: `Approval #${code} not found.` };
  if (a.status !== 'pending') return { error: `Approval #${code} is already ${a.status}.` };
  if (by.staff) {
    const allowed = by.staff.roles.includes(a.approverRole) || by.staff.roles.includes('management');
    if (!allowed || by.staff.id === a.requestedById) return { error: `You can't decide approval #${code}.` };
  }
  const updated = await db.approval.update({
    where: { id: a.id },
    data: { status: decision, decidedBy: by.staff?.id ?? `admin:${by.adminId}`, decisionNote: note || null, decidedAt: new Date() },
  });
  if (a.kind === 'leave' && a.ref) await db.leaveRequest.updateMany({ where: { id: a.ref }, data: { status: decision } });
  const requester = a.requestedById ? await db.staffMember.findFirst({ where: { id: a.requestedById } }) : null;
  const decider = by.staff?.name ?? 'Admin';
  if (requester) {
    await sendStaff(c, tenant, requester, `${decision === 'approved' ? '✅ Approved' : '❌ Rejected'}: #${a.code} ${a.title} (by ${decider})${note ? `\n${note}` : ''}`, `office:decision:${a.id}`);
  }
  return { approval: updated, requester };
}

export async function requestLeave(c: Container, tenant: Tenant, staff: StaffMember, fromDate: string, toDate: string, reason?: string) {
  const db = tenantDb(c.prisma, tenant.id);
  const leave = await db.leaveRequest.create({ data: { tenantId: tenant.id, staffId: staff.id, fromDate, toDate, reason } });
  const span = fromDate === toDate ? fmtDay(fromDate) : `${fmtDay(fromDate)} – ${fmtDay(toDate)}`;
  const backup = staff.backupStaffId ? await db.staffMember.findFirst({ where: { id: staff.backupStaffId } }) : null;
  const approval = await createApproval(c, tenant, {
    kind: 'leave',
    title: `Leave ${span}`,
    details: [reason, backup ? `Cover: ${backup.name}` : 'No backup set — reminders go to the rest of the team.'].filter(Boolean).join('\n'),
    ref: leave.id,
    requestedBy: staff,
  });
  return { leave, approval, span };
}

// ---------------- Announcements ----------------

export async function announce(c: Container, tenant: Tenant, from: StaffMember | null, roles: LifecycleRole[], text: string) {
  const staff = (await activeStaff(c.prisma, tenant.id)).filter((s) => s.id !== from?.id && (roles.length === 0 || s.roles.some((r) => roles.includes(r))));
  const row = await tenantDb(c.prisma, tenant.id).announcement.create({
    data: { tenantId: tenant.id, fromStaffId: from?.id, roles, text, recipientIds: staff.map((s) => s.id) },
  });
  await sendStaffMany(c, tenant, staff, `📢 ${from ? from.name : 'Management'}${roles.length ? ` → ${roles.join(', ')}` : ''}:\n${text}\n\nReply OK to acknowledge.`, `office:ann:${row.id}`);
  return { announcement: row, recipients: staff.length };
}

export async function ackLatest(c: Container, tenant: Tenant, staff: StaffMember) {
  const db = tenantDb(c.prisma, tenant.id);
  const a = await db.announcement.findFirst({
    where: { recipientIds: { has: staff.id }, NOT: { ackIds: { has: staff.id } }, createdAt: { gte: new Date(Date.now() - 3 * 86400_000) } },
    orderBy: { createdAt: 'desc' },
  });
  if (!a) return null;
  return db.announcement.update({ where: { id: a.id }, data: { ackIds: { push: staff.id } } });
}

// ---------------- Meetings ----------------

/** "meet esha akshay tomorrow 3pm for 45m onboarding sync" */
export async function scheduleMeeting(
  c: Container,
  tenant: Tenant,
  organizer: StaffMember | null,
  m: { title: string; date: string; minutes: number; durationMin: number; attendees: StaffMember[] },
) {
  const tz = tzOf(tenant);
  const startsAt = localToUtc(m.date, m.minutes, tz);
  const db = tenantDb(c.prisma, tenant.id);
  const attendees = m.attendees.filter((a) => a.id !== organizer?.id);
  const meeting = await db.meeting.create({
    data: {
      tenantId: tenant.id,
      code: await nextCode(c.prisma, tenant.id, 'meeting'),
      title: m.title,
      startsAt,
      durationMin: m.durationMin,
      organizerId: organizer?.id,
      attendeeIds: [...(organizer ? [organizer.id] : []), ...attendees.map((a) => a.id)],
    },
  });
  if (tenant.erpApiKeyEnc) {
    const hh = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`;
    await c
      .erp(tenant)
      .create('Event', { subject: `${m.title} (#${meeting.code})`, starts_on: `${m.date} ${hh(m.minutes)}`, ends_on: `${m.date} ${hh(m.minutes + m.durationMin)}`, event_type: 'Private', event_category: 'Meeting' })
      .catch((err) => logger.warn({ err: (err as Error).message }, 'erp meeting event failed'));
  }
  const when = `${fmtDay(m.date)} ${fmtTime(startsAt, tz)}`;
  const names = [organizer?.name, ...attendees.map((a) => a.name)].filter(Boolean).join(', ');
  await sendStaffMany(c, tenant, attendees, `📅 Meeting #${meeting.code}: ${m.title}\n${when} (${m.durationMin} min) with ${names}${organizer ? ` — set by ${organizer.name}` : ''}`, `office:meet:${meeting.id}`);
  return { meeting, when, names };
}

/**
 * "notes 5: agreed new menu flow
 *  - Esha: update menu by friday
 *  - Akshay: test checkout"
 * Lines starting with - or • become ERPNext Tasks, assigned to the staff member named at the start of the line.
 */
export async function saveMeetingNotes(c: Container, tenant: Tenant, code: number, text: string, now = new Date()) {
  const db = tenantDb(c.prisma, tenant.id);
  const meeting = await db.meeting.findFirst({ where: { code } });
  if (!meeting) return { error: `Meeting #${code} not found.` };
  const staff = await activeStaff(c.prisma, tenant.id);
  const today = localNow(tzOf(tenant), now).date;
  const actions = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-•*]\s*/.test(l))
    .map((l) => l.replace(/^[-•*]\s*/, ''));
  const created: Array<{ name: string; owner?: StaffMember }> = [];
  for (const a of actions) {
    const head = a.split(/[:\-–]/)[0] ?? '';
    const owner = staffMentioned(head, staff)[0];
    const due = parseDate(a, today)?.date ?? addDays(today, 3);
    if (!tenant.erpApiKeyEnc) {
      created.push({ name: a, owner });
      continue;
    }
    const erp = c.erp(tenant);
    const task = await erp.create('Task', { subject: a.slice(0, 140), description: `From meeting #${meeting.code} ${meeting.title}`, exp_end_date: due, status: 'Open' });
    const name = String(task.name);
    if (owner?.erpUser) await erp.assign('Task', name, [owner.erpUser], `Meeting #${meeting.code}`).catch(() => undefined);
    await c.queue.enqueue(QUEUES.lifecycleEvent, { tenantId: tenant.id, doctype: 'Task', name, event: 'after_insert' }, { jobId: `lc-meet-${tenant.id}-${name}` });
    created.push({ name, owner });
  }
  await db.meeting.update({ where: { id: meeting.id }, data: { notes: text, status: 'done', taskNames: created.map((t) => t.name) } });
  const attendees = staff.filter((s) => meeting.attendeeIds.includes(s.id));
  const summary = `📝 Notes — #${meeting.code} ${meeting.title}\n${text}`;
  await sendStaffMany(c, tenant, attendees, summary, `office:notes:${meeting.id}`);
  return { meeting, tasks: created };
}

export const meetingWhen = (tenant: Tenant, startsAt: Date) => {
  const tz = tzOf(tenant);
  return `${fmtDay(localNow(tz, startsAt).date)} ${fmtTime(startsAt, tz)}`;
};
