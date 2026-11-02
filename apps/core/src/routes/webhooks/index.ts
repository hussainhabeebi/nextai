import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Container } from '../../container.js';
import { chatwootWebhook } from './chatwoot.js';
import { erpnextWebhook } from './erpnext.js';
import { stripeWebhook } from './stripe.js';

export const webhookRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    await app.register(chatwootWebhook(c));
    await app.register(erpnextWebhook(c));
    await app.register(stripeWebhook(c));
  };
