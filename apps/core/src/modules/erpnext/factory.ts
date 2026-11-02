import { createErpClient, type ErpClient } from '@nextai/erpnext-client';
import type { Tenant } from '@prisma/client';
import { decrypt } from '../../lib/crypto.js';

/** The only place ERPNext credentials are decrypted. AAD binds ciphertext to the tenant. */
export function erpClientFor(tenant: Tenant): ErpClient {
  if (!tenant.erpSiteUrl || !tenant.erpApiKeyEnc || !tenant.erpApiSecretEnc) {
    throw new Error(`Tenant ${tenant.id} has no ERPNext connection`);
  }
  return createErpClient({
    baseUrl: tenant.erpSiteUrl,
    apiKey: decrypt(tenant.erpApiKeyEnc, `erp_key:${tenant.id}`),
    apiSecret: decrypt(tenant.erpApiSecretEnc, `erp_secret:${tenant.id}`),
  });
}
