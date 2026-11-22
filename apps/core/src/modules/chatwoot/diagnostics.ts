import type { Redis } from 'ioredis';

/**
 * Last Chatwoot webhook seen by the API, for Admin → Integrations ("is Chatwoot reaching us, and why not?").
 * Kept apart for accepted and rejected calls so routine ignored events don't hide a rejection. No secrets stored.
 */
export interface WebhookTrace {
  at: string;
  result: 'accepted' | 'ip_rejected' | 'bad_token' | 'invalid_payload' | 'unknown_inbox';
  detail?: string;
  ip?: string;
  inboxId?: number;
}

const KEY = { accepted: 'cw:webhook:accepted', rejected: 'cw:webhook:rejected' } as const;
const TTL = 30 * 86400;

export async function traceWebhook(redis: Redis, t: Omit<WebhookTrace, 'at'>): Promise<void> {
  const key = t.result === 'accepted' ? KEY.accepted : KEY.rejected;
  await redis.set(key, JSON.stringify({ ...t, at: new Date().toISOString() }), 'EX', TTL).catch(() => undefined);
}

export async function readWebhookTraces(redis: Redis): Promise<{ accepted: WebhookTrace | null; rejected: WebhookTrace | null }> {
  const [a, r] = await redis.mget(KEY.accepted, KEY.rejected);
  return { accepted: a ? (JSON.parse(a) as WebhookTrace) : null, rejected: r ? (JSON.parse(r) as WebhookTrace) : null };
}

/** WhatsApp's 24h customer-service window: free text is allowed after the customer's last message. */
const windowKey = (tenantId: string, phone: string) => `wa:window:${tenantId}:${phone}`;
export async function markCustomerWindow(redis: Redis, tenantId: string, phone: string): Promise<void> {
  await redis.set(windowKey(tenantId, phone), '1', 'EX', 23 * 3600).catch(() => undefined); // 1h safety margin
}
export async function inCustomerWindow(redis: Redis, tenantId: string, phone: string): Promise<boolean> {
  return (await redis.exists(windowKey(tenantId, phone)).catch(() => 0)) === 1;
}
