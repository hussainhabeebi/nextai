import { OTP_MAX_ATTEMPTS, OTP_TTL_SECONDS, maskPhone, t } from '@nextai/shared';
import type { Redis } from 'ioredis';
import { randomOtp, safeEqual, sha256 } from '../../lib/crypto.js';
import { env } from '../../config/env.js';

const key = (phone: string) => `otp:${sha256(phone)}`;
const rateKey = (phone: string) => `otp:rate:${sha256(phone)}`;

export async function issueOtp(redis: Redis, phone: string): Promise<{ code: string } | { throttled: true }> {
  // max 5 requests / hour / phone
  const n = await redis.incr(rateKey(phone));
  if (n === 1) await redis.expire(rateKey(phone), 3600);
  if (n > 5) return { throttled: true };
  const code = randomOtp();
  await redis.set(key(phone), JSON.stringify({ h: sha256(`${env().JWT_REFRESH_SECRET}:${code}`), a: 0 }), 'EX', OTP_TTL_SECONDS);
  return { code };
}

export async function checkOtp(redis: Redis, phone: string, code: string): Promise<boolean> {
  const raw = await redis.get(key(phone));
  if (!raw) return false;
  const rec = JSON.parse(raw) as { h: string; a: number };
  if (rec.a >= OTP_MAX_ATTEMPTS) {
    await redis.del(key(phone));
    return false;
  }
  const ok = safeEqual(rec.h, sha256(`${env().JWT_REFRESH_SECRET}:${code}`));
  if (ok) await redis.del(key(phone));
  else await redis.set(key(phone), JSON.stringify({ ...rec, a: rec.a + 1 }), 'KEEPTTL');
  return ok;
}

export const otpLogLabel = (phone: string) => maskPhone(phone);
export const otpFallbackText = (code: string) => `${t('en', 'app.name')} code: ${code}. Valid 5 minutes. Do not share.`;
