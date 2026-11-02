import type { FastifyPluginAsync } from 'fastify';
import type { Container } from '../container.js';

export const healthRoutes =
  (c: Container): FastifyPluginAsync =>
  async (app) => {
    app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));
    app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
      const checks: Record<string, boolean> = {};
      try {
        await c.prisma.$queryRaw`SELECT 1`;
        checks.postgres = true;
      } catch {
        checks.postgres = false;
      }
      try {
        checks.redis = (await c.redis.ping()) === 'PONG';
      } catch {
        checks.redis = false;
      }
      const ok = Object.values(checks).every(Boolean);
      return reply.code(ok ? 200 : 503).send({ ok, checks });
    });
  };
