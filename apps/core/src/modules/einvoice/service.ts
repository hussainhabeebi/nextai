import { QUEUES, draftPayloadSchema, tenantSettingsSchema, type EInvoiceScheme } from '@nextai/shared';
import type { EInvoice, Prisma, Tenant } from '@prisma/client';
import { ErpError } from '@nextai/erpnext-client';
import type { Container } from '../../container.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { tenantKey } from '../../storage/storage.js';
import { audit } from '../audit/audit.js';
import { GatewayError } from './gateway.js';
import { buildModel, schemeFor } from './model.js';
import { buildIrp, buildPeppol, buildZatca, validate, type BuiltDocument } from './schemes.js';

type Row = Record<string, unknown>;

export interface SubmitJob {
  tenantId: string;
  invoiceName: string;
  /** Send the invoice to the customer on WhatsApp once registered (or once found not applicable). */
  sendAfter?: boolean;
  draftId?: string;
  force?: boolean;
}

/** IRP allows cancellation only within 24 hours of IRN generation; reason codes per the IRP API. */
export const IRP_CANCEL_REASONS = { duplicate: '1', data_entry_mistake: '2', order_cancelled: '3', other: '4' } as const;
const IRP_CANCEL_WINDOW_MS = 24 * 3600_000;

export function eInvoicingFor(tenant: Tenant) {
  const s = tenantSettingsSchema.parse(tenant.settings ?? {});
  return { settings: s, enabled: s.eInvoicing.enabled, scheme: schemeFor(tenant, s) };
}

/**
 * Called when a Sales Invoice is submitted (bot posting or ERPNext webhook). With e-invoicing on, the
 * customer copy waits for the IRN/QR; otherwise the invoice goes out straight away as before.
 */
export async function onSalesInvoiceSubmitted(c: Container, tenant: Tenant, invoiceName: string, opts: { send: boolean; draftId?: string; source: string }) {
  const { enabled, settings } = eInvoicingFor(tenant);
  if (enabled && settings.eInvoicing.autoSubmit) {
    await c.queue.enqueue(QUEUES.einvoiceSubmit, { tenantId: tenant.id, invoiceName, sendAfter: opts.send, draftId: opts.draftId }, { jobId: `einv-${tenant.id}-${invoiceName}` });
    return 'einvoice';
  }
  if (opts.send) {
    await c.queue.enqueue(QUEUES.outboundInvoice, { tenantId: tenant.id, invoiceName, draftId: opts.draftId, source: opts.source }, { jobId: `inv-${tenant.id}-${invoiceName}` });
  }
  return 'sent';
}

async function releaseInvoice(c: Container, tenant: Tenant, job: SubmitJob) {
  if (job.sendAfter) {
    await c.queue.enqueue(QUEUES.outboundInvoice, { tenantId: tenant.id, invoiceName: job.invoiceName, draftId: job.draftId, source: 'einvoice' }, { jobId: `inv-${tenant.id}-${job.invoiceName}` });
  }
}

async function chainFor(c: Container, tenantId: string, scheme: EInvoiceScheme) {
  const last = await tenantDb(c.prisma, tenantId).eInvoice.findFirst({ where: { scheme, counter: { not: null }, status: { in: ['submitted', 'accepted'] } }, orderBy: { counter: 'desc' } });
  return { counter: (last?.counter ?? 0) + 1, prevHash: last?.docHash ?? undefined };
}

function build(scheme: EInvoiceScheme, model: ReturnType<typeof buildModel>, tenant: Tenant, chain: { counter: number; prevHash?: string }, peppolId?: string): BuiltDocument {
  if (scheme === 'in_irp') return buildIrp(model);
  if (scheme === 'ae_peppol') return buildPeppol(model, tenant.id, peppolId);
  return buildZatca(model, tenant.id, chain);
}

