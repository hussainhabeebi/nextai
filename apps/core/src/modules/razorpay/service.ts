/**
 * Online payments for a business's invoices through its own Razorpay account:
 *  - connect: check the keys, store them sealed, and set ERPNext up (a "Razorpay Clearing" bank ledger, a
 *    "Razorpay" Mode of Payment, and ERPNext's own Razorpay Settings when that app is installed);
 *  - links: one payment link per invoice and outstanding amount, reused until paid or the amount changes;
 *  - paid: Razorpay's webhook → a submitted Payment Entry against the invoice, a receipt to the customer and a
 *    note to the owner.
 * Razorpay settles to the bank later, net of its fee: that transfer is matched from the bank statement.
 */
import { QUEUES, formatMoney, tenantSettingsSchema, type Currency, type TenantSettings } from '@nextai/shared';
import { ErpError } from '@nextai/erpnext-client';
import type { Prisma, Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { encrypt, randomToken } from '../../lib/crypto.js';
import { badRequest } from '../../lib/errors.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { createLedger } from '../erpnext/create-account.js';
import { erpContext, resolveAccounts } from '../erpnext/mappers.js';
import { sendWhatsApp } from '../outbound/whatsapp.js';
import { localDate } from '../outbound/time.js';
import { RazorpayError, sealRzpSecret, sealRzpWebhook } from './client.js';

export const CLEARING_LEDGER = 'Razorpay Clearing';
export const MODE_OF_PAYMENT = 'Razorpay';

export interface ErpSetup {
  ledger: string;
  modeOfPayment: string | null;
  /** ERPNext's own Razorpay Settings (Frappe "payments" app): updated, or the app isn't installed. */
  razorpaySettings: 'updated' | 'not_installed';
}

/** Razorpay is for Indian rupee businesses. */
export const supportsRazorpay = (tenant: Pick<Tenant, 'currency'>) => tenant.currency === 'INR';

async function saveSettings(c: Container, tenant: Tenant, patch: Partial<TenantSettings>) {
  const current = tenantSettingsSchema.parse(tenant.settings ?? {});
  const merged = { ...(tenant.settings as object), ...current, ...patch };
  return withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: tenant.id }, data: { settings: merged as Prisma.InputJsonValue } }));
}

/** Check the keys, store them sealed, and set ERPNext up. Returns the webhook secret to paste into Razorpay (once). */
export async function connectRazorpay(c: Container, tenant: Tenant, keys: { keyId: string; keySecret: string }) {
  if (!supportsRazorpay(tenant)) throw badRequest('Razorpay payment links are available for businesses billing in Indian rupees.');
  if (!/^rzp_(live|test)_\w+$/.test(keys.keyId)) throw badRequest('The Key ID should look like rzp_live_… or rzp_test_….');
  const sealedSecret = encrypt(keys.keySecret, sealRzpSecret(tenant.id));
  const probe = c.razorpay({ ...tenant, rzpKeyId: keys.keyId, rzpKeySecretEnc: sealedSecret });
  try {
    await probe!.verify();
  } catch (err) {
    if (err instanceof RazorpayError && (err.status === 401 || err.status === 403)) throw badRequest('Razorpay did not accept these keys. Copy them again from Razorpay → Account & Settings → API Keys.');
    throw err;
  }
  const webhookSecret = randomToken(24);
  let updated = await withSystemTx(c.prisma, (tx) =>
    tx.tenant.update({
      where: { id: tenant.id },
      data: { rzpKeyId: keys.keyId, rzpKeySecretEnc: sealedSecret, rzpWebhookSecretEnc: encrypt(webhookSecret, sealRzpWebhook(tenant.id)) },
    }),
  );
  const erp = await setupErpForRazorpay(c, updated, keys);
  updated = await saveSettings(c, updated, { paymentLinks: { enabled: true, account: erp.ledger, modeOfPayment: erp.modeOfPayment ?? undefined } });
  return { tenant: updated, webhookSecret, erp };
}

export async function disconnectRazorpay(c: Container, tenant: Tenant) {
  await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: tenant.id }, data: { rzpKeyId: null, rzpKeySecretEnc: null, rzpWebhookSecretEnc: null } }));
}

