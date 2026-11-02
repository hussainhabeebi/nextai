import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

const VERSION = 'v1';

function key(): Buffer {
  return Buffer.from(env().ENCRYPTION_KEY, 'base64');
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). AAD binds ciphertext to its context (e.g. tenant id). */
export function encrypt(plaintext: string, aad = ''): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(payload: string, aad = ''): string {
  const [v, ivB, tagB, ctB] = payload.split('.');
  if (v !== VERSION || !ivB || !tagB || ctB === undefined) throw new Error('Malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
}

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

export const hmacSha256 = (secret: string, data: string | Buffer): string =>
  createHmac('sha256', secret).update(data).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const randomOtp = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');
