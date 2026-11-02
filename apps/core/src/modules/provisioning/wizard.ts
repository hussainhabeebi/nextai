import { randomBytes } from 'node:crypto';
import type { Prisma, Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { withSystemTx } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import { audit } from '../audit/audit.js';
import { erpContext } from '../erpnext/mappers.js';
import { sealCwBotToken, sealErpKey, sealErpSecret, sealErpWebhookSecret } from '../tenants/secrets.js';
import { sendWhatsApp } from '../outbound/whatsapp.js';
import { env } from '../../config/env.js';

/**
 * Provisioning wizard. Each step is idempotent and individually retryable; progress is stored in
 * tenant.settings.provisioning so the admin UI can resume. Order matters.
 */
export const PROVISION_STEPS = [
  'erp_site', // bench new-site + install erpnext (+ india_compliance for IN) + enable scheduler + host_name
  'erp_api_user', // nextai-bot user + API keys → encrypted on tenant
  'erp_company', // company, country, currency, chart of accounts, tax templates
  'tunnel_hostname', // Cloudflare Tunnel public hostname for the site
  'chatwoot_inbox', // map WhatsApp inbox + Agent Bot token
  'erp_webhooks', // per-tenant HMAC secret for Sales Invoice / Payment Entry on_submit
  'test_connections',
  'invite_owner',
] as const;
export type ProvisionStep = (typeof PROVISION_STEPS)[number];

export interface StepInput {
  chatwoot?: { accountId: number; inboxId: number; botToken: string };
}

type Progress = Record<string, { status: 'done' | 'failed' | 'manual'; at: string; note?: string }>;

const siteFor = (t: Tenant) => `${t.slug}.nextaierp.com`;

async function saveProgress(c: Container, tenant: Tenant, step: string, p: Progress[string], extra: Prisma.TenantUpdateInput = {}) {
  const settings = (tenant.settings ?? {}) as Record<string, unknown>;
  const provisioning = { ...((settings.provisioning as Progress) ?? {}), [step]: p };
  return withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: tenant.id }, data: { ...extra, settings: { ...settings, provisioning } as Prisma.InputJsonValue } }));
}