/** "Razorpay setup in ERPNext": clearing ledger, Mode of Payment, and Razorpay Settings when present. Safe to repeat. */
export async function setupErpForRazorpay(c: Container, tenant: Tenant, keys?: { keyId: string; keySecret: string }): Promise<ErpSetup> {
  const ctx = erpContext(tenant);
  const erp = c.erp(tenant);
  // Money paid online sits here until Razorpay settles it to the bank (minus its fee).
  const ledger = (await createLedger(c, tenant, { kind: 'bank', name: CLEARING_LEDGER })).name;

  let modeOfPayment: string | null = MODE_OF_PAYMENT;
  try {
    const found = await erp.list<{ name: string }>('Mode of Payment', { filters: [['name', '=', MODE_OF_PAYMENT]], limit: 1 });
    if (!found.length) {
      await erp.create('Mode of Payment', { name: MODE_OF_PAYMENT, mode_of_payment: MODE_OF_PAYMENT, type: 'Bank', enabled: 1, accounts: [{ company: ctx.company, default_account: ledger }] });
    } else {
      const mop = await erp.get<{ accounts?: Array<{ company: string; default_account?: string }> }>('Mode of Payment', MODE_OF_PAYMENT);
      const rows = mop.accounts ?? [];
      if (!rows.some((r) => r.company === ctx.company)) {
        await erp.update('Mode of Payment', MODE_OF_PAYMENT, { accounts: [...rows, { company: ctx.company, default_account: ledger }] });
      }
    }
  } catch (err) {
    logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'mode of payment setup failed');
    modeOfPayment = null; // payments still post, just without a mode of payment
  }

  let razorpaySettings: ErpSetup['razorpaySettings'] = 'not_installed';
  if (keys) {
    try {
      await erp.update('Razorpay Settings', 'Razorpay Settings', { api_key: keys.keyId, api_secret: keys.keySecret });
      razorpaySettings = 'updated';
    } catch (err) {
      if (!(err instanceof ErpError)) throw err; // the "payments" app isn't installed: NextAi handles links itself
    }
  }
  return { ledger, modeOfPayment, razorpaySettings };
}

type Invoice = { name: string; customer: string; outstanding_amount: number; currency?: string };

/**
 * The payment link for an invoice's outstanding amount: reused while unpaid and unchanged, replaced when the
 * amount changed. Undefined when the tenant has no Razorpay, links are off, or nothing is due.
 */
export async function paymentLinkFor(c: Container, tenant: Tenant, inv: Invoice, phone?: string): Promise<string | undefined> {
  const settings = tenantSettingsSchema.parse(tenant.settings ?? {});
  const rzp = c.razorpay(tenant);
  if (!rzp || !settings.paymentLinks.enabled || !supportsRazorpay(tenant) || !(inv.outstanding_amount > 0)) return undefined;
  if ((inv.currency ?? tenant.currency) !== 'INR') return undefined;
  const db = tenantDb(c.prisma, tenant.id);
  const open = await db.paymentLink.findMany({ where: { invoiceName: inv.name, status: 'created' }, orderBy: { createdAt: 'desc' } });
  const same = open.find((l) => Number(l.amount) === inv.outstanding_amount);
  if (same) return same.url;
  for (const old of open) {
    await rzp.cancelLink(old.providerId).catch(() => undefined); // amount changed (part payment, credit note)
    await db.paymentLink.update({ where: { id: old.id }, data: { status: 'cancelled' } });
  }
  const n = await db.paymentLink.count({ where: { invoiceName: inv.name } });
  const link = await rzp.createLink({
    amount: inv.outstanding_amount,
    currency: 'INR',
    referenceId: n ? `${inv.name}-${n + 1}` : inv.name,
    description: `${tenant.name} · Invoice ${inv.name}`,
    customer: { name: inv.customer, contact: phone },
    notes: { tenant: tenant.slug, invoice: inv.name },
  });
  await db.paymentLink.create({
    data: { tenantId: tenant.id, invoiceName: inv.name, customer: inv.customer, amount: inv.outstanding_amount, currency: 'INR', providerId: link.id, url: link.url },
  });
  return link.url;
}

