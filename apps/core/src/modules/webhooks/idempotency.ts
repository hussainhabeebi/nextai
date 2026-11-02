import { Prisma, type PrismaClient, type WebhookSource } from '@prisma/client';
import { withSystemTx } from '../../lib/db.js';

/** Returns true if this is the first time we see the event (and records it); false for duplicates. */
export async function claimEvent(
  prisma: PrismaClient,
  source: WebhookSource,
  externalId: string,
  payload: unknown,
  tenantId?: string,
): Promise<{ first: boolean; id?: string }> {
  try {
    const ev = await withSystemTx(prisma, (tx) =>
      tx.webhookEvent.create({ data: { source, externalId: `${source}:${externalId}`, tenantId, payload: payload as Prisma.InputJsonValue } }),
    );
    return { first: true, id: ev.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { first: false };
    throw err;
  }
}

export async function markProcessed(prisma: PrismaClient, id: string | undefined, error?: string): Promise<void> {
  if (!id) return;
  await withSystemTx(prisma, (tx) => tx.webhookEvent.update({ where: { id }, data: { processedAt: new Date(), error: error?.slice(0, 1000) } }));
}
