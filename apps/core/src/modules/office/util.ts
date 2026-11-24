import type { LifecycleRole, PrismaClient, StaffMember, Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { erpContext } from '../erpnext/mappers.js';
import { erpTime } from '../lifecycle/events.js';
import { sendWhatsApp } from '../outbound/whatsapp.js';

// ---------------- Time ----------------

export interface LocalNow {
  date: string; // YYYY-MM-DD
  minutes: number; // minutes since local midnight
  weekday: number; // 0 = Sunday
}

export function localNow(tz: string, at = new Date()): LocalNow {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday };
}

export const hhmmToMinutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
export const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** Local date + minutes → UTC instant. */
export function localToUtc(date: string, minutes: number, tz: string): Date {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return erpTime(`${date} ${hh}:${mm}:00`, tz)!;
}

export const fmtTime = (d: Date, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
export const fmtDay = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${iso}T00:00:00Z`));

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Find a date in free text: today | tomorrow | monday… (next occurrence) | 25/12[/2026] | 25-12 | 2026-12-25 | 25 dec.
 * Returns the date and the matched text so callers can strip it.
 */
export function parseDate(text: string, today: string): { date: string; match: string } | null {
  const t = text.toLowerCase();
  let m = /\b(today|tod)\b/.exec(t);
  if (m) return { date: today, match: m[0] };
  m = /\b(tomorrow|tmrw|tmr|nale)\b/.exec(t);
  if (m) return { date: addDays(today, 1), match: m[0] };
  m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, match: m[0] };
  m = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/.exec(t);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : today.slice(0, 4);
    let d = `${y}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
    if (!m[3] && d < today) d = `${Number(y) + 1}${d.slice(4)}`;
    return { date: d, match: m[0] };
  }
  m = new RegExp(`\\b(\\d{1,2})\\s*(${MONTHS.join('|')})[a-z]*\\b`).exec(t);
  if (m) {
    let d = `${today.slice(0, 4)}-${String(MONTHS.indexOf(m[2]!) + 1).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
    if (d < today) d = `${Number(today.slice(0, 4)) + 1}${d.slice(4)}`;
    return { date: d, match: m[0] };
  }
  m = new RegExp(`\\b(?:next\\s+)?(${DAYS.map((d) => d.slice(0, 3)).join('|')})[a-z]*\\b`).exec(t);
  if (m) {
    const target = DAYS.findIndex((d) => d.startsWith(m![1]!));
    const diff = (target - weekdayOf(today) + 7) % 7 || 7;
    return { date: addDays(today, diff), match: m[0] };
  }
  return null;
}

/** Find a clock time: 3pm | 3:30 pm | 15:00 | 9.30am | at 11. Returns minutes since midnight. */
export function parseTime(text: string): { minutes: number; match: string } | null {
  const t = text.toLowerCase();
  let m = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/.exec(t);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3] === 'pm') h += 12;
    return { minutes: h * 60 + Number(m[2] ?? 0), match: m[0] };
  }
  m = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(t);
  if (m) return { minutes: Number(m[1]) * 60 + Number(m[2]), match: m[0] };
  m = /\bat\s+(\d{1,2})\b/.exec(t);
  if (m) {
    const h = Number(m[1]);
    return { minutes: (h < 8 ? h + 12 : h) * 60, match: m[0] }; // "at 3" during office hours means 3 pm
  }
  return null;
}

// ---------------- Staff ----------------

export const officeSettings = (tenant: Tenant) => erpContext(tenant).settings.office;
export const tzOf = (tenant: Tenant) => erpContext(tenant).settings.timezone;

export const firstName = (s: Pick<StaffMember, 'name'>) => s.name.split(/\s+/)[0]!.toLowerCase();

/** Staff whose first or full name appears as a word in the text. */
export function staffMentioned(text: string, staff: StaffMember[]): StaffMember[] {
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return staff.filter((s) => t.includes(` ${s.name.toLowerCase()} `) || t.includes(` ${firstName(s)} `));
}

export const activeStaff = (prisma: PrismaClient, tenantId: string) => tenantDb(prisma, tenantId).staffMember.findMany({ where: { active: true }, orderBy: { name: 'asc' } });

export async function staffWithRole(prisma: PrismaClient, tenantId: string, role: LifecycleRole) {
  return tenantDb(prisma, tenantId).staffMember.findMany({ where: { active: true, roles: { has: role } } });
}

/** Approved leave covering `date`. */
export async function onLeave(prisma: PrismaClient, tenantId: string, staffId: string, date: string) {
  const l = await tenantDb(prisma, tenantId).leaveRequest.findFirst({ where: { staffId, status: 'approved', fromDate: { lte: date }, toDate: { gte: date } } });
  return !!l;
}

/** WhatsApp from the team's staff number (business-initiated, so led by the generic staff template). */
export async function sendStaff(c: Container, tenant: Tenant, to: Pick<StaffMember, 'name' | 'phone'>, text: string, ref?: string) {
  try {
    await sendWhatsApp(c, tenant, { kind: 'notice', channel: 'staff', phone: to.phone, name: to.name, templateKey: 'office_notice', params: [text], fallbackText: text, ref });
    return true;
  } catch (err) {
    logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'office message failed');
    return false;
  }
}

export async function sendStaffMany(c: Container, tenant: Tenant, to: Array<Pick<StaffMember, 'id' | 'name' | 'phone'>>, text: string, ref?: string) {
  const seen = new Set<string>();
  let n = 0;
  for (const s of to) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    if (await sendStaff(c, tenant, s, text, ref ? `${ref}:${s.id}` : undefined)) n++;
  }
  return n;
}

/** Next short code (approvals, meetings) for a tenant. */
export async function nextCode(prisma: PrismaClient, tenantId: string, model: 'approval' | 'meeting'): Promise<number> {
  const db = tenantDb(prisma, tenantId);
  const last = model === 'approval' ? await db.approval.findFirst({ orderBy: { code: 'desc' } }) : await db.meeting.findFirst({ orderBy: { code: 'desc' } });
  return (last?.code ?? 0) + 1;
}

/** Run `fn` once per key (Redis NX marker). */
export async function once(c: Container, key: string, ttlSec: number, fn: () => Promise<unknown>) {
  const ok = await c.redis.set(key, '1', 'EX', ttlSec, 'NX');
  if (ok !== 'OK') return false;
  await fn();
  return true;
}
