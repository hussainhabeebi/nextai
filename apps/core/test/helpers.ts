import { FakeChatwootClient } from '@nextai/chatwoot-client/testing';
import { FakeErpClient } from '@nextai/erpnext-client/testing';
import { FakePaymentProvider } from '@nextai/payments/testing';
import { tenantSettingsSchema } from '@nextai/shared';
import type { PrismaClient, Tenant } from '@prisma/client';
import { Redis } from 'ioredis';
import { MockLlm, MockStt, MockVision } from '../src/ai/mock.js';
import type { Container } from '../src/container.js';
import { createPrisma, withSystemTx } from '../src/lib/db.js';
import { MemoryJobQueue } from '../src/lib/queue.js';
import { FakeProvisionerClient } from '../src/modules/provisioning/provisioner-client.js';
import { sealCwBotToken, sealErpKey, sealErpSecret } from '../src/modules/tenants/secrets.js';
import { MemoryConversationStore } from '../src/state/conversation.js';
import { MemoryStorage } from '../src/storage/storage.js';

export interface TestContainer extends Container {
  queue: MemoryJobQueue;
  storage: MemoryStorage;
  conversations: MemoryConversationStore;
  payments: FakePaymentProvider;
  provisioner: FakeProvisionerClient;
  erps: Map<string, FakeErpClient>;
  cws: Map<string, FakeChatwootClient>;
  close(): Promise<void>;
}

let shared: { prisma: PrismaClient; redis: Redis } | undefined;

export function testContainer(): TestContainer {
  shared ??= { prisma: createPrisma(), redis: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }) };
  const erps = new Map<string, FakeErpClient>();
  const cws = new Map<string, FakeChatwootClient>();
  return {
    ...shared,
    queue: new MemoryJobQueue(),
    storage: new MemoryStorage(),
    conversations: new MemoryConversationStore(),
    ai: { vision: new MockVision(), stt: new MockStt(), llm: new MockLlm() },
    erp: (t: Tenant) => erps.get(t.id) ?? erps.set(t.id, new FakeErpClient()).get(t.id)!,
    chatwoot: (t: Tenant) => cws.get(t.id) ?? cws.set(t.id, new FakeChatwootClient()).get(t.id)!,
    payments: new FakePaymentProvider(),
    provisioner: new FakeProvisionerClient(),
    erps,
    cws,
    close: async () => {},
  };
}

export async function closeShared() {
  if (shared) {
    shared.redis.disconnect();
    await shared.prisma.$disconnect();
    shared = undefined;
  }
}

let inbox = 1000;
export async function createTenant(
  prisma: PrismaClient,
  over: Partial<{ name: string; slug: string; country: 'IN' | 'AE'; currency: string; ownerPhone: string; settings: Record<string, unknown> }> = {},
) {
  const slug = over.slug ?? `t-${Math.random().toString(36).slice(2, 8)}`;
  const cwInboxId = ++inbox + Math.floor(Math.random() * 100000);
  return withSystemTx(prisma, async (tx) => {
    const plan = await tx.plan.findUnique({ where: { code: 'business' } });
    const t = await tx.tenant.create({
      data: {
        name: over.name ?? `Tenant ${slug}`,
        slug,
        country: over.country ?? 'IN',
        currency: over.currency ?? 'INR',
        status: 'active',
        planId: plan?.id,
        erpSiteUrl: `https://${slug}.nextaierp.com`,
        cwAccountId: 1,
        cwInboxId,
        settings: tenantSettingsSchema.parse({ erpCompany: `Co ${slug}`, ...(over.settings ?? {}) }),
      },
    });
    const updated = await tx.tenant.update({
      where: { id: t.id },
      data: { erpApiKeyEnc: sealErpKey(t.id, 'k'), erpApiSecretEnc: sealErpSecret(t.id, 's'), cwBotTokenEnc: sealCwBotToken(t.id, 'bot') },
    });
    const owner = await tx.user.create({
      data: { tenantId: t.id, phone: over.ownerPhone ?? `+9198${Math.floor(10000000 + Math.random() * 89999999)}`, name: 'Owner', role: 'owner' },
    });
    return { tenant: updated, owner };
  });
}
