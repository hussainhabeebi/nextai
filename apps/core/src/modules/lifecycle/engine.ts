import type { LifecycleRole, LifecycleTimer, PrismaClient, ReminderLevel, StaffMember, Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { localDate } from '../outbound/jobs.js';
import { sendWhatsApp } from '../outbound/whatsapp.js';
import { erpContext } from '../erpnext/mappers.js';
import { DEFAULT_PLAYBOOK } from './defaults.js';
import { HEALTH_FIELD, computeHealth } from './health.js';

/** A level that is more than this late when first seen (worker down, level added later) is skipped, not sent. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// ---------------- Playbook install ----------------

/** Add missing default rules and levels for a tenant. Never overwrites rules or levels edited in the admin console. */
export async function installDefaultPlaybook(prisma: PrismaClient, tenantId: string) {
  const db = tenantDb(prisma, tenantId);
  let rules = 0;
  let levels = 0;
  for (const r of DEFAULT_PLAYBOOK) {
    let rule = await db.lifecycleRule.findUnique({ where: { tenantId_key: { tenantId, key: r.key } } });
    if (!rule) {
      rule = await db.lifecycleRule.create({
        data: { tenantId, key: r.key, stage: r.stage, name: r.name, description: r.description, ownerRole: r.ownerRole, escalationRole: r.escalationRole ?? 'accountant' },
      });
      rules++;
    }
    const existing = new Set((await db.reminderLevel.findMany({ where: { ruleId: rule.id } })).map((l) => l.level));
    for (const l of r.levels) {
      if (existing.has(l.level)) continue;
      await db.reminderLevel.create({
        data: { tenantId, ruleId: rule.id, level: l.level, offsetMinutes: l.offsetMinutes, audience: l.audience, templateKey: l.templateKey ?? 'lifecycle_notice', message: l.message },
      });
      levels++;
    }
  }
  return { rulesAdded: rules, levelsAdded: levels };
}

// ---------------- Owners ----------------

/** Pick the owner: the staff member matching an ERPNext user if given, else round-robin among the role. */
export async function pickOwner(c: Container, tenantId: string, role: LifecycleRole, erpUser?: string | null): Promise<StaffMember | null> {
  const db = tenantDb(c.prisma, tenantId);
  if (erpUser) {
    const match = await db.staffMember.findFirst({ where: { erpUser, active: true } });
    if (match) return match;
  }
  const pool = await db.staffMember.findMany({ where: { active: true, roles: { has: role } }, orderBy: { createdAt: 'asc' } });
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0]!;
  const n = await c.redis.incr(`lc:rr:${tenantId}:${role}`);
  return pool[(n - 1) % pool.length]!;
}

// ---------------- Timers ----------------

export interface StartTimer {
  ruleKey: string;
  doctype: string;
  docName: string;
  anchorAt: Date;
  owner?: StaffMember | null;
  ownerErpUser?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  context?: Record<string, string | number | null | undefined>;
  /** Keep the anchor of an already-open timer (e.g. an Issue re-opened from WhatsApp keeps its new start). */
  keepAnchor?: boolean;
}

/**
 * Start (or re-anchor) the timer for a rule on one ERPNext document. Idempotent per (rule, doctype, docName):
 * a repeat with the same anchor changes nothing; a new anchor (e.g. demo rescheduled) keeps only the levels that
 * would already have fired, so the remaining ones fire at the new times. Closed timers are never reopened.
 */
