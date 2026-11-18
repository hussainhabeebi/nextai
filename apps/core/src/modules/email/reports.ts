import type { Tenant } from '@prisma/client';
import { env } from '../../config/env.js';
import type { Container } from '../../container.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { BullJobQueue } from '../../lib/queue.js';
import { erpContext } from '../erpnext/mappers.js';
import { currentPeriod } from '../usage/usage.js';
import { isEmail } from './mailer.js';
import { reportEmail } from './templates.js';

export interface SummaryFigures {
  sales: string;
  expenses: string;
  cash: string;
  pending: string;
}

/** Owners with an email + extra recipients from tenant.settings.emailReports. */
export async function reportRecipients(c: Container, tenant: Tenant): Promise<string[]> {
  const { settings } = erpContext(tenant);
  if (!settings.emailReports.enabled) return [];
  const owners = await tenantDb(c.prisma, tenant.id).user.findMany({
    where: { role: 'owner', status: 'active', email: { not: null } },
    select: { email: true },
  });
  return [
    ...new Set(
      [...owners.map((o) => o.email!), ...settings.emailReports.recipients]
        .map((e) => e.trim().toLowerCase())
        .filter(isEmail),
    ),
  ];
}

/** Daily summary email (Resend). Logged in outbound_messages with kind "summary_email"; idempotent per day. */
export async function emailDailySummary(
  c: Container,
  tenant: Tenant,
  day: string,
  vars: SummaryFigures,
  opts: { force?: boolean; rows?: Array<{ label: string; value: string }> } = {},
): Promise<{ sent: number } | { skipped: string }> {
  if (!c.mailer.configured) return { skipped: 'mail_not_configured' };
  const to = await reportRecipients(c, tenant);
  if (to.length === 0) return { skipped: 'no_recipients' };
  const db = tenantDb(c.prisma, tenant.id);
  const ref = opts.force ? `summary-email-${day}-manual-${Date.now()}` : `summary-email-${day}`;
  if (
    !opts.force &&
    (await db.outboundMessage.findFirst({ where: { kind: 'summary_email', ref, status: 'sent' } }))
  )
    return { skipped: 'already_sent' };
  const { html, text } = reportEmail({
    title: `${tenant.name} — daily summary`,
    intro: `Here is how ${day} went. Figures come from entries recorded by NextAi and your live bank/cash balances.`,
    rows: opts.rows ?? [
      { label: 'Sales today', value: vars.sales },
      { label: 'Expenses today', value: vars.expenses },
      { label: 'Cash & bank', value: vars.cash },
      { label: 'Waiting for your approval', value: vars.pending },
    ],
    cta: { label: 'Open NextAi', url: env().APP_URL },
    footer:
      'You receive this because you are an owner or report recipient for this business. Change it in NextAi → Settings, or ask support.',
  });
  const log = await db.outboundMessage.create({
    data: {
      tenantId: tenant.id,
      kind: 'summary_email',
      toPhone: to.join(',').slice(0, 250),
      ref,
      status: 'sending',
    },
  });
  try {
    await c.mailer.send({
      to,
      subject: `${tenant.name}: daily summary for ${day}`,
      html,
      text,
      tags: { type: 'daily_summary', tenant: tenant.slug },
    });
    await db.outboundMessage.update({ where: { id: log.id }, data: { status: 'sent' } });
    return { sent: to.length };
  } catch (err) {
    await db.outboundMessage.update({
      where: { id: log.id },
      data: { status: 'failed', error: (err as Error).message.slice(0, 500) },
    });
    throw err;
  }
}

/** Platform-wide figures for the admin morning report and the integrations page preview. */
export async function platformReportFigures(c: Container, at = new Date()) {
  const since = new Date(at.getTime() - 24 * 3600_000);
  const period = currentPeriod();
  const [byStatus, newTenants, usage, outbound, review, posted] = await withSystemTx(c.prisma, (tx) =>
    Promise.all([
      tx.tenant.groupBy({ by: ['status'], _count: true }),
      tx.tenant.count({ where: { createdAt: { gte: since } } }),
      tx.usageCounter.findMany({ where: { period } }),
      tx.outboundMessage.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true }),
      tx.draft.count({ where: { status: { in: ['needs_review', 'failed'] } } }),
      tx.draft.count({ where: { status: 'posted', updatedAt: { gte: since } } }),
    ]),
  );
  const count = (s: string) => byStatus.find((x) => x.status === s)?._count ?? 0;
  const out = (s: string) => outbound.find((x) => x.status === s)?._count ?? 0;
  let failedJobs = 0;
  if (c.queue instanceof BullJobQueue)
    for (const q of c.queue.allQueues()) failedJobs += await q.getFailedCount();
  return {
    tenantsActive: count('active'),
    tenantsTrial: count('trial'),
    tenantsPastDue: count('past_due'),
    newTenants24h: newTenants,
    entriesPosted24h: posted,
    reviewQueue: review,
    outboundSent24h: out('sent'),
    outboundFailed24h: out('failed'),
    messagesThisMonth: usage.reduce((s, u) => s + u.messages, 0),
    ocrPagesThisMonth: usage.reduce((s, u) => s + u.ocrPages, 0),
    aiCostUsdThisMonth: usage.reduce((s, u) => s + Number(u.aiCostMicros), 0) / 1e6,
    failedJobs,
  };
}

/** report.admin_daily — morning email to ADMIN_REPORT_EMAILS. */
export async function sendAdminDailyReport(c: Container, at = new Date()) {
  const to = env().ADMIN_REPORT_EMAILS;
  if (!c.mailer.configured || to.length === 0) return { skipped: 'not_configured' };
  const f = await platformReportFigures(c, at);
  const day = at.toISOString().slice(0, 10);
  const { html, text } = reportEmail({
    title: `Platform report — ${day}`,
    intro: 'Last 24 hours across all tenants.',
    rows: [
      {
        label: 'Active / trial / past-due tenants',
        value: `${f.tenantsActive} / ${f.tenantsTrial} / ${f.tenantsPastDue}`,
      },
      { label: 'New tenants (24h)', value: String(f.newTenants24h) },
      { label: 'Entries posted (24h)', value: String(f.entriesPosted24h) },
      { label: 'Review queue', value: String(f.reviewQueue) },
      { label: 'WhatsApp sent / failed (24h)', value: `${f.outboundSent24h} / ${f.outboundFailed24h}` },
      { label: 'Messages this month', value: String(f.messagesThisMonth) },
      { label: 'OCR pages this month', value: String(f.ocrPagesThisMonth) },
      { label: 'AI cost this month', value: `$${f.aiCostUsdThisMonth.toFixed(2)}` },
      { label: 'Failed jobs (all queues)', value: String(f.failedJobs) },
    ],
    cta: { label: 'Open admin console', url: `${env().APP_URL}/admin` },
    footer: 'Sent to ADMIN_REPORT_EMAILS by the report.admin_daily job.',
  });
  const alert = f.outboundFailed24h > 0 || f.failedJobs > 0 || f.reviewQueue > 0 ? ' ⚠' : '';
  try {
    await c.mailer.send({
      to,
      subject: `NextAi platform report ${day}${alert}`,
      html,
      text,
      tags: { type: 'admin_daily' },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, alert: true }, 'admin daily report failed');
    throw err;
  }
  return { sent: to.length, ...f };
}
