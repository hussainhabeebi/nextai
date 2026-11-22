import { createHmac } from 'node:crypto';
import { QUEUES, normalizePhone } from '@nextai/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { decrypt, safeEqual } from '../../lib/crypto.js';
import { withSystemTx } from '../../lib/db.js';
import { CF } from '../../modules/lifecycle/events.js';
import { claimEvent, markProcessed } from '../../modules/webhooks/idempotency.js';

/**
 * Lead capture from Leadvyne (which collects Meta ads, WhatsApp and website leads).
 * POST /webhooks/leadvyne/:tenantSlug with `X-Leadvyne-Signature: sha256=<hex hmac(secret, raw body)>`.
 * The secret is generated per tenant in the admin console (Lifecycle → Lead webhook).
 * TODO(leadvyne): confirm the exact payload field names and signature header with Leadvyne and adjust below.
 */
const leadSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().min(1).max(140),
    phone: z.string().min(5).max(30),
    email: z.string().email().max(140).optional(),
    source: z.string().max(60).optional(), // meta_ads | whatsapp | website | ...
    campaign: z.string().max(140).optional(),
    company: z.string().max(140).optional(),
    message: z.string().max(2000).optional(),
  })
  .passthrough();

const SOURCES: Record<string, string> = { meta: 'Advertisement', meta_ads: 'Advertisement', facebook: 'Advertisement', instagram: 'Advertisement', whatsapp: 'WhatsApp', website: 'Website' };

export function verifyLeadvyne(secret: string, rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
}

export const leadvyneWebhook =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    app.post('/leadvyne/:tenantSlug', { schema: { params: z.object({ tenantSlug: z.string().regex(/^[a-z0-9-]{2,40}$/) }) } }, async (req, reply) => {
      const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUnique({ where: { slug: req.params.tenantSlug } }));
      if (!tenant?.leadWebhookSecretEnc || !tenant.erpApiKeyEnc) return reply.code(404).send({ error: 'not_found' });
      const secret = decrypt(tenant.leadWebhookSecretEnc, `lead_webhook:${tenant.id}`);
      if (!verifyLeadvyne(secret, req.rawBody ?? Buffer.from(''), req.headers['x-leadvyne-signature'] as string | undefined)) {
        return reply.code(401).send({ error: 'invalid_signature' });
      }
      const p = leadSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: 'invalid_payload' });
      let phone: string;
      try {
        phone = normalizePhone(p.data.phone, tenant.country);
      } catch {
        return reply.code(400).send({ error: 'invalid_phone' });
      }
      const claim = await claimEvent(c.prisma, 'leadvyne', `${tenant.id}:${p.data.id}`, { id: p.data.id, source: p.data.source }, tenant.id);
      if (!claim.first) return { status: 'duplicate' };

      const erp = c.erp(tenant);
      // Dedupe by phone: a returning lead is not created again (its open timers keep running).
      const existing = await erp.list('Lead', { filters: { mobile_no: phone }, fields: ['name'], limit: 1 });
      let leadName: string;
      let status: 'created' | 'existing';
      if (existing[0]?.name) {
        leadName = String(existing[0].name);
        status = 'existing';
      } else {
        const lead = await erp.create('Lead', {
          lead_name: p.data.name,
          company_name: p.data.company,
          mobile_no: phone,
          whatsapp_no: phone,
          email_id: p.data.email,
          source: SOURCES[(p.data.source ?? '').toLowerCase()] ?? p.data.source,
          campaign_name: p.data.campaign,
          [CF.leadvyneId]: p.data.id,
          notes: p.data.message ? [{ note: p.data.message }] : undefined,
        });
        leadName = String(lead.name);
        status = 'created';
        // Start assignment + "call within 1 hour" now, without waiting for ERPNext's own after_insert webhook (idempotent).
        await c.queue.enqueue(QUEUES.lifecycleEvent, { tenantId: tenant.id, doctype: 'Lead', name: leadName, event: 'after_insert' }, { jobId: `lc-lead-${tenant.id}-${leadName}` });
      }
      await markProcessed(c.prisma, claim.id);
      return { status, lead: leadName };
    });
  };
