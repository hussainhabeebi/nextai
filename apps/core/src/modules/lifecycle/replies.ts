import type { ChatwootWebhook } from '@nextai/chatwoot-client';
import type { ErpClient } from '@nextai/erpnext-client';
import { QUEUES } from '@nextai/shared';
import type { LifecycleRole, LifecycleTimer, Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { sha256 } from '../../lib/crypto.js';
import { tenantDb } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { tenantKey } from '../../storage/storage.js';
import { erpContext } from '../erpnext/mappers.js';
import { localDate } from '../outbound/jobs.js';
import { sendWhatsApp } from '../outbound/whatsapp.js';
import { incrementUsage } from '../usage/usage.js';

/**
 * WhatsApp messages from customers (numbers that are not app users) on a tenant with an installed playbook.
 * They are matched to the customer's open lifecycle step, in this order:
 *   kickoff.data        → files go to the Project, the AI ticks off the data checklist and replies with what is still missing
 *   bot.monthly_update  → files + text go to the Project and a "Monthly bot update" Task is created for the AI manager
 *   support.issue       → comment on the open Issue
 *   support.resolved    → "still not working" re-opens the Issue, anything else is logged as confirmation
 *   review.day7/day30   → logged on the Project as feedback
 * Otherwise a known ERPNext Customer gets an Issue (or a comment on their open Issue) when autoIssueFromWhatsApp is on.
 */

const REPLY_RULES = ['kickoff.data', 'bot.monthly_update', 'support.issue', 'support.resolved', 'review.day7', 'review.day30'] as const;
const RECENT_MS = 7 * 86400_000;
const NOT_FIXED = /\b(not|still|again|same|doesn'?t|isn'?t|no)\b.*\b(work|working|fixed|solved|issue|problem|error)|\bnot (fixed|solved|working)\b/i;

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/csv': 'csv' };

interface Ctx {
  c: Container;
  tenant: Tenant;
  erp: ErpClient;
  conversationId: number;
  phone: string;
  text: string;
  files: Array<{ filename: string; content: Uint8Array; mime: string }>;
}

type TimerRow = LifecycleTimer & { rule: { key: string; escalationRole: LifecycleRole }; owner: { id: string; name: string; phone: string; active: boolean } | null };

async function addComment(erp: ErpClient, doctype: string, name: string, content: string) {
  await erp.create('Comment', { comment_type: 'Comment', reference_doctype: doctype, reference_name: name, content }).catch((err) =>
    logger.warn({ doctype, err: (err as Error).message }, 'erp comment failed'),
  );
}

async function attachAll(x: Ctx, doctype: string, name: string) {
  for (const f of x.files) await x.erp.uploadFile(f, { doctype, name }, true);
}

async function notifyStaff(x: Ctx, staff: Array<{ name: string; phone: string }>, text: string, ref: string) {
  for (const s of staff) {
    await sendWhatsApp(x.c, x.tenant, { kind: 'notice', channel: 'staff', phone: s.phone, name: s.name, templateKey: 'lifecycle_notice', params: [text], fallbackText: text, ref }).catch((err) =>
      logger.warn({ tenantId: x.tenant.id, err: (err as Error).message }, 'staff notice failed'),
    );
  }
}

const byRole = (x: Ctx, role: LifecycleRole) => tenantDb(x.c.prisma, x.tenant.id).staffMember.findMany({ where: { active: true, roles: { has: role } } });
const ownerOf = (t: TimerRow) => (t.owner?.active ? [t.owner] : []);
const reply = (x: Ctx, text: string) => x.c.chatwoot(x.tenant).sendText(x.conversationId, text);
const summary = (x: Ctx) => [x.text, x.files.length ? `Files: ${x.files.map((f) => f.filename).join(', ')}` : ''].filter(Boolean).join('\n');

// ---------------- Handlers per step ----------------

async function onDataReply(x: Ctx, t: TimerRow) {
  const db = tenantDb(x.c.prisma, x.tenant.id);
  const checklist = erpContext(x.tenant).settings.lifecycle.dataChecklist;
  const ctx = t.context as Record<string, string>;
  const before = new Set((ctx.data_received ?? '').split('|').filter(Boolean));
  const { covered, usage } = await x.c.ai.llm.checkItems({ text: x.text, fileNames: x.files.map((f) => f.filename), items: checklist.filter((i) => !before.has(i)) });
  if (usage.tokens) await incrementUsage(x.c.prisma, x.tenant.id, { aiTokens: usage.tokens, aiCostMicros: usage.costMicros });
  const received = [...before, ...covered];
  const missing = checklist.filter((i) => !received.includes(i));

  await attachAll(x, 'Project', t.docName);
  await addComment(x.erp, 'Project', t.docName, `Customer sent onboarding data on WhatsApp${covered.length ? ` (${covered.join(', ')})` : ''}:\n${summary(x)}`);
  const context = { ...ctx, data_received: received.join('|'), data_missing: missing.join(', ') };
  if (missing.length === 0) {
    await db.lifecycleTimer.update({ where: { id: t.id }, data: { status: 'done', completedAt: new Date(), context } });
    await reply(x, `Thank you! We now have everything we need (${received.join(', ')}). ${t.owner?.name ?? 'Our team'} will start building your bot.`);
    await notifyStaff(x, ownerOf(t), `✅ ${t.customerName ?? 'Customer'} sent all onboarding data for ${t.docName}. Move the project to Build.`, `lc:${t.id}:data-complete`);
  } else {
    // The chase restarts from this reply: reminders only continue if the customer goes quiet again.
    await db.lifecycleTimer.update({ where: { id: t.id }, data: { anchorAt: new Date(), sentLevels: [], context } });
    await reply(
      x,
      `Thank you! ${covered.length ? `Received: ${covered.join(', ')}. ` : 'We saved what you sent. '}Still needed: ${missing.join(', ')}. You can send them here anytime.`,
    );
    await notifyStaff(x, ownerOf(t), `${t.customerName ?? 'Customer'} sent onboarding data for ${t.docName}. Still missing: ${missing.join(', ')}.`, `lc:${t.id}:data-${Date.now()}`);
  }
  return 'data';
}

async function onMonthlyReply(x: Ctx, t: TimerRow) {
  const ctx = t.context as Record<string, string>;
  const project = ctx.project ?? t.docName.split('@')[0]!;
  const { settings } = erpContext(x.tenant);
  await attachAll(x, 'Project', project);
  await addComment(x.erp, 'Project', project, `Monthly update (${ctx.month ?? ''}) from the customer:\n${summary(x)}`);
  const due = localDate(settings.timezone, new Date(Date.now() + 3 * 86400_000));
  const task = await x.erp.create('Task', {
    subject: `Monthly bot update ${ctx.month ?? ''} — ${t.customerName ?? project}`.trim(),
    project,
    description: summary(x),
    exp_end_date: due,
    status: 'Open',
  });
  const taskName = String(task.name);
  await attachAll(x, 'Task', taskName);
  const owner = t.owner?.active ? t.owner : null;
  const ownerUser = owner ? (await tenantDb(x.c.prisma, x.tenant.id).staffMember.findFirst({ where: { id: owner.id } }))?.erpUser : null;
  if (ownerUser) await x.erp.assign('Task', taskName, [ownerUser], 'Monthly bot update').catch(() => undefined);
  await x.c.queue.enqueue(QUEUES.lifecycleEvent, { tenantId: x.tenant.id, doctype: 'Task', name: taskName, event: 'after_insert' }, { jobId: `lc-task-${x.tenant.id}-${taskName}` });
  await tenantDb(x.c.prisma, x.tenant.id).lifecycleTimer.update({ where: { id: t.id }, data: { status: 'done', completedAt: new Date(), context: { ...ctx, task: taskName } } });
  await reply(x, `Thank you! We will update your bot with these changes by ${due}.`);
  const notify = [...ownerOf(t), ...(await byRole(x, t.rule.escalationRole))].filter((s, i, a) => a.findIndex((y) => y.phone === s.phone) === i);
  await notifyStaff(x, notify, `🆕 Monthly update from ${t.customerName ?? project}: task ${taskName} (due ${due}).`, `lc:${t.id}:monthly`);
  return 'monthly_update';
}

async function onIssueReply(x: Ctx, t: TimerRow) {
  await attachAll(x, 'Issue', t.docName);
  await addComment(x.erp, 'Issue', t.docName, `Customer on WhatsApp:\n${summary(x)}`);
  await notifyStaff(x, ownerOf(t).length ? ownerOf(t) : await byRole(x, 'support'), `💬 ${t.customerName ?? 'Customer'} replied on issue ${t.docName}: ${x.text.slice(0, 200)}`, `lc:${t.id}:reply-${Date.now()}`);
  await reply(x, `Thanks, we added this to your request ${t.docName}.`);
  return 'issue_comment';
}

async function onResolvedReply(x: Ctx, t: TimerRow) {
  const db = tenantDb(x.c.prisma, x.tenant.id);
  await attachAll(x, 'Issue', t.docName);
  if (NOT_FIXED.test(x.text)) {
    await addComment(x.erp, 'Issue', t.docName, `Customer says it is not fixed:\n${summary(x)}`);
    await x.erp.update('Issue', t.docName, { status: 'Open' });
    // Drop the confirmation step so it runs again when the Issue is resolved next time.
    await db.lifecycleTimer.deleteMany({ where: { id: t.id } });
    const issueTimer = await db.lifecycleTimer.findFirst({ where: { doctype: 'Issue', docName: t.docName, rule: { key: 'support.issue' } } });
    // Re-open the support step: its reminders and escalation run again from now (the acknowledgement is not re-sent).
    if (issueTimer) await db.lifecycleTimer.update({ where: { id: issueTimer.id }, data: { status: 'open', anchorAt: new Date(), sentLevels: [1, 2], completedAt: null } });
    await notifyStaff(x, await byRole(x, 'support'), `🔁 Issue ${t.docName} re-opened by ${t.customerName ?? 'the customer'}: ${x.text.slice(0, 200)}`, `lc:${t.id}:reopen-${Date.now()}`);
    await reply(x, `Sorry about that — we have re-opened ${t.docName} and will fix it.`);
    return 'issue_reopened';
  }
  await addComment(x.erp, 'Issue', t.docName, `Customer confirmed on WhatsApp:\n${summary(x)}`);
  await db.lifecycleTimer.update({ where: { id: t.id }, data: { status: 'done', completedAt: new Date() } });
  await reply(x, 'Thank you for confirming! 🙏');
  return 'issue_confirmed';
}

async function onReviewReply(x: Ctx, t: TimerRow) {
  await attachAll(x, 'Project', t.docName);
  await addComment(x.erp, 'Project', t.docName, `Customer feedback (${t.rule.key === 'review.day7' ? 'day 7' : 'day 30'} review):\n${summary(x)}`);
  await notifyStaff(x, ownerOf(t), `📝 Feedback from ${t.customerName ?? 'the customer'} (${t.docName}): ${x.text.slice(0, 300)}`, `lc:${t.id}:feedback-${Date.now()}`);
  await reply(x, 'Thank you for your feedback! 🙏');
  return 'feedback';
}

/** No open step: a known Customer's message becomes (or is added to) an ERPNext Issue. */
async function onUnmatched(x: Ctx): Promise<string | null> {
  if (!erpContext(x.tenant).settings.lifecycle.autoIssueFromWhatsApp) return null;
  const customers = await x.erp.list('Customer', { filters: { mobile_no: x.phone }, fields: ['name', 'customer_name'], limit: 1 });
  const customer = customers[0];
  if (!customer?.name) return null;
  const open = await x.erp.list('Issue', { filters: [['customer', '=', customer.name], ['status', 'in', ['Open', 'Replied', 'On Hold']]], fields: ['name'], limit: 1 });
  if (open[0]?.name) {
    const name = String(open[0].name);
    await attachAll(x, 'Issue', name);
    await addComment(x.erp, 'Issue', name, `Customer on WhatsApp:\n${summary(x)}`);
    await notifyStaff(x, await byRole(x, 'support'), `💬 ${customer.customer_name ?? customer.name} wrote on issue ${name}: ${x.text.slice(0, 200)}`, `lc:issue:${name}:${Date.now()}`);
    await reply(x, `Thanks, we added this to your request ${name}.`);
    return 'issue_comment';
  }
  const issue = await x.erp.create('Issue', {
    subject: (x.text.split('\n')[0] || 'WhatsApp message').slice(0, 120),
    description: summary(x),
    customer: customer.name,
    raised_by: x.phone,
    status: 'Open',
  });
  const name = String(issue.name);
  await attachAll(x, 'Issue', name);
  // The support.issue step acknowledges the customer and alerts support.
  await x.c.queue.enqueue(QUEUES.lifecycleEvent, { tenantId: x.tenant.id, doctype: 'Issue', name, event: 'after_insert' }, { jobId: `lc-issue-${x.tenant.id}-${name}` });
  return 'issue_created';
}

/** Returns the outcome when the message was handled as a lifecycle reply, or null to fall through. */
export async function handleCustomerReply(c: Container, tenant: Tenant, evt: ChatwootWebhook, phone: string): Promise<string | null> {
  if (!tenant.erpApiKeyEnc) return null;
  const db = tenantDb(c.prisma, tenant.id);
  if ((await db.lifecycleRule.count()) === 0) return null;
  const recent = new Date(Date.now() - RECENT_MS);
  const timers = (await db.lifecycleTimer.findMany({
    where: {
      customerPhone: phone,
      rule: { key: { in: [...REPLY_RULES] } },
      OR: [{ status: 'open' }, { status: 'done', rule: { key: { in: ['support.resolved', 'review.day7', 'review.day30'] } }, updatedAt: { gte: recent } }],
    },
    include: { rule: { select: { key: true, escalationRole: true } }, owner: true },
    orderBy: { updatedAt: 'desc' },
  })) as TimerRow[];
  // Reviews and support confirmations are only "open for replies" once their message has gone out.
  const usable = timers.filter((t) => !['review.day7', 'review.day30', 'support.resolved'].includes(t.rule.key) || t.sentLevels.length > 0);
  const pick = (key: string) => usable.find((t) => t.rule.key === key && (t.status === 'open' || key !== 'support.issue'));

  const cw = c.chatwoot(tenant);
  const files: Ctx['files'] = [];
  for (const [i, a] of (evt.attachments ?? []).entries()) {
    const f = await cw.downloadAttachment(a.data_url);
    const hash = sha256(f.content);
    const base = decodeURIComponent(new URL(a.data_url).pathname.split('/').pop() ?? '') || `file-${i + 1}.${EXT[f.mime] ?? 'bin'}`;
    await c.storage.put(tenant.id, tenantKey(tenant.id, 'lifecycle', new Date().toISOString().slice(0, 7), `${hash}-${base}`), f.content, f.mime);
    files.push({ filename: base, content: f.content, mime: f.mime });
  }
  const x: Ctx = { c, tenant, erp: c.erp(tenant), conversationId: evt.conversation!.id, phone, text: evt.content?.trim() ?? '', files };
  if (!x.text && files.length === 0) return null;

  const t = pick('kickoff.data') ?? pick('bot.monthly_update') ?? pick('support.issue') ?? pick('support.resolved') ?? pick('review.day7') ?? pick('review.day30');
  if (t) {
    switch (t.rule.key) {
      case 'kickoff.data':
        return onDataReply(x, t);
      case 'bot.monthly_update':
        return onMonthlyReply(x, t);
      case 'support.issue':
        return onIssueReply(x, t);
      case 'support.resolved':
        return onResolvedReply(x, t);
      default:
        return onReviewReply(x, t);
    }
  }
  return onUnmatched(x);
}
