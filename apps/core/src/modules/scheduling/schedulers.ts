import { QUEUES } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { withSystemTx } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { erpContext } from '../erpnext/mappers.js';
import { localHour, scanReminders, sendDailySummary } from '../outbound/jobs.js';
import { scanTimers } from '../lifecycle/engine.js';
import { sendStaffDigests } from '../lifecycle/digest.js';
import { startMonthlyUpdates } from '../lifecycle/events.js';
import { officeTick } from '../office/schedule.js';
import { sendDeadlineWarnings } from '../briefing/briefing.js';
import { currentPeriod } from '../usage/usage.js';

/** Cross-tenant fan-out uses the system context (audited by design: read-only selection of tenants). */
async function activeTenants(c: Container): Promise<Tenant[]> {
  return withSystemTx(c.prisma, (tx) => tx.tenant.findMany({ where: { status: { in: ['trial', 'active', 'past_due'] } } }));
}

async function forEachTenant(c: Container, fn: (t: Tenant) => Promise<unknown>) {
  let ok = 0;
  let failed = 0;
  for (const t of await activeTenants(c)) {
    try {
      await fn(t);
      ok++;
    } catch (err) {
      failed++;
      logger.warn({ tenantId: t.id, err: (err as Error).message }, 'scheduler tenant failed');
    }
  }
  return { ok, failed };
}

/** schedule.reminders — runs hourly; acts for tenants whose local hour matches their reminder hour. */
export function scheduleReminders(c: Container, at = new Date()) {
  return forEachTenant(c, async (t) => {
    const { settings } = erpContext(t);
    if (t.erpApiKeyEnc && localHour(settings.timezone, at) === settings.reminders.hourLocal) await scanReminders(c, t, at);
  });
}

/** schedule.daily_summary — runs hourly; evening summary at each tenant's configured local hour. */
export function scheduleDailySummary(c: Container, at = new Date()) {
  return forEachTenant(c, async (t) => {
    const { settings } = erpContext(t);
    if (settings.dailySummary.enabled && (t.cwBotTokenEnc || c.mailer.configured) && localHour(settings.timezone, at) === settings.dailySummary.hourLocal) {
      await sendDailySummary(c, t, at);
    }
  });
}

/** lifecycle.scan — every 5 minutes: monthly bot-update timers, due reminder levels, then the morning staff digest. */
export async function lifecycleScan(c: Container, at = new Date()) {
  const monthly = await forEachTenant(c, async (t) => {
    if (t.erpApiKeyEnc) await startMonthlyUpdates(c, t, at);
  });
  const scan = await scanTimers(c, at);
  const digests = await forEachTenant(c, (t) => sendStaffDigests(c, t, at));
  return { monthly, digests, ...scan };
}

/** office.tick — every 5 minutes: attendance nudges, end of day, team summary, meetings, weekly report. */
export function scheduleOffice(c: Container, at = new Date()) {
  return forEachTenant(c, (t) => officeTick(c, t, at));
}

/** schedule.deadlines — runs hourly; tax deadline warnings at each tenant's briefing hour. */
export function scheduleDeadlines(c: Container, at = new Date()) {
  return forEachTenant(c, async (t) => {
    const { settings } = erpContext(t);
    if (t.cwBotTokenEnc && localHour(settings.timezone, at) === settings.dailySummary.hourLocal) await sendDeadlineWarnings(c, t, at);
  });
}

/** usage.rollup — hourly snapshot of per-tenant usage into Redis for the admin dashboard. */
export async function usageRollup(c: Container) {
  const period = currentPeriod();
  const rows = await withSystemTx(c.prisma, (tx) => tx.usageCounter.findMany({ where: { period } }));
  const totals = rows.reduce(
    (a, r) => ({
      messages: a.messages + r.messages,
      ocrPages: a.ocrPages + r.ocrPages,
      aiTokens: a.aiTokens + r.aiTokens,
      aiCostMicros: a.aiCostMicros + Number(r.aiCostMicros),
      invoicesSent: a.invoicesSent + r.invoicesSent,
    }),
    { messages: 0, ocrPages: 0, aiTokens: 0, aiCostMicros: 0, invoicesSent: 0 },
  );
  const day = new Date().toISOString().slice(0, 10);
  await c.redis.hset(`metrics:usage:${period}`, Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, String(v)])));
  // messages/day series: record cumulative month count at this hour; dashboard diffs consecutive days
  await c.redis.hset(`metrics:messages:${period}`, day, String(totals.messages));
  await c.redis.expire(`metrics:messages:${period}`, 90 * 86400);
  return totals;
}

/** health.erpnext — every 5 minutes. */
export async function healthErpnext(c: Container) {
  return forEachTenant(c, async (t) => {
    if (!t.erpApiKeyEnc) return;
    const r = await c.erp(t).ping();
    await c.redis.set(`health:erp:${t.id}`, JSON.stringify({ ...r, at: new Date().toISOString() }), 'EX', 3600);
  });
}

export const SCHEDULE_QUEUES = {
  [QUEUES.scheduleReminders]: '5 * * * *',
  [QUEUES.scheduleDailySummary]: '0 * * * *',
  [QUEUES.scheduleDeadlines]: '2 * * * *',
  [QUEUES.usageRollup]: '15 * * * *',
  [QUEUES.billingSync]: '30 2 * * *',
  [QUEUES.healthErpnext]: '*/5 * * * *',
  [QUEUES.lifecycleScan]: '*/5 * * * *',
  [QUEUES.officeTick]: '*/5 * * * *',
  [QUEUES.reportAdminDaily]: '10 4 * * *', // 08:10 Dubai / 09:40 India
  // weekly full-population audit, Mondays 03:10 UTC
  [QUEUES.scheduleAudit]: '10 3 * * 1',
} as const;
