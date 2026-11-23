import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { withSystemTx } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../modules/audit/audit.js';

/**
 * The team's separate WhatsApp number (a second Chatwoot inbox) for a business's virtual office. Connected by
 * NextAi support, like the customer inbox: a business must not be able to point at an inbox it does not own.
 * Everything else about the office and the sales pipeline is managed by the business owner in the app.
 */
export const staffInboxRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    app.put(
      '/tenants/:id/staff-inbox',
      {
        onRequest: app.requireAdmin(['super_admin', 'support']),
        schema: { tags: ['admin'], params: z.object({ id: z.string().uuid() }), body: z.object({ inboxId: z.number().int().positive().nullable() }) },
      },
      async (req) => {
        const t = await withSystemTx(c.prisma, (tx) => tx.tenant.findUnique({ where: { id: req.params.id } }));
        if (!t) throw notFound('Tenant');
        if (req.body.inboxId !== null && req.body.inboxId === t.cwInboxId) throw badRequest('The staff number must be a different inbox from the customer number.');
        try {
          await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: t.id }, data: { cwStaffInboxId: req.body.inboxId } }));
        } catch {
          throw badRequest('That inbox is already connected to another business.');
        }
        await audit(c.prisma, { tenantId: t.id, actorId: req.admin!.sub, actorType: 'admin', channel: 'admin', action: 'tenant.staff_inbox', entity: 'tenant', entityId: t.id, before: { inboxId: t.cwStaffInboxId }, after: { inboxId: req.body.inboxId }, ip: req.ip });
        return { inboxId: req.body.inboxId };
      },
    );
  };
