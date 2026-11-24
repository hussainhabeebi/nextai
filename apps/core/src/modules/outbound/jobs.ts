import { QUEUES, formatMoney, normalizePhone, t, type Currency, type DraftPayload, type Language } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { erpContext } from '../erpnext/mappers.js';
import { incrementUsage } from '../usage/usage.js';
import { sendWhatsApp } from './whatsapp.js';
import { planLimits, usageFor } from '../billing/gating.js';
import { emailDailySummary } from '../email/reports.js';
import { paymentLinkFor } from '../razorpay/service.js';
import { buildBriefing } from '../briefing/briefing.js';
import { localDate } from './time.js';

type SI = { name: string; customer: string; grand_total: number; outstanding_amount: number; due_date: string; currency: string; contact_mobile?: string; docstatus: number };

async function loadTenant(c: Container, tenantId: string): Promise<Tenant> {
  return withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
}

async function lastSent(c: Container, tenantId: string, kind: string, ref: string, sinceMs: number): Promise<Date | undefined> {
  const hit = await tenantDb(c.prisma, tenantId).outboundMessage.findFirst({
    where: { kind, ref, status: 'sent', createdAt: { gte: new Date(Date.now() - sinceMs) } },
    orderBy: { createdAt: 'desc' },
  });
  return hit?.createdAt;
}

async function alreadySent(c: Container, tenantId: string, kind: string, ref: string, sinceMs = 0): Promise<boolean> {
  const hit = await tenantDb(c.prisma, tenantId).outboundMessage.findFirst({
    where: { kind, ref, status: 'sent', createdAt: sinceMs ? { gte: new Date(Date.now() - sinceMs) } : undefined },
  });
  return !!hit;
}

/** Customer phone: from the draft (WhatsApp-created) or ERPNext Customer.mobile_no. */
async function customerPhone(c: Container, tenant: Tenant, customer: string, hint?: string): Promise<string | undefined> {
  if (hint) return normalizePhone(hint, tenant.country);
  try {
    const cust = await c.erp(tenant).get<{ mobile_no?: string; whatsapp_no?: string }>('Customer', customer);
    const raw = cust.whatsapp_no ?? cust.mobile_no;
    return raw ? normalizePhone(raw, tenant.country) : undefined;
  } catch {
    return undefined;
  }
}

/** A payment link when the business takes online payments; a Razorpay hiccup never blocks the invoice or reminder. */
async function linkOrNothing(c: Container, tenant: Tenant, inv: SI, phone?: string): Promise<string | undefined> {
  try {
    return await paymentLinkFor(c, tenant, inv, phone);
  } catch (err) {
    logger.warn({ tenantId: tenant.id, invoice: inv.name, err: (err as Error).message }, 'payment link failed; sending without it');
    return undefined;
  }
}

/** outbound.invoice: Sales Invoice PDF → customer's WhatsApp (template + document). */
export async function sendInvoice(c: Container, job: { tenantId: string; invoiceName: string; draftId?: string }) {
  const tenant = await loadTenant(c, job.tenantId);
  if (await alreadySent(c, tenant.id, 'invoice', job.invoiceName)) return { skipped: 'already_sent' };
  if ((await usageFor(c, tenant, 'invoicesSentPerMonth')) >= (await planLimits(c, tenant)).invoicesSentPerMonth) return { skipped: 'plan_limit' };
  const erp = c.erp(tenant);
  const inv = await erp.get<SI>('Sales Invoice', job.invoiceName);
  if (inv.docstatus !== 1) return { skipped: 'not_submitted' };
  const draft = job.draftId ? await tenantDb(c.prisma, tenant.id).draft.findUnique({ where: { id: job.draftId } }) : null;
  const phone = await customerPhone(c, tenant, inv.customer, (draft?.payload as DraftPayload | undefined)?.partyPhone ?? inv.contact_mobile);
  if (!phone) return { skipped: 'no_phone' };
  const pdf = await erp.downloadPdf('Sales Invoice', inv.name, erpContext(tenant).settings.invoiceTemplate);
  const cur = (inv.currency ?? tenant.currency) as Currency;
  const payUrl = await linkOrNothing(c, tenant, inv, phone);
  const params = [inv.customer, tenant.name, inv.name, formatMoney(inv.grand_total, cur), inv.due_date];
  await sendWhatsApp(c, tenant, {
    kind: 'invoice',
    phone,
    name: inv.customer,
    ...(payUrl ? { templateKey: 'invoice_pay', params: [...params, payUrl], alt: { templateKey: 'invoice', params } } : { templateKey: 'invoice', params }),
    fallbackText: `Hi ${inv.customer}, here is invoice ${inv.name} from ${tenant.name} for ${formatMoney(inv.grand_total, cur)}, due ${inv.due_date}.${payUrl ? `\nPay online: ${payUrl}` : ''}`,
    file: { filename: `${inv.name}.pdf`, content: pdf, mime: 'application/pdf' },
    ref: inv.name,
  });
  await incrementUsage(c.prisma, tenant.id, { invoicesSent: 1 });
  return { sent: true };
}

