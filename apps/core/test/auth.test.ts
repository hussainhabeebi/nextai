import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { seed } from '../prisma/seed.js';
import { closeShared, createTenant, testContainer } from './helpers.js';
import type { FastifyInstance } from 'fastify';

const c = testContainer();
let app: FastifyInstance;
const phone = '+919812345678';
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;

beforeAll(async () => {
  await seed(c.prisma);
  await c.redis.flushdb();
  A = await createTenant(c.prisma, { ownerPhone: phone, name: 'Alpha' });
  B = await createTenant(c.prisma, { ownerPhone: phone, name: 'Beta' });
  app = await buildApp(c);
});
afterAll(async () => {
  await app.close();
  await closeShared();
});

const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }, name: string) => res.cookies.find((k) => k.name === name)?.value;

describe('app OTP auth', () => {
  it('logs in with WhatsApp OTP, scopes JWT to one tenant, switches business', async () => {
    const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '98123 45678' } });
    expect(req.statusCode).toBe(200);
    const code = req.json().devCode as string;
    expect(code).toMatch(/^\d{6}$/);
    // OTP was sent through the tenant's Chatwoot inbox as a template
    const sent = [...c.cws.values()].flatMap((cw) => cw.sent);
    expect(sent.some((m) => m.kind === 'template' && m.template?.name === 'nextai_otp')).toBe(true);

    const bad = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: code === '000000' ? '111111' : '000000' } });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code, tenantId: A.tenant.id } });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.tenantId).toBe(A.tenant.id);
    expect(body.memberships).toHaveLength(2);
    const rt = cookieOf(ok, 'nx_rt')!;
    expect(rt).toBeTruthy();

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(me.json().tenant.name).toBe('Alpha');

    const sw = await app.inject({ method: 'POST', url: '/v1/auth/switch', payload: { tenantId: B.tenant.id }, cookies: { nx_rt: rt } });
    expect(sw.statusCode).toBe(200);
    const me2 = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${sw.json().accessToken}` } });
    expect(me2.json().tenant.name).toBe('Beta');

    // old refresh token was rotated → reuse is rejected
    const reuse = await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { nx_rt: rt } });
    expect(reuse.statusCode).toBe(401);
  });

  it('does not reveal unknown numbers and rejects missing tokens', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+910000000001' } });
    expect(r.json()).toEqual({ sent: true });
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
  });

  it('ignores tenant ids in the request body (tenant only from JWT)', async () => {
    const code = (await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } })).json().devCode;
    const ok = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code, tenantId: '00000000-0000-0000-0000-000000000000' } });
    expect(ok.json().tenantId).toBe(A.tenant.id); // falls back to a real membership, not the requested one
  });
});

describe('admin auth (password + TOTP)', () => {
  it('requires TOTP enrolment then TOTP on login', async () => {
    const login = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'admin@nextaierp.com', password: 'admin-password-123' } });
    expect(login.statusCode).toBe(200);
    const { setupToken, otpauthUrl } = login.json();
    const secret = new URL(otpauthUrl).searchParams.get('secret')!;
    const enroll = await app.inject({ method: 'POST', url: '/admin/v1/auth/totp/enroll', payload: { setupToken, totp: authenticator.generate(secret) } });
    expect(enroll.statusCode).toBe(200);
    expect(enroll.json().role).toBe('super_admin');

    const noTotp = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'admin@nextaierp.com', password: 'admin-password-123' } });
    expect(noTotp.statusCode).toBe(401);
    expect(noTotp.json().error).toBe('totp_required');

    const wrongPw = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'admin@nextaierp.com', password: 'nope-nope-nope' } });
    expect(wrongPw.statusCode).toBe(401);

    const full = await app.inject({
      method: 'POST',
      url: '/admin/v1/auth/login',
      payload: { email: 'admin@nextaierp.com', password: 'admin-password-123', totp: authenticator.generate(secret) },
    });
    expect(full.statusCode).toBe(200);
    // app token cannot be used against admin and vice versa
    const appCall = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${full.json().accessToken}` } });
    expect(appCall.statusCode).toBe(401);
  });
});