/** einvoice.submit job. Idempotent: an accepted e-invoice is never re-registered. */
export async function submitEInvoice(c: Container, job: SubmitJob): Promise<EInvoice | { skipped: string }> {
  const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: job.tenantId } }));
  const { settings, scheme } = eInvoicingFor(tenant);
  const db = tenantDb(c.prisma, tenant.id);
  const existing = await db.eInvoice.findUnique({ where: { tenantId_invoiceName: { tenantId: tenant.id, invoiceName: job.invoiceName } } });
  if (existing && (existing.status === 'accepted' || existing.status === 'cancelled') && !job.force) return existing;

  const erp = c.erp(tenant);
  const invoice = await erp.get<Row>('Sales Invoice', job.invoiceName);
  if (Number(invoice.docstatus) !== 1) throw conflict(`Sales Invoice ${job.invoiceName} is not submitted`);
  let customer: Row | undefined;
  try {
    if (invoice.customer) customer = await erp.get<Row>('Customer', String(invoice.customer));
  } catch {
    /* customer details optional */
  }
  const draft = await db.draft.findFirst({ where: { erpName: job.invoiceName, type: 'sales_invoice' } });
  const model = buildModel({ tenant, settings, invoice, customer, draft: draft ? draftPayloadSchema.parse(draft.payload) : undefined });

  // India: e-invoicing applies to B2B and exports; B2C invoices carry no IRN.
  if (scheme === 'in_irp' && !model.buyer.taxId && model.buyer.country === 'IN' && !settings.eInvoicing.includeB2C) {
    await releaseInvoice(c, tenant, job);
    return { skipped: 'b2c' };
  }

  const base = { tenantId: tenant.id, scheme, invoiceName: job.invoiceName, total: model.totals.total, taxTotal: model.totals.tax, buyerTaxId: model.buyer.taxId ?? null };
  const issues = validate(scheme, model);
  if (issues.length) {
    const row = await db.eInvoice.upsert({
      where: { tenantId_invoiceName: { tenantId: tenant.id, invoiceName: job.invoiceName } },
      create: { ...base, status: 'invalid', errors: issues as unknown as Prisma.InputJsonValue },
      update: { ...base, status: 'invalid', errors: issues as unknown as Prisma.InputJsonValue },
    });
    await audit(c.prisma, { tenantId: tenant.id, actorType: 'system', channel: 'system', action: 'einvoice.invalid', entity: 'einvoice', entityId: row.id, after: { invoice: job.invoiceName, issues: issues.length } });
    return row; // fix the data and resubmit; the customer copy waits (a non-compliant invoice must not go out)
  }

  const chain = existing?.counter ? { counter: existing.counter, prevHash: existing.prevHash ?? undefined } : await chainFor(c, tenant.id, scheme);
  const doc = build(scheme, model, tenant, chain, settings.eInvoicing.peppolId);
  const key = tenantKey(tenant.id, 'einvoices', `${job.invoiceName.replace(/[^\w.-]/g, '_')}.${doc.format}`);
  await c.storage.put(tenant.id, key, new TextEncoder().encode(doc.body), doc.format === 'json' ? 'application/json' : 'application/xml');
  const pending = await db.eInvoice.upsert({
    where: { tenantId_invoiceName: { tenantId: tenant.id, invoiceName: job.invoiceName } },
    create: { ...base, status: 'pending', irn: doc.id, docHash: doc.hash, prevHash: doc.prevHash ?? null, counter: doc.counter ?? null, r2Key: key, qrPayload: doc.qr ?? null, errors: [] },
    update: { ...base, status: 'pending', irn: doc.id, docHash: doc.hash, prevHash: doc.prevHash ?? null, counter: doc.counter ?? null, r2Key: key, qrPayload: doc.qr ?? null, errors: [], attempts: { increment: 1 } },
  });

  let result;
  try {
    result = await c.einvoice.submit({ scheme, tenantId: tenant.id, invoiceNumber: model.number, sellerTaxId: model.seller.taxId, buyerTaxId: model.buyer.taxId, document: doc });
  } catch (err) {
    const retriable = err instanceof GatewayError ? err.retriable : true;
    await db.eInvoice.update({ where: { id: pending.id }, data: { status: 'failed', errors: [{ field: 'gateway', message: (err as Error).message.slice(0, 300) }] } });
    logger.warn({ tenantId: tenant.id, invoice: job.invoiceName, err: (err as Error).message }, 'e-invoice submission failed');
    if (retriable) throw err; // BullMQ retries; dead-letter after attempts
    return db.eInvoice.findUniqueOrThrow({ where: { id: pending.id } });
  }

  if (result.status === 'rejected') {
    const row = await db.eInvoice.update({ where: { id: pending.id }, data: { status: 'rejected', errors: (result.errors ?? []) as unknown as Prisma.InputJsonValue, submittedAt: new Date() } });
    await audit(c.prisma, { tenantId: tenant.id, actorType: 'system', channel: 'system', action: 'einvoice.rejected', entity: 'einvoice', entityId: row.id, after: { invoice: job.invoiceName, errors: result.errors } });
    return row;
  }

  const row = await db.eInvoice.update({
    where: { id: pending.id },
    data: { status: 'accepted', irn: result.irn ?? doc.id, ackNo: result.ackNo ?? null, ackDate: result.ackDate ? new Date(result.ackDate) : new Date(), qrPayload: result.qr ?? doc.qr ?? null, submittedAt: new Date(), errors: [] },
  });
  await audit(c.prisma, { tenantId: tenant.id, actorType: 'system', channel: 'system', action: 'einvoice.accepted', entity: 'einvoice', entityId: row.id, after: { invoice: job.invoiceName, scheme, irn: row.irn, ackNo: row.ackNo, gateway: c.einvoice.name } });

  // Write the IRN / QR back so the ERPNext print format shows it (India Compliance fields; best effort).
  if (scheme === 'in_irp') {
    try {
      await erp.update('Sales Invoice', job.invoiceName, { irn: row.irn, ack_no: row.ackNo, ack_date: row.ackDate?.toISOString().replace('T', ' ').slice(0, 19), signed_qr_code: row.qrPayload, einvoice_status: 'Generated' });
    } catch (err) {
      logger.warn({ tenantId: tenant.id, invoice: job.invoiceName, err: err instanceof ErpError ? err.userMessage : (err as Error).message }, 'could not write IRN back to ERPNext');
    }
  }
  await releaseInvoice(c, tenant, job);
  return row;
}

