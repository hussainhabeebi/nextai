import { planLimitsSchema } from '@nextai/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { withSystemTx } from '../../lib/db.js';
import { forbidden } from '../../lib/errors.js';
import { audit } from '../../modules/audit/audit.js';
import { planLimits, usageFor } from '../../modules/billing/gating.js';
import { openPortal, startCheckout } from '../../modules/billing/service.js';

export const billingRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/billing', { schema: { tags: ['billing'] } }, async (req) => {
      const t = req.tenant!;
      const [plan, plans, sub, limits] = await Promise.all([
        t.planId ? c.prisma.plan.findUnique({ where: { id: t.planId } }) : null,
        c.prisma.plan.findMany({ where: { active: true }, orderBy: { code: 'asc' } }),
        withSystemTx(c.prisma, (tx) => tx.subscription.findFirst({ where: { tenantId: t.id }, orderBy: { createdAt: 'desc' } })),
        planLimits(c, t),
      ]);
      const [users, ocrPages, invoicesSent, messages] = await Promise.all(
        (['users', 'ocrPagesPerMonth', 'invoicesSentPerMonth', 'messagesPerMonth'] as const).map((k) => usageFor(c, t, k)),
      );
      return {
        status: t.status,
        currency: t.currency,
        trialEndsAt: t.trialEndsAt,
        plan: plan && { code: plan.code, name: plan.name },
        subscription: sub && sub.providerSubscriptionId ? { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd } : null,
        usage: { users, ocrPages, invoicesSent, messages },
        limits,
        plans: plans.map((p) => {
          const l = planLimitsSchema.parse(p.limits);
          return { code: p.code, name: p.name, price: (p.priceMonthly as Record<string, number>)[t.currency] ?? 0, features: l.features, limits: l };
        }),
      };
    });

    app.post('/billing/checkout', { schema: { tags: ['billing'], body: z.object({ plan: z.enum(['starter', 'business', 'pro']) }) } }, async (req) => {
      if (req.user!.role !== 'owner') throw forbidden('Only the owner can change the plan');
      const owner = await req.db!.user.findUnique({ where: { id: req.user!.sub } });
      const r = await startCheckout(c, req.tenant!, req.body.plan, owner?.email ?? undefined);
      await audit(c.prisma, { tenantId: req.tenant!.id, actorId: req.user!.sub, actorType: 'user', channel: 'app', action: 'billing.checkout', entity: 'plan', entityId: req.body.plan, ip: req.ip });
      return { url: r.url };
    });

    app.post('/billing/portal', { schema: { tags: ['billing'] } }, async (req) => {
      if (req.user!.role !== 'owner') throw forbidden('Only the owner can manage billing');
      return openPortal(c, req.tenant!);
    });
  };
