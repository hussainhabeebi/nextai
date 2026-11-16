import type { Language } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';
import { inCustomerWindow } from '../chatwoot/diagnostics.js';

export interface OutboundOptions {
  kind: 'invoice' | 'receipt' | 'reminder' | 'summary' | 'otp' | 'notice';
  phone: string;
  name: string;
  templateKey: string;
  params: string[];
  fallbackText: string;
  file?: { filename: string; content: Uint8Array; mime: string };
  ref?: string;
  conversationId?: number;
}

/**
 * Business-initiated WhatsApp message. Outside the 24h customer window only approved templates
 * are delivered, so we always lead with the template and attach files after it.
 */
export async function sendWhatsApp(c: Container, tenant: Tenant, o: OutboundOptions): Promise<{ conversationId: number }> {
  const cw = c.chatwoot(tenant);
  const lang = (tenant.language as Language) ?? 'en';
  const tpl =
    (await c.prisma.messageTemplate.findUnique({ where: { key_language: { key: o.templateKey, language: lang } } })) ??
    (await c.prisma.messageTemplate.findUnique({ where: { key_language: { key: o.templateKey, language: 'en' } } }));
  const db = tenantDb(c.prisma, tenant.id);
  const log = await db.outboundMessage.create({
    data: { tenantId: tenant.id, kind: o.kind, toPhone: o.phone, ref: o.ref, status: 'sending' },
  });
  try {
    let conversationId = o.conversationId;
    if (!conversationId) {
      const contact = await cw.findOrCreateContact(o.phone, o.name);
      // Reuse the contact's latest conversation in this inbox: Chatwoot applies the WhatsApp 24h window
      // per conversation, so a fresh conversation can't send free text even right after the customer wrote.
      const existing = await cw.findLatestConversation(contact.contactId).catch(() => null);
      conversationId = existing
        ? existing.conversationId
        : (await cw.createConversation(contact.contactId, contact.sourceId)).conversationId;
    }
    // Inside the 24h window plain text always delivers; templates only once approved in Meta.
    if (tpl && !(await inCustomerWindow(c.redis, tenant.id, o.phone))) {
      await cw.sendTemplate(conversationId, o.fallbackText, { name: tpl.name, language: tpl.language, category: tpl.category, params: o.params });
    } else {
      await cw.sendText(conversationId, o.fallbackText);
    }
    // TODO(chatwoot): if the inbox supports document-header templates, send the PDF as the template header instead.
    if (o.file) await cw.sendFile(conversationId, o.file);
    await db.outboundMessage.update({ where: { id: log.id }, data: { status: 'sent', conversationId } });
    return { conversationId };
  } catch (err) {
    await db.outboundMessage.update({ where: { id: log.id }, data: { status: 'failed', error: (err as Error).message.slice(0, 500) } });
    throw err;
  }
}
