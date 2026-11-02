import type { PrismaClient } from '@prisma/client';
import { withTenantTx } from '../../lib/db.js';

export type UsageField = 'messages' | 'ocrPages' | 'aiTokens' | 'invoicesSent';
export const currentPeriod = (d = new Date()): string => d.toISOString().slice(0, 7);

export async function incrementUsage(
  prisma: PrismaClient,
  tenantId: string,
  inc: Partial<Record<UsageField, number>> & { aiCostMicros?: number },
): Promise<void> {
  const period = currentPeriod();
  const data = {
    messages: { increment: inc.messages ?? 0 },
    ocrPages: { increment: inc.ocrPages ?? 0 },
    aiTokens: { increment: inc.aiTokens ?? 0 },
    invoicesSent: { increment: inc.invoicesSent ?? 0 },
    aiCostMicros: { increment: BigInt(inc.aiCostMicros ?? 0) },
  };
  await withTenantTx(prisma, tenantId, (tx) =>
    tx.usageCounter.upsert({
      where: { tenantId_period: { tenantId, period } },
      update: data,
      create: {
        tenantId,
        period,
        messages: inc.messages ?? 0,
        ocrPages: inc.ocrPages ?? 0,
        aiTokens: inc.aiTokens ?? 0,
        invoicesSent: inc.invoicesSent ?? 0,
        aiCostMicros: BigInt(inc.aiCostMicros ?? 0),
      },
    }),
  );
}

export async function getUsage(prisma: PrismaClient, tenantId: string, period = currentPeriod()) {
  return withTenantTx(prisma, tenantId, (tx) => tx.usageCounter.findUnique({ where: { tenantId_period: { tenantId, period } } }));
}
