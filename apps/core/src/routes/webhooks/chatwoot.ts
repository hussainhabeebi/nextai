import { chatwootWebhookSchema, isProcessableIncoming } from '@nextai/chatwoot-client';
import type { FastifyPluginAsync } from 'fastify';
import { env, isProd } from '../../config/env.js';
import type { Container } from '../../container.js';
import { withSystemTx } from '../../lib/db.js';
import { handleIncoming } from '../../modules/chatwoot/inbound.js';
import { claimEvent, markProcessed } from '../../modules/webhooks/idempotency.js';
import { ipAllowed, verifyChatwoot } from '../../modules/webhooks/verify.js';
import { traceWebhook } from '../../modules/chatwoot/diagnostics.js';

export const chatwootWebhook =
  (c: Container): FastifyPluginAsync =>
  async (app) => {
    app.post('/chatwoot', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
      const e = env();
      if (e.CHATWOOT_ALLOWED_IPS.length > 0 ? !ipAllowed(req.ip, e.CHATWOOT_ALLOWED_IPS) : isProd()) {
        // Logged so the right value for CHATWOOT_ALLOWED_IPS can be read from the core logs.
        req.log.warn({ ip: req.ip, forwardedFor: req.headers['x-forwarded-for'] }, 'chatwoot webhook rejected: ip not in CHATWOOT_ALLOWED_IPS');
        await traceWebhook(c.redis, {
          result: 'ip_rejected',
          ip: req.ip,
          detail: e.CHATWOOT_ALLOWED_IPS.length ? `IP ${req.ip} is not in CHATWOOT_ALLOWED_IPS` : 'CHATWOOT_ALLOWED_IPS is empty (required in production)',
        });
        return reply.code(403).send({ error: 'forbidden' });
      }
      const ok = verifyChatwoot({
        secret: e.CHATWOOT_WEBHOOK_SECRET,
        rawBody: req.rawBody ?? Buffer.from(''),
        signature: req.headers['x-chatwoot-signature'] as string | undefined,
        timestamp: req.headers['x-chatwoot-timestamp'] as string | undefined,
        token: (req.query as { token?: string }).token,
      });
      if (!ok) {
        const hasToken = !!(req.query as { token?: string }).token;
        await traceWebhook(c.redis, {
          result: 'bad_token',
          ip: req.ip,
          detail: hasToken
            ? 'The token in the Agent Bot URL does not match CHATWOOT_WEBHOOK_SECRET'
            : 'The Agent Bot URL has no ?token= (or the signature is wrong)',
        });
        return reply.code(401).send({ error: 'invalid_signature' });
      }

      const parsed = chatwootWebhookSchema.safeParse(req.body);
      if (!parsed.success) {
        // 200, not 400: an error makes Chatwoot flag the agent bot and reopen the conversation.
        req.log.warn({ issues: parsed.error.issues.slice(0, 5) }, 'chatwoot webhook: unexpected payload, ignored');
        await traceWebhook(c.redis, { result: 'invalid_payload', ip: req.ip, detail: parsed.error.issues[0]?.message });
        return { status: 'ignored', reason: 'invalid_payload' };
      }
      const evt = parsed.data;
      // Loop guard: only incoming contact messages.
      if (!isProcessableIncoming(evt) || !evt.id || !evt.conversation || !evt.inbox) return { status: 'ignored' };

      // Tenant resolution ONLY from inbox mapping.
      const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUnique({ where: { cwInboxId: evt.inbox!.id } }));
      if (!tenant) {
        await traceWebhook(c.redis, { result: 'unknown_inbox', ip: req.ip, inboxId: evt.inbox.id, detail: `Inbox ${evt.inbox.id} is not connected to any business` });
        return { status: 'unknown_inbox' };
      }
      await traceWebhook(c.redis, { result: 'accepted', ip: req.ip, inboxId: evt.inbox.id, detail: tenant.name });

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
