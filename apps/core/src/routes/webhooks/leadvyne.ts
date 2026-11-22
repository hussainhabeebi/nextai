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
 * POST /webhooks/leadvyne/:tenantSlug, signed with the per-tenant secret (Admin → Lifecycle → Setup):
 *   `X-Leadvyne-Signature` (or `X-Signature` / `X-Hub-Signature-256`) = `sha256=<hex hmac(secret, raw body)>` (prefix optional),
 *   or, for tools that cannot sign, `?token=<secret>`.
 * Leadvyne's payload format is not publicly documented, so common field names are accepted, flat or under `lead` / `data`:
 *   name | full_name | lead_name | first_name+last_name, phone | mobile | phone_number | whatsapp, email | email_id,
 *   source | lead_source | platform | channel, campaign | campaign_name | utm_campaign, company | company_name,
 *   message | notes | comments, id | lead_id | leadgen_id.
 */
const pick = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) {
    const v = o[k];
    if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return String(v).trim();
  }
  return undefined;
};

export function normalizeLeadPayload(body: unknown) {
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const o = { ...root, ...((root.lead ?? root.data ?? {}) as Record<string, unknown>) } as Record<string, unknown>;
  const name = pick(o, ['name', 'full_name', 'lead_name', 'contact_name']) ?? [pick(o, ['first_name']), pick(o, ['last_name'])].filter(Boolean).join(' ');
  return {
    id: pick(o, ['id', 'lead_id', 'leadgen_id', 'uuid']),
    name,
    phone: pick(o, ['phone', 'mobile', 'mobile_no', 'phone_number', 'whatsapp', 'whatsapp_number', 'contact_number']),
    email: pick(o, ['email', 'email_id', 'email_address']),
    source: pick(o, ['source', 'lead_source', 'platform', 'channel']),
    campaign: pick(o, ['campaign', 'campaign_name', 'utm_campaign', 'ad_name', 'form_name']),
    company: pick(o, ['company', 'company_name', 'business_name']),
    message: pick(o, ['message', 'notes', 'comments', 'requirement']),
  };
}

const leadSchema = z.object({
  id: z.string().min(1).max(140),
  name: z.string().min(1).max(140),
  phone: z.string().min(5).max(30),
  email: z.string().email().max(140).optional().catch(undefined),
  source: z.string().max(60).optional(),
  campaign: z.string().max(140).optional(),
  company: z.string().max(140).optional(),
  message: z.string().max(2000).optional(),
});

const SOURCES: Record<string, string> = { meta: 'Advertisement', meta_ads: 'Advertisement', facebook: 'Advertisement', instagram: 'Advertisement', whatsapp: 'WhatsApp', website: 'Website' };

export function verifyLeadvyne(secret: string, rawBody: Buffer, signature: string | undefined, token?: string): boolean {
  if (signature) {
    const hex = createHmac('sha256', secret).update(rawBody).digest('hex');
    return safeEqual(signature.startsWith('sha256=') ? `sha256=${hex}` : hex, signature);
  }
  return !!token && safeEqual(token, secret);
}

export const leadvyneWebhook =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    app.post('/leadvyne/:tenantSlug', { schema: { params: z.object({ tenantSlug: z.string().regex(/^[a-z0-9-]{2,40}$/) }), querystring: z.object({ token: z.string().max(200).optional() }) } }, async (req, reply) => {
      const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUnique({ where: { slug: req.params.tenantSlug } }));
      if (!tenant?.leadWebhookSecretEnc || !tenant.erpApiKeyEnc) return reply.code(404).send({ error: 'not_found' });
      const secret = decrypt(tenant.leadWebhookSecretEnc, `lead_webhook:${tenant.id}`);
      const h = req.headers;
      const signature = (h['x-leadvyne-signature'] ?? h['x-signature'] ?? h['x-hub-signature-256']) as string | undefined;
      const token = req.query.token;
      if (!verifyLeadvyne(secret, req.rawBody ?? Buffer.from(''), signature, token)) {
        return reply.code(401).send({ error: 'invalid_signature' });
      }
      const raw = normalizeLeadPayload(req.body);
      const p = leadSchema.safeParse({ ...raw, id: raw.id ?? (raw.phone ? `phone:${raw.phone}:${new Date().toISOString().slice(0, 10)}` : undefined) });
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
