import { createChatwootClient, type ChatwootClient } from '@nextai/chatwoot-client';
import type { Tenant } from '@prisma/client';
import { env } from '../../config/env.js';
import { decrypt } from '../../lib/crypto.js';

/** The only place the Chatwoot bot token is decrypted. */
export function chatwootClientFor(tenant: Tenant): ChatwootClient {
  if (!tenant.cwAccountId || !tenant.cwInboxId || !tenant.cwBotTokenEnc) {
    throw new Error(`Tenant ${tenant.id} has no Chatwoot connection`);
  }
  const e = env();
  return createChatwootClient(
    {
      baseUrl: e.CHATWOOT_BASE_URL,
      accountId: tenant.cwAccountId,
      inboxId: tenant.cwInboxId,
      botToken: decrypt(tenant.cwBotTokenEnc, `cw_bot:${tenant.id}`),
    },
    { attachmentHosts: [new URL(e.CHATWOOT_BASE_URL).hostname, ...e.CHATWOOT_ATTACHMENT_HOSTS] },
  );
}
