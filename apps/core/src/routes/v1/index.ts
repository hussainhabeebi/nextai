import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Container } from '../../container.js';
import { appAuthRoutes } from './auth.js';
import { meRoutes } from './me.js';
import { appRoutes } from './app.js';

export const v1Routes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    await app.register(appAuthRoutes(c), { prefix: '/auth' });
    // Everything below requires an app JWT; tenant is resolved from the token claim.
    await app.register(async (authed) => {
      authed.addHook('onRequest', authed.requireApp);
      authed.addHook('preHandler', authed.loadTenant);
      await authed.register(meRoutes(c));
      await authed.register(appRoutes(c));
    });
  };