/** outbound.receipt: Payment Entry (Receive) → receipt to the customer. */
export async function sendReceipt(c: Container, job: { tenantId: string; paymentName: string }) {
  const tenant = await loadTenant(c, job.tenantId);
  if (await alreadySent(c, tenant.id, 'receipt', job.paymentName)) return { skipped: 'already_sent' };
  const erp = c.erp(tenant);
  const pe = await erp.get<{ name: string; party: string; party_type: string; paid_amount: number; payment_type: string; docstatus: number; paid_to_account_currency?: string }>(
    'Payment Entry',
    job.paymentName,
  );
  if (pe.docstatus !== 1 || pe.payment_type !== 'Receive' || pe.party_type !== 'Customer') return { skipped: 'not_applicable' };
  const phone = await customerPhone(c, tenant, pe.party);
  if (!phone) return { skipped: 'no_phone' };
  const cur = (pe.paid_to_account_currency ?? tenant.currency) as Currency;
  const pdf = await erp.downloadPdf('Payment Entry', pe.name);
  await sendWhatsApp(c, tenant, {
    kind: 'receipt',
    phone,
    name: pe.party,
    templateKey: 'receipt',
    params: [pe.party, tenant.name, formatMoney(pe.paid_amount, cur), pe.name],
    fallbackText: `Thank you ${pe.party}! ${tenant.name} received ${formatMoney(pe.paid_amount, cur)} (ref ${pe.name}).`,
    file: { filename: `${pe.name}.pdf`, content: pdf, mime: 'application/pdf' },
    ref: pe.name,
  });
  return { sent: true };
}