export async function startTimer(c: Container, tenantId: string, s: StartTimer, now = new Date()): Promise<LifecycleTimer | null> {
  const db = tenantDb(c.prisma, tenantId);
  const rule = await db.lifecycleRule.findUnique({ where: { tenantId_key: { tenantId, key: s.ruleKey } }, include: { levels: true } });
  if (!rule) return null; // playbook not installed for this tenant (or rule deleted) → nothing to do
  const context = Object.fromEntries(Object.entries(s.context ?? {}).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
  const existing = await db.lifecycleTimer.findUnique({ where: { ruleId_doctype_docName: { ruleId: rule.id, doctype: s.doctype, docName: s.docName } } });
  if (existing) {
    if (existing.status !== 'open') return existing;
    const anchorAt = s.keepAnchor ? existing.anchorAt : s.anchorAt;
    const anchorChanged = existing.anchorAt.getTime() !== anchorAt.getTime();
    const sentLevels = anchorChanged
      ? existing.sentLevels.filter((n) => {
          const l = rule.levels.find((x) => x.level === n);
          return l ? dueAt(anchorAt, l) <= now : true;
        })
      : existing.sentLevels;
    return db.lifecycleTimer.update({
      where: { id: existing.id },
      data: {
        anchorAt,
        sentLevels,
        context: { ...(existing.context as Record<string, string>), ...context },
        customerName: s.customerName ?? existing.customerName,
        customerPhone: s.customerPhone ?? existing.customerPhone,
      },
    });
  }
  const owner = s.owner ?? (await pickOwner(c, tenantId, rule.ownerRole, s.ownerErpUser));
  return db.lifecycleTimer.create({
    data: {
      tenantId,
      ruleId: rule.id,
      doctype: s.doctype,
      docName: s.docName,
      anchorAt: s.anchorAt,
      ownerStaffId: owner?.id ?? null,
      customerName: s.customerName ?? null,
      customerPhone: s.customerPhone ?? null,
      context,
    },
  });
}

/** Close the open timers of the given rules on a document (step done, or cancelled). */
export async function closeTimers(c: Container, tenantId: string, ruleKeys: string[], doctype: string, docName: string, status: 'done' | 'cancelled' = 'done') {
  const db = tenantDb(c.prisma, tenantId);
  const r = await db.lifecycleTimer.updateMany({
    where: { doctype, docName, status: 'open', rule: { key: { in: ruleKeys } } },
    data: { status, completedAt: new Date() },
  });
  return r.count;
}

// ---------------- Scan & send ----------------

export const dueAt = (anchor: Date, l: Pick<ReminderLevel, 'offsetMinutes'>) => new Date(anchor.getTime() + l.offsetMinutes * 60_000);

/** Fill {{placeholders}} from the timer context. Unknown placeholders become empty. */
export function render(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k: string) => vars[k] ?? '');
}

type TimerWithRefs = LifecycleTimer & {
  rule: { key: string; enabled: boolean; ownerRole: LifecycleRole; escalationRole: LifecycleRole; levels: ReminderLevel[] };
  owner: StaffMember | null;
  tenant: Tenant;
};

async function recipients(c: Container, t: TimerWithRefs, level: ReminderLevel): Promise<Array<{ name: string; phone: string }>> {
  if (level.audience === 'customer') return t.customerPhone ? [{ name: t.customerName ?? 'Customer', phone: t.customerPhone }] : [];
  const db = tenantDb(c.prisma, t.tenantId);
  if (level.audience === 'owner') {
    if (!t.owner?.active) return [];
    // Leave cover: while the owner is on approved leave, their backup (or the rest of the role) gets the reminder.
    const today = localDate(erpContext(t.tenant).settings.timezone);
    const away = (id: string) => db.leaveRequest.findFirst({ where: { staffId: id, status: 'approved', fromDate: { lte: today }, toDate: { gte: today } } });
    if (!(await away(t.owner.id))) return [{ name: t.owner.name, phone: t.owner.phone }];
    const backup = t.owner.backupStaffId ? await db.staffMember.findFirst({ where: { id: t.owner.backupStaffId, active: true } }) : null;
    if (backup && !(await away(backup.id))) return [{ name: backup.name, phone: backup.phone }];
    const pool = await db.staffMember.findMany({ where: { active: true, id: { not: t.owner.id }, roles: { has: t.rule.ownerRole } } });
    const present = [];
    for (const s of pool) if (!(await away(s.id))) present.push({ name: s.name, phone: s.phone });
    return present;
  }
  const byRole = (role: LifecycleRole) => db.staffMember.findMany({ where: { active: true, roles: { has: role } } });
  let staff = await byRole(level.audience === 'management' ? 'management' : t.rule.escalationRole);
  // Escalating to yourself is pointless: if the owner is the only escalation contact, go to management.
  if (level.audience === 'escalation' && staff.every((s) => s.id === t.ownerStaffId)) staff = await byRole('management');
  return staff.map((s) => ({ name: s.name, phone: s.phone }));
}

async function sendLevel(c: Container, t: TimerWithRefs, level: ReminderLevel) {
  const vars: Record<string, string> = {
    name: t.docName,
    customer_name: t.customerName ?? '',
    owner_name: t.owner?.name ?? '',
    ...(t.context as Record<string, string>),
  };
  const text = render(level.message, vars);
  vars.message = text;
  const tpl = await c.prisma.messageTemplate.findFirst({ where: { key: level.templateKey } });
  const params = tpl ? tpl.params.map((p) => vars[p] ?? '') : [text];
  let sent = 0;
  for (const to of await recipients(c, t, level)) {
    try {
      await sendWhatsApp(c, t.tenant, {
        kind: level.audience === 'customer' ? 'reminder' : 'notice',
        channel: level.audience === 'customer' ? 'customer' : 'staff',
        phone: to.phone,
        name: to.name,
        templateKey: level.templateKey,
        params,
        fallbackText: text,
        ref: `lc:${t.id}:${level.level}`,
      });
      sent++;
    } catch (err) {
      logger.warn({ tenantId: t.tenantId, timerId: t.id, level: level.level, err: (err as Error).message }, 'lifecycle reminder failed');
    }
  }
  return sent;
}

