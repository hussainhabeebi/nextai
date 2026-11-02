import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

let msgId = 5000;
export function cwMessage(over: {
  inboxId: number;
  phone: string;
  content?: string;
  conversationId?: number;
  attachments?: Array<{ file_type: string; data_url: string }>;
  message_type?: string;
  id?: number;
}) {
  return {
    event: 'message_created',
    id: over.id ?? ++msgId + Math.floor(Math.random() * 1e6),
    content: over.content ?? null,
    message_type: over.message_type ?? 'incoming',
    private: false,
    inbox: { id: over.inboxId },
    account: { id: 1 },
    conversation: { id: over.conversationId ?? 77 },
    sender: { id: 9, type: 'contact', name: 'Owner', phone_number: over.phone },
    attachments: over.attachments,
  };
}

export function signCw(body: string, secret = process.env.CHATWOOT_WEBHOOK_SECRET!) {
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'x-chatwoot-timestamp': ts, 'x-chatwoot-signature': 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex') };
}

export async function postCw(app: FastifyInstance, payload: unknown) {
  const body = JSON.stringify(payload);
  return app.inject({ method: 'POST', url: '/webhooks/chatwoot', payload: body, headers: { 'content-type': 'application/json', ...signCw(body) } });
}