/** outbound.reminder: one invoice, or all outstanding invoices of a party. */
export async function sendReminder(
  c: Container,
  job: { tenantId: string; invoiceName?: string; party?: string; conversationId?: number },
) {
  const tenant = await loadTenant(c, job.tenantId);
  const erp = c.erp(tenant);
  const lang = (tenant.language as Language) ?? 'en';
  let invoices: SI[];
  if (job.invoiceName) {
    invoices = [await erp.get<SI>('Sales Invoice', job.invoiceName)];
  } else if (job.party) {
    invoices = await erp.list<SI>('Sales Invoice', {
      filters: [
        ['customer', 'like', `%${job.party}%`],
        ['docstatus', '=', 1],
        ['outstanding_amount', '>', 0],
      ],
      fields: ['name', 'customer', 'grand_total', 'outstanding_amount', 'due_date', 'currency', 'docstatus'],
      orderBy: 'due_date asc',
      limit: 20,
    });
  } else return { skipped: 'nothing_to_remind' };

  invoices = invoices.filter((i) => i.docstatus === 1 && i.outstanding_amount > 0);
  const reply = async (text: string) => {
    if (job.conversationId) await c.chatwoot(tenant).sendText(job.conversationId, text);
  };
  if (invoices.length === 0) {
    await reply(`✅ Nothing outstanding${job.party ? ` for ${job.party}` : ''}.`);
    return { skipped: 'nothing_outstanding' };
  }
  let sent = 0;
  const noPhone: SI[] = [];
  const recent: Array<{ inv: SI; at: Date }> = [];
  for (const inv of invoices) {
    // at most one reminder per invoice per 20h
    const last = await lastSent(c, tenant.id, 'reminder', inv.name, 20 * 3600_000);
    if (last) {
      recent.push({ inv, at: last });
      continue;
    }
    const phone = await customerPhone(c, tenant, inv.customer);
    if (!phone) {
      noPhone.push(inv);
      continue;
    }
    const cur = (inv.currency ?? tenant.currency) as Currency;
    const amount = formatMoney(inv.outstanding_amount, cur);
    const payUrl = await linkOrNothing(c, tenant, inv, phone);
    const params = [inv.customer, tenant.name, amount, inv.name, inv.due_date];
    await sendWhatsApp(c, tenant, {
      kind: 'reminder',
      phone,
      name: inv.customer,
      ...(payUrl ? { templateKey: 'reminder_pay', params: [...params, payUrl], alt: { templateKey: 'reminder', params } } : { templateKey: 'reminder', params }),
      fallbackText: t(lang, 'bot.reminder', { party: inv.customer, amount, ref: inv.name }) + (payUrl ? `\nPay online: ${payUrl}` : ''),
      ref: inv.name,
    });
    sent++;
  }

  const tz = erpContext(tenant).settings.timezone;
  const who = job.party ? invoices[0]!.customer : undefined;
  const status: string[] = [];
  if (sent) status.push(`✅ Sent ${sent} reminder${sent === 1 ? '' : 's'}${who ? ` to ${who}` : ''}.`);
  if (recent.length) {
    const at = new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' }).format(recent[0]!.at);
    status.push(`⏳ Already reminded about ${recent.map((r) => r.inv.name).join(', ')} (last at ${at}). I wait 20 hours between reminders.`);
  }
  if (noPhone.length) {
    status.push(`📵 No WhatsApp number on file for ${[...new Set(noPhone.map((i) => i.customer))].join(', ')}.`);
    status.push(`📋 I've made a ready reminder below — forward it to them.`);
    status.push(`💡 Add their mobile number in ERPNext (Customer → Mobile No) and I'll send reminders myself next time.`);
  }
  await reply(status.join('\n'));
  // Auto-created reminder the owner can forward by hand (one message per customer, easy to forward).
  for (const [customer, list] of groupBy(noPhone, (i) => i.customer)) {
    const links = new Map<string, string | undefined>();
    for (const inv of list) links.set(inv.name, await linkOrNothing(c, tenant, inv));
    await reply(reminderMessage(tenant, customer, list, links, localDate(tz)));
  }
  return { sent, ...(noPhone.length ? { noPhone: noPhone.length } : {}), ...(recent.length ? { recent: recent.length } : {}) };
}

