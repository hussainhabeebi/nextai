import { inflateSync } from 'node:zlib';
import {
  REVIEW_CONFIDENCE_THRESHOLD,
  SMALL_EXPENSE_THRESHOLD,
  round2,
  type Currency,
  type DraftPayload,
  type DraftType,
  type Extraction,
} from '@nextai/shared';
import type { Prisma, Tenant } from '@prisma/client';
import { t, type Language } from '@nextai/shared';
import { logger } from '../../lib/logger.js';
import type { Container } from '../../container.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import { createDraft } from '../drafts/service.js';
import { erpContext, purchaseTaxTemplate } from '../erpnext/mappers.js';
import { chooseExpenseAccount } from '../erpnext/expense-account.js';
import { incrementUsage } from '../usage/usage.js';
import { bestMatch } from './match.js';
import { validateExtraction } from './validate.js';

export interface OcrJob {
  tenantId: string;
  documentId: string;
  conversationId?: number;
  userId?: string;
}

/** Cheap PDF preparation: page count + embedded text from Flate/plain content streams (no external deps). */
export function preparePdf(bytes: Uint8Array): { pages: number; text: string } {
  const buf = Buffer.from(bytes);
  const raw = buf.toString('latin1');
  const pages = Math.max(1, (raw.match(/\/Type\s*\/Page(?!s)/g) ?? []).length);
  const chunks: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) && chunks.join('').length < 50_000) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const slice = buf.subarray(start, end);
    let content: string;
    try {
      content = inflateSync(slice).toString('latin1');
    } catch {
      content = slice.toString('latin1');
    }
    const texts = [...content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:[^\]])*)\]\s*TJ/g)].map((x) =>
      (x[1] ?? (x[2] ?? '').replace(/\(((?:\\.|[^\\)])*)\)|-?\d+(\.\d+)?/g, (_s, s1: string | undefined) => s1 ?? '')).replace(/\\(.)/g, '$1'),
    );
    if (texts.length) chunks.push(texts.join(' '));
  }
  return { pages, text: chunks.join('\n').trim() };
}

/** File types the vision model accepts. */
export const READABLE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'] as const;

/**
 * The real type from the file's first bytes. Chatwoot/WhatsApp often label photos `image/jpg` or
 * `application/octet-stream`, which the vision API rejects. Returns undefined for unreadable types (e.g. HEIC).
 */
export function sniffMime(bytes: Uint8Array, declared = ''): string | undefined {
  const b = Buffer.from(bytes.subarray(0, 16));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  const normal = declared === 'image/jpg' || declared === 'image/pjpeg' ? 'image/jpeg' : declared;
  return (READABLE_MIME as readonly string[]).includes(normal) ? normal : undefined;
}

/** Errors worth retrying (rate limits, overload, network); anything else will fail the same way again. */
function isTransient(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (typeof status === 'number') return status === 408 || status === 409 || status === 429 || status >= 500;
  return /connection|timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test((err as Error).message ?? '');
}

export function decideDraftType(x: Extraction, currency: Currency): DraftType {
  if (x.docType === 'sales_invoice') return 'sales_invoice';
  const total = x.total ?? 0;
  const smallCash =
    total > 0 &&
    total < SMALL_EXPENSE_THRESHOLD[currency] &&
    ['cash', 'upi', 'card'].includes(x.paymentMode) &&
    !x.supplierTaxId;
  return smallCash || x.docType === 'receipt' && !x.supplierName ? 'journal_entry' : 'purchase_invoice';
}

