import { tenantSettingsSchema } from '@nextai/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Container } from '../../container.js';

export const meRoutes =
  (_c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/me', { schema: { tags: ['app'] } }, async (req) => {
      const user = await req.db!.user.findUnique({ where: { id: req.user!.sub } });
      const t = req.tenant!;
      const { appView, appStyle } = tenantSettingsSchema.parse(t.settings ?? {});
      // Website signups with their own ERPNext site: "queued" / "running" until the site is built.
      const s = (t.settings ?? {}) as { erpSetup?: { status: string; step?: string; site?: string } };
      const setup = s.erpSetup ? { status: s.erpSetup.status, step: s.erpSetup.step ?? null, site: s.erpSetup.site ?? null } : null;
      return {
        user: user && { id: user.id, name: user.name, role: user.role, language: user.language ?? t.language },
        tenant: { id: t.id, name: t.name, slug: t.slug, country: t.country, currency: t.currency, language: t.language, status: t.status, appView, appStyle, setup },
      };
    });
  };
