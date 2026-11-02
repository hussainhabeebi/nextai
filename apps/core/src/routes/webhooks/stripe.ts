import type { FastifyPluginAsync } from 'fastify';
import type { Container } from '../../container.js';
import { applyBillingEvent } from '../../modules/billing/service.js';
import { claimEvent, markProcessed, releaseEvent } from '../../modules/webhooks/idempotency.js';

export const stripeWebhook =
  (c: Container): FastifyPluginAsync =>
  async (app) => {
    app.post('/stripe', async (req, reply) => {
      const sig = req.headers['stripe-signature'];
      if (typeof sig !== 'string' || !req.rawBody) return reply.code(400).send({ error: 'missing_signature' });
      let evt;
      try {
        evt = await c.payments.handleWebhook(req.rawBody, sig);
      } catch {
        return reply.code(400).send({ error: 'invalid_signature' });
      }
      const claim = await claimEvent(c.prisma, 'stripe', evt.eventId, { kind: evt.kind });
      if (!claim.first) return { status: 'duplicate' };
      try {
        const result = await applyBillingEvent(c, evt);
        await markProcessed(c.prisma, claim.id);
        return { status: result };
      } catch (err) {
        await releaseEvent(c.prisma, claim.id);
        throw err; // 500 → Stripe retries and the event is processed again
      }
    });
  };
