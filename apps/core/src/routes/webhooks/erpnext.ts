import { QUEUES } from '@nextai/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { decrypt } from '../../lib/crypto.js';
import { withSystemTx } from '../../lib/db.js';
import { LIFECYCLE_DOCTYPES, LIFECYCLE_EVENTS } from '../../modules/lifecycle/events.js';
import { onSalesInvoiceSubmitted } from '../../modules/einvoice/service.js';
import { claimEvent, markProcessed } from '../../modules/webhooks/idempotency.js';
import { verifyFrappe } from '../../modules/webhooks/verify.js';

const payloadSchema = z
  .object({
    doctype: z.enum(LIFECYCLE_DOCTYPES),
    name: z.string().min(1).max(140),
    event: z.enum(LIFECYCLE_EVENTS).default('on_submit'),
    /** doc.modified — makes repeated on_update events for the same document distinct for idempotency. */
    modified: z.string().max(40).optional(),
    docstatus: z.number().optional(),
    payment_type: z.string().optional(),
    party: z.string().optional(),
    customer: z.string().optional(),
  })
  .passthrough();

/**
 * Frappe Webhook (configure per site: doctype Sales Invoice / Payment Entry, on_submit,
 * request JSON {"doctype": "{{ doc.doctype }}", "name": "{{ doc.name }}", "event": "on_submit", ...},
 * Webhook Secret = the tenant's erp webhook secret).
 *
 * Lifecycle doctypes (Lead, Opportunity, Event, Quotation, Sales Order, Project, Task, Issue, Subscription, and
 * Sales Invoice / Payment Entry too) send after_insert / on_update / on_submit / on_cancel with
 * {"doctype", "name", "event", "modified": "{{ doc.modified }}"}; they are handed to the lifecycle engine,
 * which re-reads the document from ERPNext (the payload is never trusted for content).
 */
export const erpnextWebhook =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    app.post('/erpnext/:tenantSlug', { schema: { params: z.object({ tenantSlug: z.string().regex(/^[a-z0-9-]{2,40}$/) }) } }, async (req, reply) => {
      const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUnique({ where: { slug: req.params.tenantSlug } }));
      if (!tenant?.erpWebhookSecretEnc) return reply.code(404).send({ error: 'not_found' });
      const secret = decrypt(tenant.erpWebhookSecretEnc, `erp_webhook:${tenant.id}`);
      if (!verifyFrappe(secret, req.rawBody ?? Buffer.from(''), req.headers['x-frappe-webhook-signature'] as string | undefined)) {
        return reply.code(401).send({ error: 'invalid_signature' });
      }
      const p = payloadSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: 'invalid_payload' });
      const { doctype, name, event, modified } = p.data;
      const key = `${tenant.id}:${doctype}:${name}:${event}${modified && event !== 'on_submit' ? `:${modified}` : ''}`;
      const claim = await claimEvent(c.prisma, 'erpnext', key, p.data, tenant.id);
      if (!claim.first) return { status: 'duplicate' };
      if (event === 'on_submit') {
        if (doctype === 'Sales Invoice') {
          await onSalesInvoiceSubmitted(c, tenant, name, { send: true, source: 'erpnext' });
        } else if (p.data.payment_type === 'Receive') {
          await c.queue.enqueue(QUEUES.outboundReceipt, { tenantId: tenant.id, paymentName: name, source: 'erpnext' }, { jobId: `rcpt-${tenant.id}-${name}` });
        }
      }
      await c.queue.enqueue(QUEUES.lifecycleEvent, { tenantId: tenant.id, doctype, name, event }, { jobId: `lc-${claim.id}` });
      await markProcessed(c.prisma, claim.id);
      return { status: 'accepted' };
    });
  };
