import type { FastifyPluginAsync } from 'fastify';
import type { Container } from '../../container.js';
import { decrypt } from '../../lib/crypto.js';
import { withSystemTx } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { sealRzpWebhook, verifyRazorpaySignature } from '../../modules/razorpay/client.js';
import { parsePaidEvent, recordLinkPayment } from '../../modules/razorpay/service.js';
import { claimEvent, markProcessed, releaseEvent } from '../../modules/webhooks/idempotency.js';

/**
 * Razorpay webhook for one business (set in its Razorpay dashboard: this URL, the secret shown on connect,
 * event payment_link.paid). Other events are acknowledged and ignored.
 */
export const razorpayWebhook =
  (c: Container): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Params: { tenantSlug: string } }>('/razorpay/:tenantSlug', async (req, reply) => {
      if (!/^[a-z0-9-]{2,40}$/.test(req.params.tenantSlug)) return reply.code(404).send({ error: 'not_found' });
      const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUnique({ where: { slug: req.params.tenantSlug } }));
      if (!tenant?.rzpWebhookSecretEnc) return reply.code(404).send({ error: 'not_found' });
      const secret = decrypt(tenant.rzpWebhookSecretEnc, sealRzpWebhook(tenant.id));
      if (!verifyRazorpaySignature(secret, req.rawBody ?? Buffer.from(''), req.headers['x-razorpay-signature'] as string | undefined)) {
        return reply.code(401).send({ error: 'invalid_signature' });
      }
      const evt = parsePaidEvent(req.body);
      if (!evt) return { status: 'ignored' };
      const eventId = (req.headers['x-razorpay-event-id'] as string | undefined) ?? evt.paymentId;
      const claim = await claimEvent(c.prisma, 'razorpay', `${tenant.id}:${eventId}`, req.body, tenant.id);
      if (!claim.first) return { status: 'duplicate' };
      try {
        const r = await recordLinkPayment(c, tenant, evt);
        await markProcessed(c.prisma, claim.id);
        return r;
      } catch (err) {
        logger.error({ tenantId: tenant.id, err: (err as Error).message }, 'razorpay payment not recorded');
        await releaseEvent(c.prisma, claim.id);
        throw err; // 500 → Razorpay retries
      }
    });
  };
