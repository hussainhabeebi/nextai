import type { ChatwootClient } from '@nextai/chatwoot-client';
import type { ErpClient } from '@nextai/erpnext-client';
import type { PaymentProvider } from '@nextai/payments';
import type { PrismaClient, Tenant } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { AiProviders } from './ai/index.js';
import type { ConversationStore } from './state/conversation.js';
import type { ObjectStorage } from './storage/storage.js';
import type { JobQueue } from './lib/queue.js';
import type { ProvisionerClient } from './modules/provisioning/provisioner-client.js';

/** Everything with side effects lives here so tests can swap in fakes. */
export interface Container {
  prisma: PrismaClient;
  redis: Redis;
  storage: ObjectStorage;
  ai: AiProviders;
  queue: JobQueue;
  conversations: ConversationStore;
  /** Decrypts tenant secrets internally; never exposes them. */
  erp: (tenant: Tenant) => ErpClient;
  chatwoot: (tenant: Tenant) => ChatwootClient;
  payments: PaymentProvider;
  provisioner: ProvisionerClient;
}
