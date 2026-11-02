import { QUEUES, formatMoney, normalizePhone, t, type Currency, type DraftPayload, type Language } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { erpContext } from '../erpnext/mappers.js';
import { incrementUsage } from '../usage/usage.js';
import { sendWhatsApp } from './whatsapp.js';
import { planLimits, usageFor } from '../billing/gating.js';

type SI = { name: string; customer: string; grand_total: number; outstanding_amount: number; due_date: string; currency: string; contact_mobile?: string; docstatus: number };

async function loadTenant(c: Container, tenantId: string): Promise<Tenant> {
  return withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
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
  await sendWhatsApp(c, tenant, {
    kind: 'invoice',
    phone,
    name: inv.customer,
    templateKey: 'invoice',
    params: [inv.customer, tenant.name, inv.name, formatMoney(inv.grand_total, cur), inv.due_date],
    fallbackText: `Hi ${inv.customer}, here is invoice ${inv.name} from ${tenant.name} for ${formatMoney(inv.grand_total, cur)}, due ${inv.due_date}.`,
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
  for (const inv of invoices) {
    // at most one reminder per invoice per 20h
    if (await alreadySent(c, tenant.id, 'reminder', inv.name, 20 * 3600_000)) continue;
    const phone = await customerPhone(c, tenant, inv.customer);
    if (!phone) continue;
    const cur = (inv.currency ?? tenant.currency) as Currency;
    const amount = formatMoney(inv.outstanding_amount, cur);
    await sendWhatsApp(c, tenant, {
      kind: 'reminder',
      phone,
      name: inv.customer,
      templateKey: 'reminder',
      params: [inv.customer, tenant.name, amount, inv.name, inv.due_date],
      fallbackText: t(lang, 'bot.reminder', { party: inv.customer, amount, ref: inv.name }),
      ref: inv.name,
    });
    sent++;
  }
  await reply(sent ? `⏰ Sent ${sent} reminder(s).` : 'No reminder sent (no WhatsApp number on file or reminded recently).');
  return { sent };
}

/** Hour of day in the tenant's timezone. */
export function localHour(timezone: string, at = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(at));
}
export function localDate(timezone: string, at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

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

/** Evening WhatsApp summary to owners. Figures come from NextAi-posted drafts + ERPNext balances. */
export async function sendDailySummary(c: Container, tenant: Tenant, at = new Date()) {
  const { settings, company } = erpContext(tenant);
  const day = localDate(settings.timezone, at);
  const db = tenantDb(c.prisma, tenant.id);
  const posted = await db.draft.findMany({ where: { status: 'posted', updatedAt: { gte: new Date(at.getTime() - 24 * 3600_000) } } });
  const today = posted.filter((d) => (d.payload as DraftPayload).date === day);
  const sum = (types: string[]) => today.filter((d) => types.includes(d.type)).reduce((s, d) => s + (d.payload as DraftPayload).total, 0);
  const cur = tenant.currency as Currency;
  let cash = 0;
  try {
    const b = await c.erp(tenant).getBalances(company);
    cash = b.cash + b.bank;
  } catch (err) {
    logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'balances unavailable for summary');
  }
  const pending = await db.draft.count({ where: { status: { in: ['pending', 'needs_review'] } } });
  const vars = {
    sales: formatMoney(sum(['sales_invoice']), cur),
    expenses: formatMoney(sum(['purchase_invoice', 'journal_entry']), cur),
    cash: formatMoney(cash, cur),
    pending: String(pending),
  };
  const owners = await db.user.findMany({ where: { role: 'owner', status: 'active', phone: { not: null } } });
  for (const o of owners) {
    await sendWhatsApp(c, tenant, {
      kind: 'summary',
      phone: o.phone!,
      name: o.name,
      templateKey: 'daily_summary',
      params: [vars.sales, vars.expenses, vars.cash, vars.pending],
      fallbackText: t((o.language ?? tenant.language) as Language, 'bot.dailySummary', vars),
      ref: `summary-${day}`,
    });
  }
  return vars;
}
