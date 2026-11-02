import { tenantStatusFor, type BillingEvent } from '@nextai/payments';
import type { PlanCode, Prisma, Tenant, TenantStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import type { Container } from '../../container.js';
import { withSystemTx } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../audit/audit.js';
import { sendWhatsApp } from '../outbound/whatsapp.js';

const sys = <T>(c: Container, fn: (tx: Prisma.TransactionClient) => Promise<T>) => withSystemTx(c.prisma, fn);

/** Plan.providerPriceIds = { stripe: { INR: "price_..", AED: "price_.." } } */
export async function priceIdFor(c: Container, planCode: PlanCode, currency: string): Promise<string> {
  const plan = await c.prisma.plan.findUniqueOrThrow({ where: { code: planCode } });
  const id = (plan.providerPriceIds as Record<string, Record<string, string>>)?.[c.payments.name]?.[currency];
  if (!id) throw badRequest(`No ${c.payments.name} price configured for ${planCode}/${currency}`);
  return id;
}

async function planForPrice(c: Container, priceId: string | undefined) {
  if (!priceId) return null;
  const plans = await c.prisma.plan.findMany();
  return plans.find((p) => Object.values((p.providerPriceIds as Record<string, Record<string, string>>) ?? {}).some((byCur) => Object.values(byCur).includes(priceId))) ?? null;
}

export async function startCheckout(c: Container, tenant: Tenant, planCode: PlanCode, ownerEmail?: string) {
  let sub = await sys(c, (tx) => tx.subscription.findFirst({ where: { tenantId: tenant.id, provider: c.payments.name }, orderBy: { createdAt: 'desc' } }));
  if (!sub) {
    const { customerId } = await c.payments.createCustomer({ tenantId: tenant.id, name: tenant.name, email: ownerEmail });
    sub = await sys(c, (tx) => tx.subscription.create({ data: { tenantId: tenant.id, provider: c.payments.name, providerCustomerId: customerId, status: 'incomplete', planCode } }));
  }
  const trialLeft = tenant.status === 'trial' && tenant.trialEndsAt ? Math.ceil((tenant.trialEndsAt.getTime() - Date.now()) / 86400_000) : 0;
  return c.payments.createCheckout({
    tenantId: tenant.id,
    customerId: sub.providerCustomerId,
    priceId: await priceIdFor(c, planCode, tenant.currency),
    successUrl: `${env().APP_URL}/billing?status=success`,
    cancelUrl: `${env().APP_URL}/billing?status=cancelled`,
    trialDays: trialLeft > 0 && !sub.providerSubscriptionId ? Math.min(14, trialLeft) : undefined,
  });
}

export async function openPortal(c: Container, tenant: Tenant) {
  const sub = await sys(c, (tx) => tx.subscription.findFirst({ where: { tenantId: tenant.id, provider: c.payments.name }, orderBy: { createdAt: 'desc' } }));
  if (!sub) throw badRequest('No billing account yet — choose a plan first');
  return c.payments.createPortalSession(sub.providerCustomerId, `${env().APP_URL}/billing`);
}

async function setTenantStatus(c: Container, tenantId: string, status: TenantStatus, reason: string, extra: Prisma.TenantUpdateInput = {}) {
  const before = await sys(c, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
  const settings = { ...(before.settings as object), pastDueSince: status === 'past_due' ? ((before.settings as { pastDueSince?: string }).pastDueSince ?? new Date().toISOString()) : undefined };
  const after = await sys(c, (tx) => tx.tenant.update({ where: { id: tenantId }, data: { status, settings: settings as Prisma.InputJsonValue, ...extra } }));
  if (before.status !== status || extra.plan) {
    await audit(c.prisma, { tenantId, actorType: 'system', channel: 'system', action: 'billing.status', entity: 'tenant', entityId: tenantId, before: { status: before.status, planId: before.planId }, after: { status, planId: after.planId, reason } });
  }
  return { before, after };
}

async function notifyOwners(c: Container, tenant: Tenant, text: string) {
  const owners = await sys(c, (tx) => tx.user.findMany({ where: { tenantId: tenant.id, role: 'owner', status: { not: 'disabled' }, phone: { not: null } } }));
  for (const o of owners) {
    try {
      await sendWhatsApp(c, tenant, { kind: 'notice', phone: o.phone!, name: o.name, templateKey: 'billing_notice', params: [tenant.name, `${env().APP_URL}/billing`], fallbackText: text });
    } catch (err) {
      logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'billing notice failed');
    }
  }
}

/** Apply a verified, de-duplicated provider event to Subscription + Tenant.status. */
export async function applyBillingEvent(c: Container, evt: BillingEvent): Promise<string> {
  if (evt.kind === 'ignored') return 'ignored';
  const findSub = async () =>
    sys(c, (tx) =>
      tx.subscription.findFirst({
        where: { OR: [...('subscriptionId' in evt && evt.subscriptionId ? [{ providerSubscriptionId: evt.subscriptionId }] : []), { providerCustomerId: evt.customerId }] },
        orderBy: { createdAt: 'desc' },
      }),
    );
  let sub = await findSub();
  const tenantId = ('tenantId' in evt && evt.tenantId) || sub?.tenantId;
  if (!tenantId) {
    logger.warn({ kind: evt.kind, eventId: evt.eventId }, 'billing event for unknown tenant');
    return 'unknown_tenant';
  }
  if (!sub) {
    sub = await sys(c, (tx) => tx.subscription.create({ data: { tenantId, provider: c.payments.name, providerCustomerId: evt.customerId, status: 'incomplete' } }));
  }

  switch (evt.kind) {
    case 'checkout_completed':
      await sys(c, (tx) => tx.subscription.update({ where: { id: sub!.id }, data: { providerSubscriptionId: evt.subscriptionId ?? sub!.providerSubscriptionId } }));
      return 'linked';
    case 'subscription_updated': {
      const plan = await planForPrice(c, evt.priceId);
      await sys(c, (tx) =>
        tx.subscription.update({
          where: { id: sub!.id },
          data: { providerSubscriptionId: evt.subscriptionId, status: evt.status, currentPeriodEnd: evt.currentPeriodEnd, cancelAtPeriodEnd: evt.cancelAtPeriodEnd, planCode: plan?.code ?? sub!.planCode },
        }),
      );
      const status = tenantStatusFor(evt.status);
      const { before, after } = await setTenantStatus(c, tenantId, status, `subscription ${evt.status}`, plan ? { plan: { connect: { id: plan.id } } } : {});
      if (status === 'past_due' && before.status !== 'past_due') await notifyOwners(c, after, `⚠️ Your NextAi payment failed. Please update your card: ${env().APP_URL}/billing`);
      return status;
    }
    case 'subscription_deleted':
      await sys(c, (tx) => tx.subscription.update({ where: { id: sub!.id }, data: { status: 'canceled' } }));
      await setTenantStatus(c, tenantId, 'suspended', 'subscription deleted');
      return 'suspended';
    case 'invoice_paid': {
      const t = await sys(c, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
      if (t.status === 'past_due' || t.status === 'suspended') await setTenantStatus(c, tenantId, 'active', 'invoice paid');
      return 'active';
    }
    case 'invoice_payment_failed': {
      const { before, after } = await setTenantStatus(c, tenantId, 'past_due', 'invoice payment failed');
      if (before.status !== 'past_due') await notifyOwners(c, after, `⚠️ Your NextAi payment failed. Please update your card: ${env().APP_URL}/billing`);
      return 'past_due';
    }
  }
}

export const PAST_DUE_GRACE_DAYS = 7;

/** billing.sync (daily): expire trials without a subscription and suspend long past-due tenants. */
export async function billingSync(c: Container, now = new Date()) {
  const tenants = await sys(c, (tx) => tx.tenant.findMany({ where: { status: { in: ['trial', 'past_due'] } }, include: { subscriptions: true } }));
  let expired = 0;
  let suspended = 0;
  for (const t of tenants) {
    const live = t.subscriptions.some((s) => ['active', 'trialing'].includes(s.status));
    if (t.status === 'trial' && t.trialEndsAt && t.trialEndsAt < now && !live) {
      await setTenantStatus(c, t.id, 'past_due', 'trial ended');
      await notifyOwners(c, t, `Your NextAi trial has ended. Choose a plan to keep going: ${env().APP_URL}/billing`);
      expired++;
    } else if (t.status === 'past_due') {
      const since = (t.settings as { pastDueSince?: string }).pastDueSince;
      if (since && now.getTime() - Date.parse(since) > PAST_DUE_GRACE_DAYS * 86400_000) {
        await setTenantStatus(c, t.id, 'suspended', `past due > ${PAST_DUE_GRACE_DAYS} days`);
        suspended++;
      }
    }
  }
  return { expired, suspended };
}
