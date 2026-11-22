import type { ChatwootWebhook } from '@nextai/chatwoot-client';
import { LIFECYCLE_ROLES, normalizePhone, type LifecycleRoleName } from '@nextai/shared';
import type { StaffMember, Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';
import { incrementUsage } from '../usage/usage.js';
import {
  ackLatest,
  announce,
  checkIn,
  checkOut,
  completeItem,
  customerStatus,
  decideApproval,
  createApproval,
  handoverTo,
  meetingWhen,
  moveProject,
  myWork,
  rememberList,
  requestLeave,
  saveMeetingNotes,
  saveStandup,
  scheduleMeeting,
  setPresence,
  type WorkItem,
} from './service.js';
import { activeStaff, fmtDay, fmtTime, localNow, officeSettings, parseDate, parseTime, staffMentioned, tzOf } from './util.js';

/**
 * Virtual-office assistant on the team's separate WhatsApp number.
 * Deterministic commands first (no AI cost); anything else is answered by the AI from the person's own work.
 */

export const HELP = `🏢 NextAi office — commands
• in / out — check in or out (add a note: "in at client site")
• busy on call / back — your status
• tasks — your open steps and tasks · overdue
• done 2 <note> — finish item 2 from your list
• status <customer> · move <customer> to <stage>
• leave tomorrow / leave 25/12 to 27/12 <reason>
• request discount 15% for Noor — ask for approval
• approvals · approve 12 · reject 12 <reason>
• meet Esha Akshay tomorrow 3pm <title>
• notes 5: … (lines starting with - become tasks)
• handover Esha: <note> · who is in
• announce [sales]: <text> (management) · OK to acknowledge
Anything else — just ask.`;

type Await = { kind: 'plan' } | { kind: 'done' } | { kind: 'notes'; code: number };
const awaitKey = (tenantId: string, staffId: string) => `office:await:${tenantId}:${staffId}`;
async function setAwait(c: Container, tenantId: string, staffId: string, a: Await | null, ttlSec = 6 * 3600) {
  if (a) await c.redis.set(awaitKey(tenantId, staffId), JSON.stringify(a), 'EX', ttlSec);
  else await c.redis.del(awaitKey(tenantId, staffId));
}
async function getAwait(c: Container, tenantId: string, staffId: string): Promise<Await | null> {
  const raw = await c.redis.get(awaitKey(tenantId, staffId));
  return raw ? (JSON.parse(raw) as Await) : null;
}

function renderWork(items: WorkItem[], tz: string) {
  if (items.length === 0) return 'Nothing open on your list. 🎉';
  return items
    .slice(0, 20)
    .map((i, n) => {
      if (i.type === 'task') return `${n + 1}. 📌 ${i.label}${i.due ? ` — due ${fmtDay(i.due)}` : ''}`;
      const flag = i.escalated ? '🔴' : i.due < new Date() ? '🟠' : '🟡';
      return `${n + 1}. ${flag} ${i.label} — ${fmtTime(i.due, tz)} ${fmtDay(localNow(tz, i.due).date)}`;
    })
    .join('\n');
}

export type StaffOutcome = 'unknown_staff' | 'office_reply';

export async function handleStaffMessage(c: Container, tenant: Tenant, evt: ChatwootWebhook): Promise<StaffOutcome> {
  const cw = c.chatwoot(tenant, 'staff');
  const conversationId = evt.conversation!.id;
  const rawPhone = evt.sender?.phone_number ?? evt.conversation?.contact_inbox?.source_id;
  let phone: string | undefined;
  try {
    phone = rawPhone ? normalizePhone(rawPhone, tenant.country) : undefined;
  } catch {
    phone = undefined;
  }
  const staff = phone ? await tenantDb(c.prisma, tenant.id).staffMember.findFirst({ where: { phone, active: true } }) : null;
  if (!staff) {
    await cw.sendText(conversationId, 'This number is for the NextAi team. Ask your admin to add you as staff.');
    return 'unknown_staff';
  }
  const text = (evt.content ?? '').trim();
  const say = (t: string) => cw.sendText(conversationId, t);
  if (!text) {
    await say('Send me a message — type "help" for the commands.');
    return 'office_reply';
  }
  await incrementUsage(c.prisma, tenant.id, { messages: 1 });
  await route(c, tenant, staff, text, say);
  return 'office_reply';
}

async function route(c: Container, tenant: Tenant, staff: StaffMember, text: string, say: (t: string) => Promise<unknown>) {
  const tz = tzOf(tenant);
  const cfg = officeSettings(tenant);
  const t = text.toLowerCase().trim();
  const isMgmt = staff.roles.includes('management');
  let m: RegExpExecArray | null;

  if (/^(hi|hello|help|menu|\?|commands)$/.test(t)) return say(HELP);

  // ---- attendance & presence
  if ((m = /^(?:in|check\s?in|checkin|good morning|gm)\b[\s,:-]*(.*)$/is.exec(text))) {
    const r = await checkIn(c, tenant, staff, m[1]?.trim() || undefined);
    const items = await myWork(c, tenant, staff);
    await rememberList(c, tenant.id, staff.id, items);
    const esc = items.filter((i) => i.type === 'step' && i.escalated).length;
    const head = r.already
      ? `You're already checked in since ${fmtTime(r.attendance.checkInAt!, tz)}.`
      : `✅ Checked in ${fmtTime(r.attendance.checkInAt ?? new Date(), tz)}${r.late ? ' (late)' : ''}. Good morning ${staff.name.split(' ')[0]}!`;
    const work = `\n\nYour list (${items.length}${esc ? `, ${esc} escalated` : ''}):\n${renderWork(items, tz)}`;
    if (cfg.standupEnabled && !r.already) {
      await setAwait(c, tenant.id, staff.id, { kind: 'plan' });
      return say(`${head}${work}\n\n🗓️ What's your plan today? Add "blocker: …" if anything is stuck.`);
    }
    return say(head + work);
  }
  if (/^(?:out|check\s?out|checkout|bye|logout|leaving)\b/.test(t)) {
    const r = await checkOut(c, tenant, staff);
    if (!r.attendance) return say('You were not checked in today. Status set to out.');
    const h = Math.floor(r.minutes / 60);
    const head = `👋 Checked out ${fmtTime(r.attendance.checkOutAt!, tz)} (${h}h ${r.minutes % 60}m).`;
    if (cfg.standupEnabled) {
      await setAwait(c, tenant.id, staff.id, { kind: 'done' });
      return say(`${head}\n\nWhat did you finish today? To hand something over: "handover Esha: call Noor tomorrow".`);
    }
    return say(head);
  }
  if ((m = /^(busy|on (?:a )?call|in (?:a )?meeting|break|lunch)\b[\s,:-]*(.*)$/i.exec(text))) {
    await setPresence(c, tenant, staff, 'busy', [m[1], m[2]].filter(Boolean).join(' ').trim());
    return say(`🔕 Status: busy (${[m[1], m[2]].filter(Boolean).join(' ').trim()}). Send "back" when you're free.`);
  }
  if (/^(back|available|free)$/.test(t)) {
    await setPresence(c, tenant, staff, 'in');
    return say('🟢 Status: available.');
  }
  if (/^(who('?s| is)? in|team|office)$/.test(t)) {
    const all = await activeStaff(c.prisma, tenant.id);
    const icon: Record<string, string> = { in: '🟢', busy: '🔕', leave: '🌴', out: '⚪' };
    return say(all.map((s) => `${icon[s.presence] ?? '⚪'} ${s.name}${s.presenceNote ? ` — ${s.presenceNote}` : ''}`).join('\n'));
  }

  // ---- work
  if (/^(tasks?|my tasks|today|list|work|my work)$/.test(t) || /^overdue$/.test(t)) {
    let items = await myWork(c, tenant, staff);
    if (t === 'overdue') items = items.filter((i) => i.type === 'step' && (i.escalated || i.due < new Date()));
    await rememberList(c, tenant.id, staff.id, items);
    return say(`${t === 'overdue' ? '⏰ Overdue' : '📋 Your work'} (${items.length}):\n${renderWork(items, tz)}\n\nReply "done 1 <note>" to finish one.`);
  }
  if ((m = /^done\s+#?(\d+)\s*[:-]?\s*(.*)$/is.exec(text))) {
    const r = await completeItem(c, tenant, staff, Number(m[1]), m[2]!.trim());
    if (!r) return say('I could not find that number — send "tasks" first to get your list.');
    return say(r.already ? `${r.label} was already closed.` : `✅ Done: ${r.label}`);
  }
  if ((m = /^status\s+(.+)$/i.exec(text))) {
    return say((await customerStatus(c, tenant, m[1]!.trim())) ?? `No customer matching "${m[1]}".`);
  }
  if ((m = /^move\s+(.+?)\s+to\s+(.+)$/i.exec(text))) {
    if (!tenant.erpApiKeyEnc) return say('ERPNext is not connected.');
    const r = await moveProject(c, tenant, m[1]!, m[2]!);
    return say('error' in r ? r.error! : `➡️ ${r.project} moved to ${r.stage}.`);
  }

  // ---- leave & approvals
  if ((m = /^leave\s+(.+)$/is.exec(text))) {
    const today = localNow(tz).date;
    const rest = m[1]!;
    const from = parseDate(rest, today);
    if (!from) return say('When? e.g. "leave tomorrow" or "leave 25/12 to 27/12 family function".');
    const after = rest.slice(rest.toLowerCase().indexOf(from.match) + from.match.length);
    const toM = /^\s*(?:to|till|until|-)\s*/i.exec(after);
    const to = toM ? parseDate(after.slice(toM[0].length), today) : null;
    const endDate = to && to.date >= from.date ? to.date : from.date;
    const reason = (to ? after.slice(toM![0].length).replace(new RegExp(to.match, 'i'), '') : after).replace(/^[\s,:-]+/, '').trim() || undefined;
    const r = await requestLeave(c, tenant, staff, from.date, endDate, reason);
    return say(`🌴 Leave request #${r.approval.code} sent for ${r.span}. I'll tell you when it's decided.`);
  }
  if ((m = /^(approve|approved|ok|reject|decline)\s+#?(\d+)\s*[:-]?\s*(.*)$/is.exec(text))) {
    const decision = /^(approve|approved|ok)$/i.test(m[1]!) ? 'approved' : 'rejected';
    const r = await decideApproval(c, tenant, Number(m[2]), decision, { staff }, m[3]!.trim() || undefined);
    return say('error' in r ? r.error! : `${decision === 'approved' ? '✅ Approved' : '❌ Rejected'} #${r.approval.code}: ${r.approval.title}${r.requester ? ` — ${r.requester.name} has been told.` : ''}`);
  }
  if (/^approvals?$/.test(t)) {
    const pending = await tenantDb(c.prisma, tenant.id).approval.findMany({ where: { status: 'pending', approverRole: { in: staff.roles } }, orderBy: { code: 'asc' }, take: 20 });
    const mine = await tenantDb(c.prisma, tenant.id).approval.findMany({ where: { status: 'pending', requestedById: staff.id }, orderBy: { code: 'asc' }, take: 10 });
    const lines = [
      pending.length ? `Waiting for you (${pending.length}):\n${pending.map((a) => `#${a.code} ${a.title}${a.amount ? ` (${a.amount})` : ''}`).join('\n')}` : 'Nothing waiting for your approval.',
      mine.length ? `\nYour requests pending:\n${mine.map((a) => `#${a.code} ${a.title}`).join('\n')}` : '',
    ];
    return say(lines.join('\n').trim());
  }
  if ((m = /^(?:request|approval|ask)\s+(?:for\s+)?(.+)$/is.exec(text))) {
    const body = m[1]!.trim();
    const kind = /discount/i.test(body) ? 'discount' : /refund/i.test(body) ? 'refund' : /expense|bill|purchase|buy/i.test(body) ? 'expense' : 'other';
    const amount = /(\d+(?:\.\d+)?\s*%|(?:₹|rs\.?|inr|aed|usd|\$)\s*[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?\s*(?:₹|rs|inr|aed|usd))/i.exec(body)?.[0];
    const a = await createApproval(c, tenant, { kind, title: body.slice(0, 140), amount, requestedBy: staff });
    return say(`📨 Approval #${a.code} sent to ${a.approverRole}. I'll tell you when it's decided.`);
  }

  // ---- announcements
  if ((m = /^announce(?:ment)?\s*([a-z_,\s]*?)\s*:\s*([\s\S]+)$/i.exec(text)) || (m = /^announce(?:ment)?\s+()([\s\S]+)$/i.exec(text))) {
    if (!isMgmt) return say('Only management can send announcements.');
    const roles = m[1]!
      .split(/[,\s]+/)
      .map((r) => r.trim().toLowerCase())
      .filter((r) => r && r !== 'all')
      .filter((r): r is LifecycleRoleName => (LIFECYCLE_ROLES as readonly string[]).includes(r));
    const r = await announce(c, tenant, staff, roles, m[2]!.trim());
    return say(`📢 Sent to ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'}. You'll see who acknowledged in the office dashboard.`);
  }
  if (/^(ok|okay|noted|seen|ack|👍|done reading|got it)[.!]?$/u.test(t)) {
    const a = await ackLatest(c, tenant, staff);
    if (a) return say('👍 Acknowledged.');
  }

  // ---- meetings
  if ((m = /^(?:meet|meeting)\s+(.+)$/is.exec(text))) {
    const rest = m[1]!;
    const today = localNow(tz).date;
    const day = parseDate(rest, today);
    const time = parseTime(rest);
    if (!time) return say('What time? e.g. "meet Esha Akshay tomorrow 3pm onboarding sync".');
    const durM = /\bfor\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)\b/i.exec(rest);
    const durationMin = durM ? Number(durM[1]) * (/^h/i.test(durM[2]!) ? 60 : 1) : 30;
    const staffAll = await activeStaff(c.prisma, tenant.id);
    const attendees = staffMentioned(rest, staffAll).filter((s) => s.id !== staff.id);
    if (attendees.length === 0) return say('Who should join? Mention them by name, e.g. "meet Esha 3pm".');
    let title = rest;
    for (const x of [day?.match, time.match, durM?.[0], ...attendees.flatMap((a) => [a.name, a.name.split(/\s+/)[0]!])]) {
      if (x) title = title.replace(new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), ' ');
    }
    title = title.replace(/\b(and|with|at|on)\b/gi, ' ').replace(/[,]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Meeting';
    const r = await scheduleMeeting(c, tenant, staff, { title: title[0]!.toUpperCase() + title.slice(1), date: day?.date ?? today, minutes: time.minutes, durationMin, attendees });
    return say(`📅 Meeting #${r.meeting.code} "${r.meeting.title}" — ${r.when} with ${r.names}. Everyone is notified and reminded before it starts.`);
  }
  if ((m = /^notes\s+#?(\d+)\s*[:-]?\s*([\s\S]+)$/i.exec(text))) {
    const r = await saveMeetingNotes(c, tenant, Number(m[1]), m[2]!.trim());
    if ('error' in r) return say(r.error!);
    await setAwait(c, tenant.id, staff.id, null);
    return say(`📝 Notes saved for #${r.meeting.code}.${r.tasks.length ? `\nTasks created:\n${r.tasks.map((x) => `• ${x.name}${x.owner ? ` → ${x.owner.name}` : ''}`).join('\n')}` : ''}`);
  }
  if ((m = /^handover\s+(?:to\s+)?([\p{L}]+)\s*[:-]\s*([\s\S]+)$/iu.exec(text))) {
    const to = await handoverTo(c, tenant, staff, m[1]!, m[2]!.trim());
    return say(to ? `🔁 Handed over to ${to.name}.` : `I couldn't find "${m[1]}" in the team.`);
  }

  // ---- awaited answers (stand-up, meeting notes)
  const awaiting = await getAwait(c, tenant.id, staff.id);
  if (awaiting?.kind === 'plan' || awaiting?.kind === 'done') {
    await setAwait(c, tenant.id, staff.id, null);
    const r = await saveStandup(c, tenant, staff, awaiting.kind, text);
    if (awaiting.kind === 'plan') return say(r.blockers ? '👍 Plan saved. I\'ve flagged your blocker to management.' : '👍 Plan saved. Have a good day!');
    return say('👍 Thanks — saved. See you tomorrow!');
  }
  if (awaiting?.kind === 'notes') {
    const r = await saveMeetingNotes(c, tenant, awaiting.code, text);
    await setAwait(c, tenant.id, staff.id, null);
    if ('error' in r) return say(r.error!);
    return say(`📝 Notes saved for #${r.meeting.code}.${r.tasks.length ? ` ${r.tasks.length} task(s) created.` : ''}`);
  }

  // ---- free text → AI, answering from the person's own work
  const items = await myWork(c, tenant, staff);
  const db = tenantDb(c.prisma, tenant.id);
  const meetings = await db.meeting.findMany({ where: { status: 'scheduled', attendeeIds: { has: staff.id }, startsAt: { gte: new Date() } }, orderBy: { startsAt: 'asc' }, take: 5 });
  const context = [
    `Staff: ${staff.name} (${staff.roles.join(', ')}), status ${staff.presence}.`,
    `Open work:\n${renderWork(items, tz)}`,
    `Upcoming meetings:\n${meetings.map((x) => `#${x.code} ${x.title} ${meetingWhen(tenant, x.startsAt)}`).join('\n') || 'none'}`,
    `Commands they can use:\n${HELP}`,
  ].join('\n\n');
  const { text: answer, usage } = await c.ai.llm.summarize(
    `Answer this team member's WhatsApp message briefly: "${text.slice(0, 500)}". If the data does not answer it, say so and suggest the right command.`,
    context,
  );
  if (usage.tokens) await incrementUsage(c.prisma, tenant.id, { aiTokens: usage.tokens, aiCostMicros: usage.costMicros });
  return say(answer || HELP);
}

export { setAwait };