export async function runProvisionStep(c: Container, tenantId: string, step: ProvisionStep, input: StepInput, adminId: string): Promise<{ tenant: Tenant; note: string; status: string }> {
  let tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
  const site = siteFor(tenant);
  let note = '';
  let status: 'done' | 'manual' = 'done';
  let extra: Prisma.TenantUpdateInput = {};
  try {
    switch (step) {
      case 'erp_site': {
        await c.provisioner.run({ op: 'new-site', site, adminPassword: randomBytes(18).toString('base64url') });
        await c.provisioner.run({ op: 'install-app', site, app: 'erpnext' });
        if (tenant.country === 'IN') await c.provisioner.run({ op: 'install-app', site, app: 'india_compliance' });
        await c.provisioner.run({ op: 'enable-scheduler', site });
        await c.provisioner.run({ op: 'set-config', site, key: 'host_name', value: `https://${site}` });
        extra = { erpSiteUrl: `https://${site}` };
        note = `Site ${site} created`;
        break;
      }
      case 'erp_api_user': {
        const r = await c.provisioner.run({ op: 'create-api-user', site, email: `nextai-bot@${site}` });
        if (!r.data?.apiKey || !r.data.apiSecret) throw new Error('Provisioner did not return API keys');
        extra = { erpApiKeyEnc: sealErpKey(tenant.id, r.data.apiKey), erpApiSecretEnc: sealErpSecret(tenant.id, r.data.apiSecret) };
        note = 'nextai-bot API keys stored (encrypted)';
        break;
      }
      case 'erp_company': {
        const ctx = erpContext(tenant);
        const erp = c.erp(tenant);
        const existing = await erp.list('Company', { filters: [['name', '=', ctx.company]], limit: 1 });
        if (existing.length === 0) {
          await erp.create('Company', {
            company_name: ctx.company,
            abbr: ctx.abbr,
            country: tenant.country === 'IN' ? 'India' : 'United Arab Emirates',
            default_currency: tenant.currency,
            create_chart_of_accounts_based_on: 'Standard Template',
            chart_of_accounts: 'Standard',
          });
        }
        // Tax templates: India Compliance creates GST templates on company setup.
        // TODO(erpnext): create "UAE VAT 5% - ABBR" Purchase/Sales Taxes and Charges Templates for AE tenants.
        note = `Company ${ctx.company} (${ctx.abbr}) ready`;
        break;
      }
      case 'tunnel_hostname':
        // TODO(cloudflare): add a public hostname via the Cloudflare API, or rely on the wildcard *.nextaierp.com tunnel route.
        status = 'manual';
        note = `Ensure ${site} routes through the Cloudflare Tunnel (wildcard route recommended).`;
        break;
      case 'chatwoot_inbox': {
        if (!input.chatwoot) throw badRequest('Chatwoot accountId, inboxId and Agent Bot token are required');
        // Inbox creation for WhatsApp requires the channel provider credentials and is done in Chatwoot; we map it here.
        extra = { cwAccountId: input.chatwoot.accountId, cwInboxId: input.chatwoot.inboxId, cwBotTokenEnc: sealCwBotToken(tenant.id, input.chatwoot.botToken) };
        note = `Inbox ${input.chatwoot.inboxId} mapped. Agent Bot outgoing URL: ${env().API_URL}/webhooks/chatwoot?token=<CHATWOOT_WEBHOOK_SECRET>`;
        break;
      }
      case 'erp_webhooks': {
        const secret = randomBytes(24).toString('base64url');
        extra = { erpWebhookSecretEnc: sealErpWebhookSecret(tenant.id, secret) };
        // TODO(erpnext): create the two Webhook docs via the API once the doctype payload is validated on v16.
        status = 'manual';
        note = `Create ERPNext Webhooks (Sales Invoice, Payment Entry → on_submit) to ${env().API_URL}/webhooks/erpnext/${tenant.slug} with this secret (shown once): ${secret}`;
        break;
      }
      case 'test_connections': {
        const ping = await c.erp(tenant).ping();
        if (!ping.ok) throw new Error('ERPNext ping failed');
        if (!tenant.cwBotTokenEnc) throw new Error('Chatwoot not mapped');
        note = `ERPNext OK (${ping.latencyMs} ms as ${ping.user})`;
        break;
      }
      case 'invite_owner': {
        const owner = await withSystemTx(c.prisma, (tx) => tx.user.findFirst({ where: { tenantId: tenant.id, role: 'owner' } }));
        if (!owner?.phone) throw new Error('Owner phone missing');
        await sendWhatsApp(c, tenant, {
          kind: 'notice',
          phone: owner.phone,
          name: owner.name,
          templateKey: 'billing_notice',
          params: [tenant.name, env().APP_URL],
          fallbackText: `Welcome to NextAi, ${owner.name}! Send your first bill photo here, or open ${env().APP_URL} to see your books.`,
        });
        note = 'Owner invited on WhatsApp';
        break;
      }
    }
    tenant = await saveProgress(c, tenant, step, { status, at: new Date().toISOString(), note: step === 'erp_webhooks' ? 'Secret generated; configure webhooks in ERPNext' : note }, extra);
    await audit(c.prisma, { tenantId: tenant.id, actorId: adminId, actorType: 'admin', channel: 'admin', action: `provision.${step}`, entity: 'tenant', entityId: tenant.id, after: { status } });
    return { tenant, note, status };
  } catch (err) {
    await saveProgress(c, tenant, step, { status: 'failed', at: new Date().toISOString(), note: (err as Error).message.slice(0, 300) });
    await audit(c.prisma, { tenantId: tenant.id, actorId: adminId, actorType: 'admin', channel: 'admin', action: `provision.${step}.failed`, entity: 'tenant', entityId: tenant.id, after: { error: (err as Error).message.slice(0, 300) } });
    throw err;
  }
}
