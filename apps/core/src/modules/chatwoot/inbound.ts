import type { ChatwootWebhook } from '@nextai/chatwoot-client';
import { markCustomerWindow } from './diagnostics.js';
import { QUEUES, normalizePhone, t, type Language } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import { env } from '../../config/env.js';
import type { Container } from '../../container.js';
import { sha256 } from '../../lib/crypto.js';
import { tenantDb } from '../../lib/db.js';
import { tenantKey } from '../../storage/storage.js';
import { handleText } from '../intents/flow.js';
import { handleCustomerReply } from '../lifecycle/replies.js';
import { incrementUsage } from '../usage/usage.js';
import { planLimits, usageFor } from '../billing/gating.js';
import type { BotContext } from './context.js';

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
};

export type InboundOutcome = 'customer_reply' | 'ignored_unknown_user' | 'billing_blocked' | 'attachments_queued' | 'text_handled' | 'empty';

/** Handle one verified, de-duplicated, incoming WhatsApp message for a resolved tenant. */
export async function handleIncoming(c: Container, tenant: Tenant, evt: ChatwootWebhook): Promise<InboundOutcome> {
  const conversationId = evt.conversation!.id;
  const cw = c.chatwoot(tenant);
  const lang = (tenant.language as Language) ?? 'en';
  const rawPhone = evt.sender?.phone_number ?? evt.conversation?.contact_inbox?.source_id;
  const phone = rawPhone ? normalizePhone(rawPhone, tenant.country) : undefined;
  if (phone) await markCustomerWindow(c.redis, tenant.id, phone); // free-text replies allowed for 24h
  const db = tenantDb(c.prisma, tenant.id);
  const user = phone ? await db.user.findFirst({ where: { tenantId: tenant.id, phone, status: { not: 'disabled' } } }) : null;

  if (!user) {
    // Customers of a tenant running the lifecycle playbook (data, monthly updates, support, feedback).
    if (phone && (await handleCustomerReply(c, tenant, evt, phone))) return 'customer_reply';
    // Unknown numbers on a tenant inbox: polite onboarding message once per conversation, then ignore.
    const state = await c.conversations.get(tenant.id, conversationId);
    if (state.step !== 'handover') {
      await cw.sendText(conversationId, t(lang, 'bot.unknownNumber', { url: env().APP_URL }));
      await c.conversations.set(tenant.id, conversationId, { step: 'handover' });
    }
    return 'ignored_unknown_user';
  }

  await incrementUsage(c.prisma, tenant.id, { messages: 1 });
  const ulang = (user.language as Language) ?? lang;

  if (tenant.status === 'suspended') {
    await cw.sendText(conversationId, t(ulang, 'billing.suspended', { link: `${env().APP_URL}/billing` }));
    return 'billing_blocked';
  }

  // Plan gating: monthly message cap, and OCR page cap for documents.
  const limits = await planLimits(c, tenant);
  const upgrade = `${env().APP_URL}/billing`;
  if ((await usageFor(c, tenant, 'messagesPerMonth')) > limits.messagesPerMonth) {
    await cw.sendText(conversationId, t(ulang, 'bot.planLimit', { what: 'messages', link: upgrade }));
    return 'billing_blocked';
  }
  const hasDocs = (evt.attachments ?? []).some((a) => a.file_type !== 'audio');
  if (hasDocs && (await usageFor(c, tenant, 'ocrPagesPerMonth')) >= limits.ocrPagesPerMonth) {
    await cw.sendText(conversationId, t(ulang, 'bot.planLimit', { what: 'bill entries', link: upgrade }));
    return 'billing_blocked';
  }

  const ctx: BotContext = { c, tenant, user, conversationId, lang: ulang };
  const attachments = evt.attachments ?? [];
  if (attachments.length > 0) {
    let statements = 0;
    for (const a of attachments) {
      const file = await cw.downloadAttachment(a.data_url);
      const isAudio = a.file_type === 'audio' || file.mime.startsWith('audio/');
      // A bank statement: CSV, or a PDF/photo the caption or file name calls a statement.
      const fileName = decodeURIComponent(a.data_url.split('?')[0]!.split('/').pop() ?? '');
      const isCsv = /csv|comma-separated/i.test(file.mime) || /\.csv$/i.test(fileName) || a.extension === 'csv';
      if (!isAudio && (isCsv || (/pdf|image\//.test(file.mime) && /statement|stmt|bank/i.test(`${evt.content ?? ''} ${fileName}`)))) {
        const mime = isCsv ? 'text/csv' : file.mime;
        const key = tenantKey(tenant.id, 'statements', new Date().toISOString().slice(0, 7), `${sha256(file.content)}.${EXT[mime] ?? 'bin'}`);
        await c.storage.put(tenant.id, key, file.content, mime);
        await c.queue.enqueue(QUEUES.bankStatement, { tenantId: tenant.id, r2Key: key, mime, name: fileName, conversationId, userId: user.id });
        await cw.sendText(conversationId, 'Got your bank statement 👍 Matching it with your books…');
        statements++;
        continue;
      }
      const hash = sha256(file.content);
      const key = tenantKey(tenant.id, isAudio ? 'voice' : 'docs', new Date().toISOString().slice(0, 7), `${hash}.${EXT[file.mime] ?? 'bin'}`);
      if (isAudio) {
        await c.storage.put(tenant.id, key, file.content, file.mime);
        await c.queue.enqueue(QUEUES.voice, { tenantId: tenant.id, r2Key: key, mime: file.mime, conversationId, userId: user.id });
        continue;
      }
      const existing = await db.document.findUnique({ where: { tenantId_sha256: { tenantId: tenant.id, sha256: hash } }, include: { drafts: true } });
      if (existing) {
        const ref = existing.drafts.find((d) => d.erpName)?.erpName ?? existing.id.slice(0, 8);
        await cw.sendText(conversationId, t(ulang, 'bot.duplicate', { ref }));
        continue;
      }
      await c.storage.put(tenant.id, key, file.content, file.mime);
      const doc = await db.document.create({
        data: { tenantId: tenant.id, r2Key: key, sha256: hash, mime: file.mime, source: 'whatsapp', uploadedBy: user.id },
      });
      await c.queue.enqueue(QUEUES.ocr, { tenantId: tenant.id, documentId: doc.id, conversationId, userId: user.id }, { jobId: `ocr-${doc.id}` });
      await cw.sendText(conversationId, t(ulang, 'bot.received'));
    }
    // A caption is an instruction for a bill ("paid by card"); for a statement it just names the file.
    if (evt.content?.trim() && statements < attachments.length) await handleText(ctx, evt.content);
    return 'attachments_queued';
  }

  if (!evt.content?.trim()) return 'empty';
  await handleText(ctx, evt.content);
  return 'text_handled';
}