const groupBy = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** A polite, structured payment reminder for the customer, ready to forward. */
export function reminderMessage(tenant: Tenant, customer: string, invoices: SI[], payLinks: Map<string, string | undefined>, today: string): string {
  const m = (inv: SI) => formatMoney(inv.outstanding_amount, (inv.currency ?? tenant.currency) as Currency);
  const total = invoices.reduce((s, i) => s + i.outstanding_amount, 0);
  const lines = [`Hi ${customer} 👋`, '', `This is a friendly payment reminder from *${tenant.name}*.`, '', '━━━━━━━━━━━━━━━━━━'];
  for (const inv of invoices) {
    const late = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${inv.due_date}T00:00:00Z`)) / 86400_000);
    lines.push(`🧾 Invoice *${inv.name}*`, `💰 Amount due: *${m(inv)}*`, `📅 Due date: ${shortDate(inv.due_date)}${late > 0 ? ` (${late} day${late === 1 ? '' : 's'} overdue)` : ''}`);
    const link = payLinks.get(inv.name);
    if (link) lines.push(`💳 Pay online: ${link}`);
    lines.push('━━━━━━━━━━━━━━━━━━');
  }
  if (invoices.length > 1) lines.push(`*Total due: ${formatMoney(total, (invoices[0]!.currency ?? tenant.currency) as Currency)}*`);
  lines.push('', 'Kindly arrange the payment at the earliest. If you have already paid, please ignore this message 🙏', '', `Thank you,`, `${tenant.name}`);
  return lines.join('\n');
}

export { localDate, localHour } from './time.js';

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** Per-tenant reminder scan: enqueue reminders for invoices whose due date matches a configured offset. */
export async function scanReminders(c: Container, tenant: Tenant, at = new Date()) {
  const { settings } = erpContext(tenant);
  if (!settings.reminders.enabled) return 0;
  const today = localDate(settings.timezone, at);
  const dueDates = settings.reminders.offsetsDays.map((o) => addDays(today, -o));
  const invoices = await c.erp(tenant).list<SI>('Sales Invoice', {
    filters: [
      ['docstatus', '=', 1],
      ['outstanding_amount', '>', 0],
      ['due_date', 'in', dueDates],
    ],
    fields: ['name', 'due_date'],
    limit: 500,
  });
  for (const inv of invoices) {
    await c.queue.enqueue(QUEUES.outboundReminder, { tenantId: tenant.id, invoiceName: inv.name }, { jobId: `rem-${tenant.id}-${inv.name}-${today}` });
  }
  return invoices.length;
}

/** Today's figures for the summary. Figures come from NextAi-posted drafts + ERPNext balances. */
export async function summaryFigures(c: Container, tenant: Tenant, at = new Date()) {
  const { settings, company } = erpContext(tenant);
  const day = localDate(settings.timezone, at);
  const db = tenantDb(c.prisma, tenant.id);
  const posted = await db.draft.findMany({ where: { status: 'posted', updatedAt: { gte: new Date(at.getTime() - 24 * 3600_000) } } });
  const today = posted.filter((d) => (d.payload as DraftPayload).date === day);
  const sum = (types: string[]) => today.filter((d) => types.includes(d.type)).reduce((s, d) => s + (d.payload as DraftPayload).total, 0);
  const cur = tenant.currency as Currency;
  let cash: string = 'not available right now'; // never a made-up ₹0.00 when ERPNext can't be read
  try {
    const b = await c.erp(tenant).getBalances(company);
    cash = formatMoney(b.cash + b.bank, cur);
  } catch (err) {
    logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'balances unavailable for summary');
  }
  const pending = await db.draft.count({ where: { status: { in: ['pending', 'needs_review'] } } });
  const vars = {
    sales: formatMoney(sum(['sales_invoice']), cur),
    expenses: formatMoney(sum(['purchase_invoice', 'journal_entry']), cur),
    cash,
    pending: String(pending),
  };
  return { day, vars };
}

/** Daily briefing to owners: email (Resend) and WhatsApp (Chatwoot). Approved template outside the 24h window. */
export async function sendDailySummary(c: Container, tenant: Tenant, at = new Date()) {
  const b = await buildBriefing(c, tenant, at);
  const db = tenantDb(c.prisma, tenant.id);
  // Email (Resend) first so a WhatsApp failure never blocks it, and vice versa.
  try {
    await emailDailySummary(c, tenant, b.day, b.templateVars, { rows: b.rows });
  } catch (err) {
    logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'summary email failed');
  }
  if (!tenant.cwBotTokenEnc) return b.templateVars;
  const owners = await db.user.findMany({ where: { role: 'owner', status: 'active', phone: { not: null } } });
  for (const o of owners) {
    await sendWhatsApp(c, tenant, {
      kind: 'summary',
      phone: o.phone!,
      name: o.name,
      templateKey: 'daily_summary',
      params: [b.templateVars.sales, b.templateVars.expenses, b.templateVars.cash, b.templateVars.pending],
      fallbackText: b.text,
      ref: `summary-${b.day}`,
    });
  }
  return b.templateVars;
}
