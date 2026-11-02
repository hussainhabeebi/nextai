import { planLimitsSchema, type Feature, type PlanLimits } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import { env } from '../../config/env.js';
import type { Container } from '../../container.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import { paymentRequired } from '../../lib/errors.js';
import { getUsage } from '../usage/usage.js';

const FALLBACK: PlanLimits = { users: 1, ocrPagesPerMonth: 20, invoicesSentPerMonth: 10, messagesPerMonth: 200, features: [] };

export async function planLimits(c: Container, tenant: Tenant): Promise<PlanLimits> {
  if (!tenant.planId) return FALLBACK;
  const plan = await c.prisma.plan.findUnique({ where: { id: tenant.planId } });
  return plan ? planLimitsSchema.parse(plan.limits) : FALLBACK;
}

/** Plan feature OR per-tenant feature flag (admin-managed) enables a feature. */
export async function hasFeature(c: Container, tenant: Tenant, feature: Feature): Promise<boolean> {
  const limits = await planLimits(c, tenant);
  if (limits.features.includes(feature)) return true;
  const flags = await withSystemTx(c.prisma, (tx) =>
    tx.featureFlag.findMany({ where: { key: `feature:${feature}`, OR: [{ tenantId: tenant.id }, { tenantId: null }] } }),
  );
  const specific = flags.find((f) => f.tenantId === tenant.id);
  return (specific ?? flags.find((f) => f.tenantId === null))?.enabled ?? false;
}

export async function requireFeature(c: Container, tenant: Tenant, feature: Feature): Promise<void> {
  if (!(await hasFeature(c, tenant, feature))) {
    throw paymentRequired(`Your plan does not include ${feature.replace('_', ' ')}. Upgrade to unlock it.`, { feature, upgradeUrl: `${env().APP_URL}/billing` });
  }
}

export type LimitKey = 'users' | 'ocrPagesPerMonth' | 'invoicesSentPerMonth' | 'messagesPerMonth';

export async function usageFor(c: Container, tenant: Tenant, key: LimitKey): Promise<number> {
  if (key === 'users') return tenantDb(c.prisma, tenant.id).user.count({ where: { status: { not: 'disabled' } } });
  const u = await getUsage(c.prisma, tenant.id);
  if (!u) return 0;
  return key === 'ocrPagesPerMonth' ? u.ocrPages : key === 'invoicesSentPerMonth' ? u.invoicesSent : u.messages;
}

export async function assertWithinLimit(c: Container, tenant: Tenant, key: LimitKey): Promise<void> {
  const limits = await planLimits(c, tenant);
  const used = await usageFor(c, tenant, key);
  if (used >= limits[key]) {
    throw paymentRequired(`Plan limit reached for ${key}`, { key, used, limit: limits[key], upgradeUrl: `${env().APP_URL}/billing` });
  }
}
