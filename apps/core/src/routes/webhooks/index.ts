import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Container } from '../../container.js';

export const webhookRoutes =
  (_c: Container): FastifyPluginAsyncZod =>
  async (_app) => {};
