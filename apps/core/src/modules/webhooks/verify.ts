import { createHmac } from 'node:crypto';
import { safeEqual } from '../../lib/crypto.js';

/** IPv4/IPv6 exact or IPv4 CIDR allowlist match. */
export function ipAllowed(ip: string, allow: string[]): boolean {
  const clean = ip.replace(/^::ffff:/, '');
  return allow.some((entry) => {
    if (!entry.includes('/')) return entry === clean;
    const [base, bitsStr] = entry.split('/');
    const bits = Number(bitsStr);
    const toInt = (s: string) => s.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(clean) || !/^\d+\.\d+\.\d+\.\d+$/.test(base!)) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (toInt(clean) & mask) === (toInt(base!) & mask);
  });
}

/**
 * Chatwoot authenticity: either
 *  - `X-Chatwoot-Signature: sha256=<hex hmac(secret, "<timestamp>.<body>")>` + `X-Chatwoot-Timestamp` (signed webhooks), or
 *  - the shared secret as `?token=` on the configured Agent Bot outgoing URL.
 */
export function verifyChatwoot(opts: {
  secret: string;
  rawBody: Buffer;
  signature?: string;
  timestamp?: string;
  token?: string;
  nowSec?: number;
}): boolean {
  if (opts.signature && opts.timestamp) {
    const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(opts.timestamp)) > 300) return false;
    const expected = 'sha256=' + createHmac('sha256', opts.secret).update(`${opts.timestamp}.`).update(opts.rawBody).digest('hex');
    return safeEqual(expected, opts.signature);
  }
  if (opts.token) return safeEqual(opts.token, opts.secret);
  return false;
}

/** Frappe webhook: X-Frappe-Webhook-Signature = base64(HMAC-SHA256(secret, body)). */
export function verifyFrappe(secret: string, rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeEqual(expected, signature);
}