export async function cancelEInvoice(c: Container, tenant: Tenant, id: string, reason: keyof typeof IRP_CANCEL_REASONS, remark: string | undefined, actor: { id: string; ip?: string }) {
  const db = tenantDb(c.prisma, tenant.id);
  const e = await db.eInvoice.findUnique({ where: { id } });
  if (!e) throw notFound('E-invoice');
  if (e.status !== 'accepted') throw conflict(`Only registered e-invoices can be cancelled (this one is ${e.status})`);
  if (e.scheme !== 'in_irp') throw badRequest('Registered UAE/KSA e-invoices cannot be cancelled. Issue a credit note instead.');
  if (!e.ackDate || Date.now() - e.ackDate.getTime() > IRP_CANCEL_WINDOW_MS) throw badRequest('The IRP allows cancellation only within 24 hours. Issue a credit note instead.');
  const r = await c.einvoice.cancel({ scheme: 'in_irp', tenantId: tenant.id, id: e.irn!, reason: IRP_CANCEL_REASONS[reason], remark });
  if (!r.ok) throw badRequest(r.errors?.map((x) => x.message).join('; ') ?? 'Cancellation was rejected');
  const row = await db.eInvoice.update({ where: { id }, data: { status: 'cancelled', cancelledAt: new Date() } });
  await audit(c.prisma, { tenantId: tenant.id, actorId: actor.id, actorType: 'user', channel: 'app', action: 'einvoice.cancel', entity: 'einvoice', entityId: id, before: { status: e.status }, after: { status: 'cancelled', reason, remark }, ip: actor.ip });
  return row;
}

/** Live position of statutory reporting, for the tax centre. */
export async function eInvoiceSummary(c: Container, tenant: Tenant) {
  const { enabled, scheme } = eInvoicingFor(tenant);
  const rows = await tenantDb(c.prisma, tenant.id).eInvoice.groupBy({ by: ['status'], _count: { _all: true }, _sum: { total: true, taxTotal: true } });
  const counts = Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<string, number>;
  const accepted = rows.find((r) => r.status === 'accepted');
  return {
    enabled,
    scheme,
    gateway: c.einvoice.name,
    counts,
    needsAction: (counts.invalid ?? 0) + (counts.rejected ?? 0) + (counts.failed ?? 0),
    reported: { invoices: counts.accepted ?? 0, value: accepted?._sum.total ?? 0, tax: accepted?._sum.taxTotal ?? 0 },
  };
}