export interface PaidEvent {
  linkId: string;
  paymentId: string;
  amount: number; // rupees
  method?: string;
}

/** Razorpay webhook payload (payment_link.paid) → the fields we use. */
export function parsePaidEvent(body: unknown): PaidEvent | undefined {
  const b = body as {
    event?: string;
    payload?: { payment_link?: { entity?: { id?: string } }; payment?: { entity?: { id?: string; amount?: number; method?: string } } };
  };
  if (b?.event !== 'payment_link.paid') return undefined;
  const link = b.payload?.payment_link?.entity;
  const pay = b.payload?.payment?.entity;
  if (!link?.id || !pay?.id || typeof pay.amount !== 'number') return undefined;
  return { linkId: link.id, paymentId: pay.id, amount: pay.amount / 100, method: pay.method };
}

/** Record an online payment: Payment Entry against the invoice (submitted), receipt to the customer, note to owners. */
export async function recordLinkPayment(c: Container, tenant: Tenant, evt: PaidEvent) {
  const db = tenantDb(c.prisma, tenant.id);
  const link = await db.paymentLink.findUnique({ where: { providerId: evt.linkId } });
  if (!link) return { status: 'unknown_link' as const };
  if (link.erpPaymentEntry) return { status: 'already_recorded' as const, paymentEntry: link.erpPaymentEntry };
  const ctx = erpContext(tenant);
  const erp = c.erp(tenant);
  const day = localDate(ctx.settings.timezone);
  const inv = await erp.get<{ outstanding_amount: number; docstatus: number }>('Sales Invoice', link.invoiceName).catch(() => undefined);
  const allocated = inv && inv.docstatus === 1 ? Math.min(evt.amount, inv.outstanding_amount) : 0;
  const body: Record<string, unknown> = {
    doctype: 'Payment Entry',
    payment_type: 'Receive',
    company: ctx.company,
    posting_date: day,
    party_type: 'Customer',
    party: link.customer,
    mode_of_payment: ctx.settings.paymentLinks.modeOfPayment,
    paid_to: ctx.settings.paymentLinks.account ?? `${CLEARING_LEDGER} - ${ctx.abbr}`,
    paid_amount: evt.amount,
    received_amount: evt.amount,
    reference_no: evt.paymentId,
    reference_date: day,
    remarks: `Paid online via Razorpay (${evt.method ?? 'online'}), payment ${evt.paymentId}, link ${evt.linkId}, invoice ${link.invoiceName}`,
    // Anything above the invoice's outstanding (or an invoice paid meanwhile) stays as an advance from the customer.
    references: allocated > 0 ? [{ reference_doctype: 'Sales Invoice', reference_name: link.invoiceName, allocated_amount: allocated }] : [],
  };
  await resolveAccounts(erp, ctx, body, tenant.id);
  const created = await erp.create<{ name: string }>('Payment Entry', body);
  await erp.submit('Payment Entry', created.name);
  await db.paymentLink.update({ where: { id: link.id }, data: { status: 'paid', paymentId: evt.paymentId, erpPaymentEntry: created.name, paidAt: new Date() } });
  await c.queue.enqueue(QUEUES.outboundReceipt, { tenantId: tenant.id, paymentName: created.name, source: 'razorpay' }, { jobId: `rcpt-${tenant.id}-${created.name}` });

  const amount = formatMoney(evt.amount, tenant.currency as Currency);
  const owners = await db.user.findMany({ where: { role: 'owner', status: 'active', phone: { not: null } } });
  for (const o of owners) {
    await sendWhatsApp(c, tenant, {
      kind: 'notice',
      phone: o.phone!,
      name: o.name,
      templateKey: 'payment_received', // plain text unless such a template is added and approved
      params: [link.customer, amount, link.invoiceName],
      fallbackText: `💰 ${link.customer} paid ${amount} online for invoice ${link.invoiceName}. Recorded in your books (${created.name}).${allocated < evt.amount ? `\n${formatMoney(evt.amount - allocated, tenant.currency as Currency)} more than was due is kept as an advance.` : ''}`,
      ref: `paid-${evt.paymentId}`,
    }).catch((err) => logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'owner payment note failed'));
  }
  return { status: 'recorded' as const, paymentEntry: created.name };
}
