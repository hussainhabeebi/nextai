import type { FastifyRequest } from 'fastify';
import { ipAllowed } from '../modules/webhooks/verify.js';

/** Cloudflare edge ranges (https://www.cloudflare.com/ips/). Requests from these carry the real client in CF-Connecting-IP. */
export const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CLOUDFLARE_V6 = [/^2400:cb00:/i, /^2606:4700:/i, /^2803:f800:/i, /^2405:b500:/i, /^2405:8100:/i, /^2a06:98c[0-7]:/i, /^2c0f:f248:/i];

export function isCloudflareEdge(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/, '');
  return clean.includes(':') ? CLOUDFLARE_V6.some((re) => re.test(clean)) : ipAllowed(clean, CLOUDFLARE_V4);
}

/**
 * The address that actually made the request. Behind the Cloudflare proxy (orange cloud) the connecting address is
 * a Cloudflare edge; only then is CF-Connecting-IP trusted, so it can't be spoofed by calling the origin directly.
 */
export function clientIp(req: Pick<FastifyRequest, 'ip' | 'headers'>): string {
  const cf = req.headers['cf-connecting-ip'];
  const real = Array.isArray(cf) ? cf[0] : cf;
  return real && isCloudflareEdge(req.ip) ? real.trim() : req.ip;
}
