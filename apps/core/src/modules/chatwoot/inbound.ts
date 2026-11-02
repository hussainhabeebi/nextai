import type { ChatwootWebhook } from '@nextai/chatwoot-client';
import { QUEUES, normalizePhone, t, type Language } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import { env } from '../../config/env.js';
import type { Container } from '../../container.js';
import { sha256 } from '../../lib/crypto.js';
import { tenantDb } from '../../lib/db.js';
import { tenantKey } from '../../storage/storage.js';
import { handleText } from '../intents/flow.js';
import { incrementUsage } from '../usage/usage.js';
import type { BotContext } from './context.js';

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
};

export type InboundOutcome = 'ignored_unknown_user' | 'billing_blocked' | 'attachments_queued' | 'text_handled' | 'empty';

/** Handle one verified, de-duplicated, incoming WhatsApp message for a resolved tenant. */
export async function handleIncoming(c: Container, tenant: Tenant, evt: ChatwootWebhook): Promise<InboundOutcome> {
  const conversationId = evt.conversation!.id;
  const cw = c.chatwoot(tenant);
  const lang = (tenant.language as Language) ?? 'en';
  const rawPhone = evt.sender?.phone_number ?? evt.conversation?.contact_inbox?.source_id;
  const phone = rawPhone ? normalizePhone(rawPhone, tenant.country) : undefined;
  const db = tenantDb(c.prisma, tenant.id);
  const user = phone ? await db.user.findFirst({ where: { tenantId: tenant.id, phone, status: { not: 'disabled' } } }) : null;

  if (!user) {
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

  const ctx: BotContext = { c, tenant, user, conversationId, lang: ulang };
  const attachments = evt.attachments ?? [];
  if (attachments.length > 0) {
    for (const a of attachments) {
      const file = await cw.downloadAttachment(a.data_url);
      const isAudio = a.file_type === 'audio' || file.mime.startsWith('audio/');
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
    if (evt.content?.trim()) await handleText(ctx, evt.content); // caption, e.g. "paid by card"
    return 'attachments_queued';
  }

  if (!evt.content?.trim()) return 'empty';
  await handleText(ctx, evt.content);
  return 'text_handled';
}