/**
 * Day-7 / day-30 reviews: compute the project health score once per review, write it to the Project, put it in the
 * message context ({{health_score}}, {{health_reasons}}) and alert management when it is below the tenant threshold.
 */
async function reviewHealth(c: Container, t: TimerWithRefs, now: Date) {
  const ctx = t.context as Record<string, string>;
  if (ctx.health_score !== undefined) return;
  const erp = c.erp(t.tenant);
  let customer: string | undefined;
  try {
    customer = ((await erp.get('Project', t.docName)).customer as string | undefined) ?? undefined;
  } catch {
    customer = undefined;
  }
  const h = await computeHealth(c, t.tenant, erp, { name: t.docName, customer }, now);
  const next = { ...ctx, health_score: String(h.score), health_reasons: h.reasons.join(', ') || 'no issues found' };
  t.context = next;
  await tenantDb(c.prisma, t.tenantId).lifecycleTimer.update({ where: { id: t.id }, data: { context: next } });
  await erp.update('Project', t.docName, { [HEALTH_FIELD]: h.score }).catch(() => undefined);
  const threshold = erpContext(t.tenant).settings.lifecycle.healthThreshold;
  if (h.score < threshold) {
    const text = `⚠️ Health ${h.score}/100 for ${t.customerName ?? t.docName} (${t.docName}) at ${t.rule.key === 'review.day7' ? 'day 7' : 'day 30'}: ${next.health_reasons}.`;
    const mgmt = await tenantDb(c.prisma, t.tenantId).staffMember.findMany({ where: { active: true, roles: { has: 'management' } } });
    for (const m of mgmt) {
      await sendWhatsApp(c, t.tenant, { kind: 'notice', channel: 'staff', phone: m.phone, name: m.name, templateKey: 'lifecycle_notice', params: [text], fallbackText: text, ref: `lc:${t.id}:health` }).catch((err) =>
        logger.warn({ tenantId: t.tenantId, err: (err as Error).message }, 'health alert failed'),
      );
    }
  }
}

/**
 * lifecycle.scan — every 5 minutes. Sends each enabled level of each open timer once, when it is due.
 * The level is claimed (pushed to sentLevels) before sending, so concurrent scans never double-send.
 * Disabled levels and disabled rules are skipped (and fire later if re-enabled while still fresh).
 * A timer closes itself once every enabled level has been handled.
 */
export async function scanTimers(c: Container, now = new Date()) {
  const timers = (await withSystemTx(c.prisma, (tx) =>
    tx.lifecycleTimer.findMany({
      where: { status: 'open', rule: { enabled: true }, tenant: { status: { in: ['trial', 'active', 'past_due'] } } },
      include: { rule: { include: { levels: true } }, owner: true, tenant: true },
      orderBy: { anchorAt: 'asc' },
      take: 2000,
    }),
  )) as TimerWithRefs[];
  let sent = 0;
  let skipped = 0;
  for (const t of timers) {
    if (!t.tenant.cwBotTokenEnc) continue;
    const db = tenantDb(c.prisma, t.tenantId);
    const levels = t.rule.levels.filter((l) => l.enabled).sort((a, b) => a.level - b.level);
    const handled = new Set(t.sentLevels);
    for (const l of levels) {
      if (handled.has(l.level)) continue;
      const due = dueAt(t.anchorAt, l);
      if (due > now) continue;
      const claim = await db.lifecycleTimer.updateMany({
        where: { id: t.id, status: 'open', NOT: { sentLevels: { has: l.level } } },
        data: { sentLevels: { push: l.level } },
      });
      if (claim.count === 0) continue;
      handled.add(l.level);
      if (now.getTime() - due.getTime() > STALE_AFTER_MS) {
        skipped++;
        continue;
      }
      if (t.rule.key.startsWith('review.')) await reviewHealth(c, t, now).catch((err) => logger.warn({ timerId: t.id, err: (err as Error).message }, 'health score failed'));
      sent += await sendLevel(c, t, l);
    }
    if (levels.length > 0 && levels.every((l) => handled.has(l.level))) {
      await db.lifecycleTimer.updateMany({ where: { id: t.id, status: 'open' }, data: { status: 'done', completedAt: now } });
    }
  }
  return { timers: timers.length, sent, skipped };
}
