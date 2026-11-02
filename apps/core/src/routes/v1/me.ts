import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Container } from '../../container.js';

export const meRoutes =
  (_c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/me', { schema: { tags: ['app'] } }, async (req) => {
      const user = await req.db!.user.findUnique({ where: { id: req.user!.sub } });
      const t = req.tenant!;
      return {
        user: user && { id: user.id, name: user.name, role: user.role, language: user.language ?? t.language },
        tenant: { id: t.id, name: t.name, slug: t.slug, country: t.country, currency: t.currency, language: t.language, status: t.status },
      };
    });
  };
