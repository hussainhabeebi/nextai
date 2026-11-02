import { ErpError } from '@nextai/erpnext-client';
import { QUEUES, draftPayloadSchema, formatMoney, t, type Currency, type DraftPayload, type DraftType, type Language } from '@nextai/shared';
import type { ActorType, Channel, Draft, Prisma, Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import { conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../audit/audit.js';
import { DOCTYPE_FOR, erpContext, partyDoc, toErpDoc } from '../erpnext/mappers.js';

export interface Actor {
  id?: string | null;
  type: ActorType;
  channel: Channel;
  ip?: string;
}

export const CHOICES = [
  { title: 'Confirm', value: 'confirm' },
  { title: 'Edit', value: 'edit' },
  { title: 'Cancel', value: 'cancel' },
];

const TYPE_LABEL: Record<DraftType, string> = {
  purchase_invoice: '🧾 Purchase bill',
  journal_entry: '💸 Expense',
  sales_invoice: '🧾 Sales invoice',
  payment_in: '💰 Payment received',
  payment_out: '💸 Payment made',
};

export function summaryText(draft: Pick<Draft, 'type' | 'payload'>, lang: Language): string {
  const p = draft.payload as DraftPayload;
  const party = p.partyName ? `${draft.type === 'sales_invoice' || draft.type === 'payment_in' ? 'Customer' : 'Supplier'}: ${p.partyName}` : (p.remarks ?? '');
  const extra = [
    p.billNo ? `Bill no: ${p.billNo}` : undefined,
    p.lines.length > 1 ? `${p.lines.length} items` : p.lines[0]?.description,
    p.taxes && Object.values(p.taxes).some((v) => (v ?? 0) > 0)
      ? `Tax: ${Object.entries(p.taxes).filter(([, v]) => (v ?? 0) > 0).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(', ')}`
      : undefined,
    p.validationIssues.length ? `⚠️ ${p.validationIssues.join('; ')}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    t(lang, 'bot.draftSummary', {
      type: TYPE_LABEL[draft.type],
      party: [party, extra].filter(Boolean).join('\n'),
      date: p.date,
      total: formatMoney(p.total, p.currency as Currency),
    })
  );
}

export interface CreateDraftInput {
  userId?: string;
  type: DraftType;
  payload: DraftPayload;
  documentId?: string;
  conversationId?: number;
  confidence?: number;
  needsReview?: boolean;
  actor: Actor;
}

/** Create a draft and drive the conversation: review handover, auto-post, or confirm card. */
export async function createDraft(c: Container, tenant: Tenant, input: CreateDraftInput): Promise<Draft> {
  const payload = draftPayloadSchema.parse(input.payload);
  const db = tenantDb(c.prisma, tenant.id);
  const draft = await db.draft.create({
    data: {
      tenantId: tenant.id,
      userId: input.userId,
      documentId: input.documentId,
      conversationId: input.conversationId,
      type: input.type,
      payload: payload as Prisma.InputJsonValue,
      confidence: input.confidence,
      status: input.needsReview ? 'needs_review' : 'pending',
    },
  });
  await audit(c.prisma, { tenantId: tenant.id, actorId: input.actor.id, actorType: input.actor.type, channel: input.actor.channel, action: 'draft.create', entity: 'draft', entityId: draft.id, after: { type: draft.type, status: draft.status, total: payload.total } });

  const lang = (tenant.language as Language) ?? 'en';
  if (input.conversationId) {
    const cw = c.chatwoot(tenant);
    if (draft.status === 'needs_review') {
      await cw.addLabels(input.conversationId, ['needs-review']);
      await cw.toggleStatus(input.conversationId, 'open'); // hand over to a human
      await cw.sendText(input.conversationId, t(lang, 'bot.needsReview'));
    } else if (erpContext(tenant).settings.autoPost) {
      await confirmDraft(c, tenant, draft.id, input.actor);
    } else {
      await cw.sendChoices(input.conversationId, summaryText(draft, lang), CHOICES);
      await c.conversations.set(tenant.id, input.conversationId, { step: 'awaiting_confirm', draftId: draft.id });
    }
  }
  return draft;
}

export async function getDraft(c: Container, tenantId: string, id: string): Promise<Draft> {
  const d = await tenantDb(c.prisma, tenantId).draft.findUnique({ where: { id } });
  if (!d) throw notFound('Draft');
  return d;
}

/** pending|needs_review → confirmed, then enqueue draft.post. Idempotent claim. */
export async function confirmDraft(c: Container, tenant: Tenant, draftId: string, actor: Actor): Promise<Draft> {
  const db = tenantDb(c.prisma, tenant.id);
  const before = await getDraft(c, tenant.id, draftId);
  const claimed = await db.draft.updateMany({
    where: { id: draftId, status: { in: ['pending', 'needs_review'] } },
    data: { status: 'confirmed', reviewedBy: actor.type === 'admin' ? actor.id : undefined },
  });
  if (claimed.count === 0) throw conflict(`Draft is ${before.status}`);
  await audit(c.prisma, { tenantId: tenant.id, actorId: actor.id, actorType: actor.type, channel: actor.channel, action: 'draft.confirm', entity: 'draft', entityId: draftId, before: { status: before.status }, after: { status: 'confirmed' }, ip: actor.ip });
  await c.queue.enqueue(QUEUES.draftPost, { tenantId: tenant.id, draftId }, { jobId: `post-${draftId}` });
  return getDraft(c, tenant.id, draftId);
}

export async function cancelDraft(c: Container, tenant: Tenant, draftId: string, actor: Actor): Promise<Draft> {
  const db = tenantDb(c.prisma, tenant.id);
  const before = await getDraft(c, tenant.id, draftId);
  const res = await db.draft.updateMany({ where: { id: draftId, status: { in: ['pending', 'needs_review', 'failed'] } }, data: { status: 'cancelled' } });
  if (res.count === 0) throw conflict(`Draft is ${before.status}`);
  await audit(c.prisma, { tenantId: tenant.id, actorId: actor.id, actorType: actor.type, channel: actor.channel, action: 'draft.cancel', entity: 'draft', entityId: draftId, before: { status: before.status }, after: { status: 'cancelled' }, ip: actor.ip });
  return getDraft(c, tenant.id, draftId);
}

/** Edit an unposted draft (app, bot or reviewer). */
export async function updateDraftPayload(c: Container, tenant: Tenant, draftId: string, patch: Partial<DraftPayload>, actor: Actor): Promise<Draft> {
  const before = await getDraft(c, tenant.id, draftId);
  if (!['pending', 'needs_review', 'failed'].includes(before.status)) throw conflict(`Draft is ${before.status}`);
  const merged = draftPayloadSchema.parse({ ...(before.payload as object), ...patch, validationIssues: [] });
  const db = tenantDb(c.prisma, tenant.id);
  const after = await db.draft.update({ where: { id: draftId }, data: { payload: merged as Prisma.InputJsonValue, error: null } });
  await audit(c.prisma, { tenantId: tenant.id, actorId: actor.id, actorType: actor.type, channel: actor.channel, action: 'draft.edit', entity: 'draft', entityId: draftId, before: before.payload, after: merged, ip: actor.ip });
  return after;
}

/** Parse WhatsApp edit commands: "amount 1200", "supplier ABC", "date 2026-11-01", "bill no 55", "account Rent". */
export function parseEdit(text: string): Partial<DraftPayload> | undefined {
  const s = text.trim();
  const m = s.match(/^(amount|total|supplier|customer|party|vendor|date|bill ?no|invoice ?no|account|note|remarks|mode|paid by)\s*[:=]?\s+(.+)$/i);
  if (!m) return undefined;
  const key = m[1]!.toLowerCase().replace(/\s/g, '');
  const val = m[2]!.trim();
  switch (key) {
    case 'amount':
    case 'total': {
      const n = Number(val.replace(/[^\d.]/g, ''));
      return Number.isFinite(n) && n > 0 ? { total: n, lines: [] } : undefined;
    }
    case 'supplier':
    case 'customer':
    case 'party':
    case 'vendor':
      return { partyName: val };
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(val) ? { date: val } : undefined;
    case 'billno':
    case 'invoiceno':
      return { billNo: val };
    case 'account':
      return { expenseAccount: val };
    case 'mode':
    case 'paidby':
      return { paymentMode: val.toLowerCase() };
    default:
      return { remarks: val };
  }
}

async function ensureParty(c: Container, tenant: Tenant, kind: 'Customer' | 'Supplier', p: DraftPayload): Promise<void> {
  if (!p.partyName) throw new ErpError('missing party', 400, 'MandatoryError', 'Please tell me the supplier/customer name.', false);
  const erp = c.erp(tenant);
  const found = await erp.list(kind, { filters: [['name', '=', p.partyName]], limit: 1 });
  if (found.length === 0) {
    // Draft was confirmed by the user → creating the party is authorised.
    await erp.create(kind, partyDoc(kind, p.partyName, { taxId: p.partyTaxId, phone: p.partyPhone, country: tenant.country }));
  }
}

/** Worker handler for draft.post. Safe to retry: resumes from erpName if already created. */
export async function postDraft(c: Container, tenantId: string, draftId: string): Promise<Draft> {
  const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
  const db = tenantDb(c.prisma, tenantId);
  const claimed = await db.draft.updateMany({ where: { id: draftId, status: { in: ['confirmed', 'failed'] } }, data: { status: 'posting' } });
  const draft = await getDraft(c, tenantId, draftId);
  if (claimed.count === 0) {
    if (draft.status === 'posted') return draft;
    throw conflict(`Draft ${draftId} is ${draft.status}`);
  }
  const p = draftPayloadSchema.parse(draft.payload);
  const ctx = erpContext(tenant);
  const erp = c.erp(tenant);
  const doctype = DOCTYPE_FOR[draft.type];
  const lang = (tenant.language as Language) ?? 'en';
  try {
    if (draft.type === 'purchase_invoice' || draft.type === 'payment_out') await ensureParty(c, tenant, 'Supplier', p);
    if (draft.type === 'sales_invoice' || draft.type === 'payment_in') await ensureParty(c, tenant, 'Customer', p);

    let erpName = draft.erpName;
    if (!erpName) {
      const created = await erp.create(doctype, toErpDoc(draft.type, p, ctx));
      erpName = created.name as string;
      await db.draft.update({ where: { id: draftId }, data: { erpDoctype: doctype, erpName } });
    }
    const current = await erp.get(doctype, erpName);
    if (current.docstatus !== 1) await erp.submit(doctype, erpName);

    if (draft.documentId) {
      const doc = await db.document.findUnique({ where: { id: draft.documentId } });
      if (doc) {
        const obj = await c.storage.get(tenantId, doc.r2Key);
        await erp.uploadFile({ filename: doc.r2Key.split('/').pop()!, content: obj.body, mime: doc.mime }, { doctype, name: erpName }, true);
      }
    }
    const posted = await db.draft.update({ where: { id: draftId }, data: { status: 'posted', error: null } });
    await audit(c.prisma, { tenantId, actorType: 'system', channel: 'system', action: 'draft.posted', entity: 'draft', entityId: draftId, after: { erpDoctype: doctype, erpName, total: p.total } });

    if ((draft.type === 'purchase_invoice' || draft.type === 'journal_entry') && p.partyName && p.expenseAccount) {
      await learnVendor(c, tenantId, p.partyName, p.partyTaxId, p.expenseAccount, p.taxTemplate);
    }
    if (draft.type === 'sales_invoice' && ctx.settings.autoSendInvoices) {
      await c.queue.enqueue(QUEUES.outboundInvoice, { tenantId, invoiceName: erpName, draftId, source: 'nextai' }, { jobId: `inv-${tenantId}-${erpName}` });
    }
    if (draft.conversationId) {
      await c.chatwoot(tenant).sendText(draft.conversationId, t(lang, 'bot.confirmed', { ref: erpName }));
      await c.conversations.clear(tenantId, draft.conversationId);
    }
    return posted;
  } catch (err) {
    const userMessage = err instanceof ErpError ? err.userMessage : t(lang, 'bot.error');
    const retriable = err instanceof ErpError ? err.retriable : true;
    await db.draft.update({ where: { id: draftId }, data: { status: retriable ? 'failed' : 'needs_review', error: userMessage } });
    logger.warn({ tenantId, draftId, err: (err as Error).message }, 'draft post failed');
    if (!retriable && draft.conversationId) {
      const cw = c.chatwoot(tenant);
      await cw.sendText(draft.conversationId, `${userMessage}\n${t(lang, 'bot.needsReview')}`);
      await cw.addLabels(draft.conversationId, ['needs-review']);
    }
    if (retriable) throw err; // BullMQ retries with backoff; dead-letter after attempts
    return getDraft(c, tenantId, draftId);
  }
}

/**
 * Correct a posted document: never delete — cancel in ERPNext and create an amendment.
 */
export async function amendPostedDraft(c: Container, tenant: Tenant, draftId: string, patch: Partial<DraftPayload>, actor: Actor): Promise<Draft> {
  const draft = await getDraft(c, tenant.id, draftId);
  if (draft.status !== 'posted' || !draft.erpName || !draft.erpDoctype) throw conflict('Only posted drafts can be amended');
  const erp = c.erp(tenant);
  await erp.cancel(draft.erpDoctype, draft.erpName);
  const payload = draftPayloadSchema.parse({ ...(draft.payload as object), ...patch });
  const body = { ...toErpDoc(draft.type, payload, erpContext(tenant)), amended_from: draft.erpName };
  const created = await erp.create(draft.erpDoctype, body);
  await erp.submit(draft.erpDoctype, created.name as string);
  const db = tenantDb(c.prisma, tenant.id);
  const updated = await db.draft.update({ where: { id: draftId }, data: { payload: payload as Prisma.InputJsonValue, erpName: created.name as string } });
  await audit(c.prisma, { tenantId: tenant.id, actorId: actor.id, actorType: actor.type, channel: actor.channel, action: 'draft.amend', entity: 'draft', entityId: draftId, before: { erpName: draft.erpName, payload: draft.payload }, after: { erpName: created.name, payload } });
  return updated;
}

export async function learnVendor(c: Container, tenantId: string, supplierName: string, taxId: string | undefined, expenseAccount: string, taxTemplate?: string) {
  const db = tenantDb(c.prisma, tenantId);
  await db.vendorMapping.upsert({
    where: { tenantId_supplierName: { tenantId, supplierName } },
    update: { expenseAccount, taxTemplate, taxId, hits: { increment: 1 } },
    create: { tenantId, supplierName, taxId, expenseAccount, taxTemplate, hits: 1 },
  });
}
