import { adminLoginSchema } from '@nextai/shared';
import bcrypt from 'bcryptjs';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { isProd } from '../../config/env.js';
import type { Container } from '../../container.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { withSystemTx } from '../../lib/db.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { audit } from '../../modules/audit/audit.js';
import {
  ADMIN_REFRESH_TTL_HOURS,
  hashRefresh,
  newRefreshToken,
  signAccess,
  signSetupToken,
  verifySetupToken,
} from '../../modules/auth/tokens.js';

export const ADMIN_REFRESH_COOKIE = 'nx_admin_rt';
authenticator.options = { window: 1 };

const totpAad = (userId: string) => `totp:${userId}`;

/** Admin auth: email + password + mandatory TOTP. Separate cookie, audience and session kind from the app. */
export const adminAuthRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    const strict = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

    const issue = async (userId: string, prole: 'super_admin' | 'reviewer' | 'support', ip: string, ua: string | undefined, reply: import('fastify').FastifyReply) => {
      const { token, hash } = newRefreshToken();
      await withSystemTx(c.prisma, async (tx) => {
        await tx.session.create({
          data: { userId, kind: 'admin', refreshHash: hash, ip, userAgent: ua?.slice(0, 200), expiresAt: new Date(Date.now() + ADMIN_REFRESH_TTL_HOURS * 3600_000) },
        });
        await tx.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
      });
      reply.setCookie(ADMIN_REFRESH_COOKIE, token, {
        httpOnly: true,
        secure: isProd(),
        sameSite: 'strict',
        path: '/admin/v1/auth',
        maxAge: ADMIN_REFRESH_TTL_HOURS * 3600,
      });
      return { accessToken: await signAccess({ sub: userId, prole, typ: 'admin' }), role: prole };
    };

    app.post('/login', { ...strict, schema: { tags: ['admin-auth'], body: adminLoginSchema } }, async (req, reply) => {
      const user = await withSystemTx(c.prisma, (tx) =>
        tx.user.findFirst({ where: { email: req.body.email.toLowerCase(), platformRole: { not: null }, status: 'active' } }),
      );
      // constant-ish time: always run bcrypt
      const ok = await bcrypt.compare(req.body.password, user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
      if (!user || !ok || !user.platformRole) {
        await audit(c.prisma, { actorType: 'admin', channel: 'admin', action: 'admin.login_failed', entity: 'user', ip: req.ip, after: { email: req.body.email } });
        throw unauthorized('Invalid credentials');
      }
      if (!user.totpSecretEnc) {
        const secret = authenticator.generateSecret();
        const enc = encrypt(secret, totpAad(user.id));
        return reply.code(200).send({
          totpSetupRequired: true,
          otpauthUrl: authenticator.keyuri(user.email!, 'NextAi Admin', secret),
          setupToken: await signSetupToken(user.id, enc),
        });
      }
      if (!req.body.totp) throw new AppError(401, 'totp_required', 'Enter your 2FA code');
      if (!authenticator.check(req.body.totp, decrypt(user.totpSecretEnc, totpAad(user.id)))) {
        await audit(c.prisma, { actorId: user.id, actorType: 'admin', channel: 'admin', action: 'admin.totp_failed', entity: 'user', entityId: user.id, ip: req.ip });
        throw unauthorized('Invalid 2FA code');
      }
      await audit(c.prisma, { actorId: user.id, actorType: 'admin', channel: 'admin', action: 'admin.login', entity: 'user', entityId: user.id, ip: req.ip });
      return issue(user.id, user.platformRole, req.ip, req.headers['user-agent'], reply);
    });

    app.post(
      '/totp/enroll',
      { ...strict, schema: { tags: ['admin-auth'], body: z.object({ setupToken: z.string(), totp: z.string().regex(/^\d{6}$/) }) } },
      async (req, reply) => {
        let setup: { sub: string; s: string };
        try {
          setup = await verifySetupToken(req.body.setupToken);
        } catch {
          throw unauthorized();
        }
        const secret = decrypt(setup.s, totpAad(setup.sub));
        if (!authenticator.check(req.body.totp, secret)) throw unauthorized('Invalid 2FA code');
        const user = await withSystemTx(c.prisma, (tx) => tx.user.update({ where: { id: setup.sub }, data: { totpSecretEnc: setup.s } }));
        await audit(c.prisma, { actorId: user.id, actorType: 'admin', channel: 'admin', action: 'admin.totp_enrolled', entity: 'user', entityId: user.id, ip: req.ip });
        return issue(user.id, user.platformRole!, req.ip, req.headers['user-agent'], reply);
      },
    );

    app.post('/refresh', { schema: { tags: ['admin-auth'] } }, async (req, reply) => {
      const token = req.cookies[ADMIN_REFRESH_COOKIE];
      if (!token) throw unauthorized();
      const s = await withSystemTx(c.prisma, (tx) => tx.session.findUnique({ where: { refreshHash: hashRefresh(token) }, include: { user: true } }));
      if (!s || s.kind !== 'admin' || s.revokedAt || s.expiresAt < new Date() || !s.user.platformRole || s.user.status !== 'active') throw unauthorized();
      await withSystemTx(c.prisma, (tx) => tx.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } }));
      return issue(s.userId, s.user.platformRole, req.ip, req.headers['user-agent'], reply);
    });

    app.post('/logout', { schema: { tags: ['admin-auth'] } }, async (req, reply) => {
      const token = req.cookies[ADMIN_REFRESH_COOKIE];
      if (token) await withSystemTx(c.prisma, (tx) => tx.session.updateMany({ where: { refreshHash: hashRefresh(token) }, data: { revokedAt: new Date() } }));
      reply.clearCookie(ADMIN_REFRESH_COOKIE, { path: '/admin/v1/auth' });
      return { ok: true };
    });
  };
