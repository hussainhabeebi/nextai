import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env.js';
import { randomToken, sha256 } from '../../lib/crypto.js';

export interface AppClaims {
  sub: string; // user id
  tid: string; // tenant id
  role: 'owner' | 'staff' | 'tenant_accountant';
  typ: 'app';
  /** read-only impersonation ("view as tenant") by this platform admin id */
  imp?: string;
}
export interface AdminClaims {
  sub: string;
  prole: 'super_admin' | 'reviewer' | 'support';
  typ: 'admin';
  /** Read-only "view as tenant" impersonation */
  imp?: string;
}

const key = () => new TextEncoder().encode(env().JWT_SECRET);
export const ACCESS_TTL = '15m';
export const APP_REFRESH_TTL_DAYS = 30;
export const ADMIN_REFRESH_TTL_HOURS = 12;

export async function signAccess(claims: AppClaims | AdminClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('nextai')
    .setAudience(claims.typ === 'admin' ? 'nextai-admin' : 'nextai-app')
    .setExpirationTime(claims.typ === 'admin' ? '10m' : ACCESS_TTL)
    .sign(key());
}

export async function verifyAccess<T extends AppClaims | AdminClaims>(token: string, typ: T['typ']): Promise<T> {
  const { payload } = await jwtVerify(token, key(), {
    issuer: 'nextai',
    audience: typ === 'admin' ? 'nextai-admin' : 'nextai-app',
    algorithms: ['HS256'],
  });
  if (payload.typ !== typ) throw new Error('wrong token type');
  return payload as unknown as T;
}

/** Opaque refresh token; only its keyed hash is stored. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomToken(32);
  return { token, hash: hashRefresh(token) };
}
export const hashRefresh = (token: string): string => sha256(`${env().JWT_REFRESH_SECRET}:${token}`);

/** Short-lived token for the admin TOTP enrolment step. */
export async function signSetupToken(userId: string, secretEnc: string): Promise<string> {
  return new SignJWT({ sub: userId, s: secretEnc, typ: 'totp_setup' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('10m')
    .setAudience('nextai-admin-setup')
    .sign(new TextEncoder().encode(env().JWT_REFRESH_SECRET));
}
export async function verifySetupToken(token: string): Promise<{ sub: string; s: string }> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(env().JWT_REFRESH_SECRET), {
    audience: 'nextai-admin-setup',
  });
  return payload as unknown as { sub: string; s: string };
}
