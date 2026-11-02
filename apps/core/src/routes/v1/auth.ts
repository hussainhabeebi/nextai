import { normalizePhone, otpRequestSchema, otpVerifySchema, uuid } from '@nextai/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isProd } from '../../config/env.js';
import type { Container } from '../../container.js';
import { withSystemTx } from '../../lib/db.js';
import { unauthorized } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../modules/audit/audit.js';
import { checkOtp, issueOtp, otpFallbackText, otpLogLabel } from '../../modules/auth/otp.js';
import { APP_REFRESH_TTL_DAYS, hashRefresh, newRefreshToken, signAccess } from '../../modules/auth/tokens.js';
import { sendWhatsApp } from '../../modules/outbound/whatsapp.js';

export const APP_REFRESH_COOKIE = 'nx_rt';

const membershipsSchema = z.array(z.object({ tenantId: z.string(), name: z.string(), role: z.string().nullable() }));
const tokenResponse = z.object({
  accessToken: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  memberships: membershipsSchema,
});

async function membershipsForPhone(c: Container, phone: string) {
  return withSystemTx(c.prisma, (tx) =>
    tx.user.findMany({
      where: { phone, status: { not: 'disabled' }, tenantId: { not: null }, tenant: { status: { not: 'suspended' } } },
      include: { tenant: true },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(APP_REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'strict',
    path: '/v1/auth',
    maxAge: APP_REFRESH_TTL_DAYS * 86400,
  });
}

export const appAuthRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

    app.post(
      '/otp/request',
      { ...strict, schema: { tags: ['auth'], body: otpRequestSchema, response: { 200: z.object({ sent: z.boolean(), devCode: z.string().optional() }) } } },
      async (req) => {
        const phone = normalizePhone(req.body.phone);
        const members = await membershipsForPhone(c, phone);
        // Do not reveal whether the number is registered.
        if (members.length === 0) return { sent: true };
        const issued = await issueOtp(c.redis, phone);
        if ('throttled' in issued) return { sent: true };
        const first = members.find((m) => m.tenant!.cwInboxId) ?? members[0]!;
        try {
          await sendWhatsApp(c, first.tenant!, {
            kind: 'otp',
            phone,
            name: first.name,
            templateKey: 'otp',
            params: [issued.code],
            fallbackText: otpFallbackText(issued.code),
          });
        } catch (err) {
          logger.warn({ phone: otpLogLabel(phone), err: (err as Error).message }, 'otp delivery failed');
        }
        return { sent: true, devCode: isProd() ? undefined : issued.code };
      },
    );

    app.post('/otp/verify', { ...strict, schema: { tags: ['auth'], body: otpVerifySchema, response: { 200: tokenResponse } } }, async (req, reply) => {
      const phone = normalizePhone(req.body.phone);
      if (!(await checkOtp(c.redis, phone, req.body.code))) throw unauthorized('Invalid or expired code');
      const members = await membershipsForPhone(c, phone);
      const chosen = (req.body.tenantId && members.find((m) => m.tenantId === req.body.tenantId)) || members[0];
      if (!chosen) throw unauthorized();
      return issueSession(c, req, reply, chosen, members);
    });

    app.post('/refresh', { schema: { tags: ['auth'], response: { 200: tokenResponse } } }, async (req, reply) => {
      const { session, user } = await requireRefresh(c, req);
      await withSystemTx(c.prisma, (tx) => tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } }));
      const members = await membershipsForPhone(c, user.phone!);
      const current = members.find((m) => m.id === user.id);
      if (!current) throw unauthorized();
      return issueSession(c, req, reply, current, members);
    });

    /** Business switcher: same phone, different tenant membership. */
    app.post(
      '/switch',
      { schema: { tags: ['auth'], body: z.object({ tenantId: uuid }), response: { 200: tokenResponse } } },
      async (req, reply) => {
        const { session, user } = await requireRefresh(c, req);
        const members = await membershipsForPhone(c, user.phone!);
        const target = members.find((m) => m.tenantId === req.body.tenantId);
        if (!target) throw unauthorized('Not a member of that business');
        await withSystemTx(c.prisma, (tx) => tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } }));
        await audit(c.prisma, { tenantId: target.tenantId, actorId: target.id, actorType: 'user', channel: 'app', action: 'auth.switch', entity: 'tenant', entityId: target.tenantId, ip: req.ip });
        return issueSession(c, req, reply, target, members);
      },
    );

    app.post('/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
      const token = req.cookies[APP_REFRESH_COOKIE];
      if (token) {
        await withSystemTx(c.prisma, (tx) =>
          tx.session.updateMany({ where: { refreshHash: hashRefresh(token), revokedAt: null }, data: { revokedAt: new Date() } }),
        );
      }
      reply.clearCookie(APP_REFRESH_COOKIE, { path: '/v1/auth' });
      return { ok: true };
    });
  };

async function requireRefresh(c: Container, req: FastifyRequest) {
  const token = req.cookies[APP_REFRESH_COOKIE];
  if (!token) throw unauthorized();
  const session = await withSystemTx(c.prisma, (tx) =>
    tx.session.findUnique({ where: { refreshHash: hashRefresh(token) }, include: { user: true } }),
  );
  if (!session || session.kind !== 'app' || session.revokedAt || session.expiresAt < new Date() || !session.user.phone) {
    // Reuse of a revoked token → revoke the whole family for safety.
    if (session?.revokedAt) {
      await withSystemTx(c.prisma, (tx) => tx.session.updateMany({ where: { userId: session.userId, revokedAt: null }, data: { revokedAt: new Date() } }));
    }
    throw unauthorized();
  }
  return { session, user: session.user };
}

type Member = Awaited<ReturnType<typeof membershipsForPhone>>[number];

async function issueSession(c: Container, req: FastifyRequest, reply: FastifyReply, m: Member, members: Member[]) {
  const { token, hash } = newRefreshToken();
  await withSystemTx(c.prisma, async (tx) => {
    await tx.session.create({
      data: {
        userId: m.id,
        tenantId: m.tenantId,
        kind: 'app',
        refreshHash: hash,
        userAgent: req.headers['user-agent']?.slice(0, 200),
        ip: req.ip,
        expiresAt: new Date(Date.now() + APP_REFRESH_TTL_DAYS * 86400_000),
      },
    });
    await tx.user.update({ where: { id: m.id }, data: { lastLoginAt: new Date(), status: 'active' } });
  });
  setRefreshCookie(reply, token);
  const accessToken = await signAccess({ sub: m.id, tid: m.tenantId!, role: m.role ?? 'staff', typ: 'app' });
  return {
    accessToken,
    tenantId: m.tenantId!,
    userId: m.id,
    memberships: members.map((x) => ({ tenantId: x.tenantId!, name: x.tenant!.name, role: x.role })),
  };
}
