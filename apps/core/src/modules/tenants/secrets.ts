import { encrypt } from '../../lib/crypto.js';

/** Encrypt tenant secrets for storage. Use these helpers everywhere secrets are written. */
export const sealErpKey = (tenantId: string, v: string) => encrypt(v, `erp_key:${tenantId}`);
export const sealErpSecret = (tenantId: string, v: string) => encrypt(v, `erp_secret:${tenantId}`);
export const sealErpWebhookSecret = (tenantId: string, v: string) => encrypt(v, `erp_webhook:${tenantId}`);
export const sealCwBotToken = (tenantId: string, v: string) => encrypt(v, `cw_bot:${tenantId}`);
