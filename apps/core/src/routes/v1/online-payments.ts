import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { env } from '../../config/env.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../modules/audit/audit.js';
import { erpContext } from '../../modules/erpnext/mappers.js';
import { connectRazorpay, disconnectRazorpay, paymentLinkFor, supportsRazorpay } from '../../modules/razorpay/service.js';

const webhookUrl = (slug: string) => `${env().API_URL.replace(/\/$/, '')}/webhooks/razorpay/${slug}`;

/** Online payments through the business's own Razorpay account. */
export const onlinePaymentRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/payments/razorpay', { schema: { tags: ['app'] } }, async (req) => {
      const t = req.tenant!;
      const s = erpContext(t).settings.paymentLinks;
      return {
        available: supportsRazorpay(t),
        connected: Boolean(t.rzpKeyId),
        keyId: t.rzpKeyId,
        mode: t.rzpKeyId?.startsWith('rzp_test_') ? 'test' : t.rzpKeyId ? 'live' : null,
        webhookUrl: webhookUrl(t.slug),
        enabled: s.enabled,
        account: s.account ?? null,
        modeOfPayment: s.modeOfPayment ?? null,
      };
    });

    app.post(
      '/payments/razorpay',
      { schema: { tags: ['app'], body: z.object({ keyId: z.string().trim().min(8).max(64), keySecret: z.string().trim().min(8).max(128) }) } },
      async (req) => {
        if (req.user!.role !== 'owner') throw forbidden('Only the business owner can connect Razorpay');
        const t = req.tenant!;
        const r = await connectRazorpay(c, t, req.body);
        await audit(c.prisma, { tenantId: t.id, actorId: req.user!.sub, actorType: 'user', channel: 'app', action: 'razorpay.connect', entity: 'tenant', entityId: t.id, after: { keyId: req.body.keyId, erp: r.erp }, ip: req.ip });
        return {
          connected: true,
          keyId: req.body.keyId,
          // Shown once: paste it into Razorpay → Webhooks together with the URL, event "payment_link.paid".
          webhook: { url: webhookUrl(t.slug), secret: r.webhookSecret, events: ['payment_link.paid'] },
          erp: r.erp,
        };
      },
    );

    app.delete('/payments/razorpay', { schema: { tags: ['app'] } }, async (req) => {
      if (req.user!.role !== 'owner') throw forbidden('Only the business owner can disconnect Razorpay');
      await disconnectRazorpay(c, req.tenant!);
      await audit(c.prisma, { tenantId: req.tenant!.id, actorId: req.user!.sub, actorType: 'user', channel: 'app', action: 'razorpay.disconnect', entity: 'tenant', entityId: req.tenant!.id, ip: req.ip });
      return { connected: false };
    });

    /** A payment link for one invoice (to share by hand); the same link goes out with invoices and reminders. */
    app.post('/invoices/:id/payment-link', { schema: { tags: ['app'], params: z.object({ id: z.string().min(1).max(140) }) } }, async (req) => {
      const t = req.tenant!;
      if (!c.razorpay(t)) throw badRequest('Connect Razorpay in Settings first.');
      const inv = await c.erp(t).get<{ name: string; customer: string; outstanding_amount: number; currency?: string; docstatus: number }>('Sales Invoice', req.params.id).catch(() => undefined);
      if (!inv || inv.docstatus !== 1) throw notFound('Invoice');
      const url = await paymentLinkFor(c, t, inv);
      if (!url) throw badRequest('Nothing is due on this invoice.');
      return { url, amount: inv.outstanding_amount };
    });
  };
