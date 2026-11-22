/**
 * The business's own Razorpay account (not NextAi's billing): payment links for its invoices.
 * Docs: https://razorpay.com/docs/api/payments/payment-links/
 */
import type { Tenant } from '@prisma/client';
import { decrypt, hmacSha256, safeEqual } from '../../lib/crypto.js';

export interface CreateLinkInput {
  amount: number; // rupees
  currency: string;
  referenceId: string; // unique per link in Razorpay
  description: string;
  customer: { name: string; contact?: string };
  notes: Record<string, string>;
}
export interface RazorpayLink {
  id: string;
  url: string;
  status: string;
}

export interface RazorpayClient {
  /** Checks the keys (a cheap authenticated read). */
  verify(): Promise<void>;
  createLink(input: CreateLinkInput): Promise<RazorpayLink>;
  cancelLink(id: string): Promise<void>;
}

export class RazorpayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}

export const sealRzpSecret = (tenantId: string) => `rzp_secret:${tenantId}`;
export const sealRzpWebhook = (tenantId: string) => `rzp_webhook:${tenantId}`;

/** Razorpay signs webhooks with HMAC-SHA256 (hex) of the raw body, in X-Razorpay-Signature. */
export function verifyRazorpaySignature(secret: string, rawBody: Buffer | string, signature: string | undefined): boolean {
  if (!signature) return false;
  return safeEqual(hmacSha256(secret, rawBody), signature);
}

export class HttpRazorpayClient implements RazorpayClient {
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly base = 'https://api.razorpay.com/v1',
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { description?: string } } & T;
    if (!res.ok) throw new RazorpayError(body.error?.description ?? `Razorpay ${res.status}`, res.status);
    return body;
  }

  async verify() {
    await this.call('/payment_links?count=1');
  }

  async createLink(i: CreateLinkInput): Promise<RazorpayLink> {
    const r = await this.call<{ id: string; short_url: string; status: string }>('/payment_links', {
      method: 'POST',
      body: JSON.stringify({
        amount: Math.round(i.amount * 100), // paise
        currency: i.currency,
        accept_partial: false,
        reference_id: i.referenceId.slice(0, 40),
        description: i.description.slice(0, 2048),
        customer: { name: i.customer.name.slice(0, 100), ...(i.customer.contact ? { contact: i.customer.contact } : {}) },
        notify: { sms: false, email: false }, // NextAi sends it on WhatsApp
        reminder_enable: false,
        notes: i.notes,
      }),
    });
    return { id: r.id, url: r.short_url, status: r.status };
  }

  async cancelLink(id: string) {
    await this.call(`/payment_links/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }
}

/** The tenant's Razorpay client, or undefined when it hasn't connected Razorpay. */
export function razorpayClientFor(tenant: Tenant): RazorpayClient | undefined {
  if (!tenant.rzpKeyId || !tenant.rzpKeySecretEnc) return undefined;
  return new HttpRazorpayClient(tenant.rzpKeyId, decrypt(tenant.rzpKeySecretEnc, sealRzpSecret(tenant.id)));
}

/** In-memory Razorpay for tests and MOCK_EXTERNALS. */
export class FakeRazorpayClient implements RazorpayClient {
  links = new Map<string, CreateLinkInput & { id: string; url: string; status: string }>();
  invalidKeys = false;
  private seq = 0;
  async verify() {
    if (this.invalidKeys) throw new RazorpayError('Authentication failed', 401);
  }
  async createLink(i: CreateLinkInput) {
    if ([...this.links.values()].some((l) => l.referenceId === i.referenceId)) throw new RazorpayError('reference_id already exists', 400);
    const id = `plink_${++this.seq}`;
    const link = { ...i, id, url: `https://rzp.io/i/${id}`, status: 'created' };
    this.links.set(id, link);
    return { id, url: link.url, status: link.status };
  }
  async cancelLink(id: string) {
    const l = this.links.get(id);
    if (l) l.status = 'cancelled';
  }
}