/** ocr.process: storage → dedupe already done at ingest → prepare → extract → validate → match → Draft. */
export async function processOcr(c: Container, job: OcrJob) {
  const tenant: Tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: job.tenantId } }));
  const db = tenantDb(c.prisma, tenant.id);
  const doc = await db.document.findUniqueOrThrow({ where: { id: job.documentId } });
  const existing = await db.draft.findFirst({ where: { documentId: doc.id } });
  if (existing) return existing; // idempotent on retry

  const file = await c.storage.get(tenant.id, doc.r2Key);
  const mime = sniffMime(file.body, doc.mime);
  if (!mime) {
    // e.g. iPhone HEIC sent as a document: ask for a readable format instead of failing silently.
    if (job.conversationId) await c.chatwoot(tenant).sendText(job.conversationId, t((tenant.language as Language) ?? 'en', 'bot.unsupportedFile'));
    logger.warn({ tenantId: tenant.id, documentId: doc.id, mime: doc.mime }, 'unreadable document type');
    return undefined;
  }
  if (mime !== doc.mime) await db.document.update({ where: { id: doc.id }, data: { mime } });
  const prepared = mime === 'application/pdf' ? preparePdf(file.body) : { pages: 1, text: '' };
  const ctx = erpContext(tenant);
  const currency = tenant.currency as Currency;
  let x: Extraction;
  let usage = { tokens: 0, costMicros: 0 };
  let unreadable: string | undefined;
  try {
    ({ extraction: x, usage } = await c.ai.vision.extract({ content: file.body, mime, pdfText: prepared.text || undefined, country: tenant.country, currency }));
  } catch (err) {
    if (isTransient(err)) throw err; // BullMQ retries with backoff
    // Unreadable (blurry, refused, bad output): never drop the bill – a human enters it from the review queue.
    unreadable = (err as Error).message.slice(0, 200);
    logger.warn({ tenantId: tenant.id, documentId: doc.id, err: unreadable }, 'vision extraction failed; sending to review');
    x = {
      docType: 'other', supplierName: null, supplierTaxId: null, invoiceNo: null, date: null, currency, lines: [], subtotal: null,
      tax: { cgst: 0, sgst: 0, igst: 0, vat: 0 }, total: null, paymentMode: 'unknown', confidence: 0,
    };
  }
  await incrementUsage(c.prisma, tenant.id, { ocrPages: prepared.pages, aiTokens: usage.tokens, aiCostMicros: usage.costMicros });
  await db.document.update({
    where: { id: doc.id },
    data: { extracted: x as unknown as Prisma.InputJsonValue, confidence: x.confidence, pages: prepared.pages },
  });

  const v = validateExtraction(x, tenant.country);
  const type = decideDraftType(x, currency);

  // Match supplier against learned mappings first, then ERPNext parties.
  let partyName = x.supplierName ?? undefined;
  let expenseAccount: string | undefined;
  let taxTemplate: string | undefined;
  if (partyName && type !== 'sales_invoice') {
    const mappings = await db.vendorMapping.findMany({ where: { tenantId: tenant.id }, orderBy: { hits: 'desc' }, take: 500 });
    const byTax = x.supplierTaxId ? mappings.find((m) => m.taxId && m.taxId.toUpperCase() === x.supplierTaxId!.toUpperCase()) : undefined;
    const mapHit = byTax ?? mappings.find((m) => m.supplierName === bestMatch(partyName!, mappings.map((mm) => mm.supplierName))?.name);
    if (mapHit) {
      partyName = mapHit.supplierName;
      expenseAccount = mapHit.expenseAccount;
      taxTemplate = mapHit.taxTemplate ?? undefined;
    } else {
      try {
        const suppliers = await c.erp(tenant).list<{ name: string }>('Supplier', { fields: ['name'], limit: 500 });
        const hit = bestMatch(partyName, suppliers.map((s) => s.name));
        if (hit) partyName = hit.name;
      } catch {
        /* ERPNext unavailable: keep extracted name; posting will retry */
      }
    }
  }
  const taxes = { cgst: x.tax.cgst, sgst: x.tax.sgst, igst: x.tax.igst, vat: x.tax.vat };
  expenseAccount ??= await chooseExpenseAccount(c, tenant, [partyName, ...x.lines.map((l) => l.description)].filter(Boolean).join(' – '));
  taxTemplate ??= purchaseTaxTemplate(ctx, taxes);

  // Duplicate: same supplier + invoice no + amount already drafted (and not cancelled).
  const issues = [...v.issues, ...(unreadable ? ['Could not be read automatically – please enter it from the image'] : [])];
  let duplicate = false;
  if (partyName && x.invoiceNo && x.total) {
    const candidates = await db.draft.findMany({ where: { tenantId: tenant.id, status: { notIn: ['cancelled'] }, type }, take: 200, orderBy: { createdAt: 'desc' } });
    duplicate = candidates.some((d) => {
      const p = d.payload as DraftPayload;
      return p.partyName === partyName && p.billNo === x.invoiceNo && round2(p.total) === round2(x.total!);
    });
    if (duplicate) issues.push(`Possible duplicate of an earlier bill ${x.invoiceNo}`);
  }

  const payload: DraftPayload = {
    partyName,
    partyTaxId: x.supplierTaxId ?? undefined,
    billNo: x.invoiceNo ?? undefined,
    date: x.date ?? new Date().toISOString().slice(0, 10),
    currency: x.currency ?? currency,
    lines: x.lines.map((l) => ({ description: l.description, qty: l.qty || 1, rate: l.rate, amount: l.amount, account: undefined })),
    taxes,
    taxTemplate: type === 'journal_entry' ? undefined : taxTemplate,
    total: x.total ?? 0,
    paymentMode: x.paymentMode,
    expenseAccount,
    documentId: doc.id,
    remarks: type === 'journal_entry' ? [partyName, x.lines[0]?.description].filter(Boolean).join(' – ') || undefined : undefined,
    validationIssues: issues,
  };
  const needsReview = x.confidence < REVIEW_CONFIDENCE_THRESHOLD || v.hard || duplicate || !x.total;
  return createDraft(c, tenant, {
    userId: job.userId,
    type,
    payload,
    documentId: doc.id,
    conversationId: job.conversationId,
    confidence: x.confidence,
    needsReview,
    actor: { type: 'bot', channel: job.conversationId ? 'whatsapp' : 'app' },
  });
}
