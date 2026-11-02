import type { FastifyPluginAsync } from 'fastify';
import type { Container } from '../container.js';
import { LocalFsStorage } from '../storage/storage.js';

export const healthRoutes =
  (c: Container): FastifyPluginAsync =>
  async (app) => {
    app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));
    // Dev-only file serving for LocalFsStorage signed URLs.
    if (c.storage instanceof LocalFsStorage) {
      const storage = c.storage;
      app.get('/files/*', async (req, reply) => {
        const key = (req.params as { '*': string })['*'];
        const { exp, sig } = req.query as { exp?: string; sig?: string };
        const tenantId = key.split('/')[1] ?? '';
        if (!exp || !sig || !key.startsWith('tenants/') || key.includes('..') || !storage.verify(key, Number(exp), sig)) return reply.code(403).send();
        const obj = await storage.get(tenantId, key);
        return reply.type(obj.contentType).header('cache-control', 'private, max-age=60').send(Buffer.from(obj.body));
      });
    }
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
