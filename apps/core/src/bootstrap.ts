import { FakeChatwootClient } from '@nextai/chatwoot-client/testing';
import { FakeErpClient } from '@nextai/erpnext-client/testing';
import { StripeProvider } from '@nextai/payments';
import { FakePaymentProvider } from '@nextai/payments/testing';
import { createAiProviders } from './ai/index.js';
import { env } from './config/env.js';
import type { Container } from './container.js';
import { createPrisma } from './lib/db.js';
import { BullJobQueue } from './lib/queue.js';
import { chatwootClientFor } from './modules/chatwoot/factory.js';
import { erpClientFor } from './modules/erpnext/factory.js';
import { FakeProvisionerClient, HttpProvisionerClient } from './modules/provisioning/provisioner-client.js';
import { RedisConversationStore } from './state/conversation.js';
import { createRedis } from './state/redis.js';
import { LocalFsStorage, R2Storage } from './storage/storage.js';
import { resolve } from 'node:path';

/** Build the production container from env. */
export function createContainer(): Container & { close: () => Promise<void> } {
  const e = env();
  const prisma = createPrisma();
  const redis = createRedis(e.REDIS_URL);
  const queue = new BullJobQueue(redis);
  const storage =
    e.R2_ACCOUNT_ID && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY
      ? new R2Storage(e.R2_ACCOUNT_ID, e.R2_ACCESS_KEY_ID, e.R2_SECRET_ACCESS_KEY, e.R2_BUCKET)
      : new LocalFsStorage(resolve(process.env.LOCAL_STORAGE_DIR ?? '.data/storage'), e.API_URL, e.JWT_REFRESH_SECRET);
  // MOCK_EXTERNALS=true lets the whole stack run locally without ERPNext/Chatwoot.
  const fakeErp = new Map<string, FakeErpClient>();
  const fakeCw = new Map<string, FakeChatwootClient>();
  return {
    prisma,
    redis,
    queue,
    storage,
    ai: createAiProviders(e),
    conversations: new RedisConversationStore(redis),
    erp: e.MOCK_EXTERNALS ? (t) => fakeErp.get(t.id) ?? fakeErp.set(t.id, new FakeErpClient()).get(t.id)! : erpClientFor,
    chatwoot: e.MOCK_EXTERNALS ? (t) => fakeCw.get(t.id) ?? fakeCw.set(t.id, new FakeChatwootClient()).get(t.id)! : chatwootClientFor,
    payments:
      e.STRIPE_SECRET_KEY && e.STRIPE_WEBHOOK_SECRET ? new StripeProvider(e.STRIPE_SECRET_KEY, e.STRIPE_WEBHOOK_SECRET) : new FakePaymentProvider(),
    provisioner: e.PROVISIONER_URL && e.PROVISIONER_SECRET ? new HttpProvisionerClient(e.PROVISIONER_URL, e.PROVISIONER_SECRET) : new FakeProvisionerClient(),
    close: async () => {
      await queue.close();
      redis.disconnect();
      await prisma.$disconnect();
    },
  };
}
