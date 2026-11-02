import { chatwootWebhookSchema, isProcessableIncoming } from '@nextai/chatwoot-client';
import type { FastifyPluginAsync } from 'fastify';
import { env, isProd } from '../../config/env.js';
import type { Container } from '../../container.js';
import { withSystemTx } from '../../lib/db.js';
import { handleIncoming } from '../../modules/chatwoot/inbound.js';
import { claimEvent, markProcessed } from '../../modules/webhooks/idempotency.js';
import { ipAllowed, verifyChatwoot } from '../../modules/webhooks/verify.js';

export const chatwootWebhook =
  (c: Container): FastifyPluginAsync =>
  async (app) => {
    app.post('/chatwoot', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
      const e = env();
      if (e.CHATWOOT_ALLOWED_IPS.length > 0 ? !ipAllowed(req.ip, e.CHATWOOT_ALLOWED_IPS) : isProd()) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const ok = verifyChatwoot({
        secret: e.CHATWOOT_WEBHOOK_SECRET,
        rawBody: req.rawBody ?? Buffer.from(''),
        signature: req.headers['x-chatwoot-signature'] as string | undefined,
        timestamp: req.headers['x-chatwoot-timestamp'] as string | undefined,
        token: (req.query as { token?: string }).token,
      });
      if (!ok) return reply.code(401).send({ error: 'invalid_signature' });

      const parsed = chatwootWebhookSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });
      const evt = parsed.data;
      // Loop guard: only incoming contact messages.
      if (!isProcessableIncoming(evt) || !evt.id || !evt.conversation || !evt.inbox) return { status: 'ignored' };

      // Tenant resolution ONLY from inbox mapping.
      const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUnique({ where: { cwInboxId: evt.inbox!.id } }));
      if (!tenant) return { status: 'unknown_inbox' };

      const claim = await claimEvent(c.prisma, 'chatwoot', `msg:${evt.id}`, { id: evt.id, conversation: evt.conversation.id, inbox: evt.inbox.id }, tenant.id);
      if (!claim.first) return { status: 'duplicate' };
      try {
        const outcome = await handleIncoming(c, tenant, evt);
        await markProcessed(c.prisma, claim.id);
        return { status: outcome };
      } catch (err) {
        await markProcessed(c.prisma, claim.id, (err as Error).message);
        req.log.error({ err, tenantId: tenant.id }, 'chatwoot inbound failed');
        return { status: 'error' }; // 200 so Chatwoot does not hammer; failure is recorded
      }
    });
  };
