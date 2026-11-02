import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Container } from '../../container.js';
import { adminAuthRoutes } from './auth.js';

export const adminRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    await app.register(adminAuthRoutes(c), { prefix: '/auth' });
  };
