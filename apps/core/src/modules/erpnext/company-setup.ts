import { createErpClient, type ErpClient } from '@nextai/erpnext-client';
import type { Prisma, Tenant } from '@prisma/client';
import { env } from '../../config/env.js';
import type { Container } from '../../container.js';
import { withSystemTx } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { sealErpKey, sealErpSecret } from '../tenants/secrets.js';
import { clearAccountCache } from './mappers.js';

const COUNTRY_NAME = { IN: 'India', AE: 'United Arab Emirates' } as const;

/** Initials of the business name (max 5), unique among the site's company abbreviations. */
export function uniqueAbbr(name: string, taken: Set<string>): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  let base = (words.length > 1 ? words.map((w) => w[0]) : [...(words[0] ?? 'CO').slice(0, 3)]).join('').toUpperCase().slice(0, 5) || 'CO';
  if (!/^[A-Z]/.test(base)) base = `C${base}`.slice(0, 5);
  const upper = new Set([...taken].map((a) => a.toUpperCase()));
  if (!upper.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!upper.has(`${base}${i}`)) return `${base}${i}`;
  return `${base}${Date.now() % 100000}`;
}

/** Shared-site client (self-signup), or undefined when the platform has no shared ERPNext configured. */
export function sharedErp(): { client: ErpClient; url: string; key: string; secret: string } | undefined {
  const e = env();
  if (!e.ERPNEXT_SHARED_URL || !e.ERPNEXT_SHARED_API_KEY || !e.ERPNEXT_SHARED_API_SECRET) return undefined;
  const url = e.ERPNEXT_SHARED_URL.replace(/\/+$/, '');
  return {
    url,
    key: e.ERPNEXT_SHARED_API_KEY,
    secret: e.ERPNEXT_SHARED_API_SECRET,
    client: createErpClient({ baseUrl: url, apiKey: e.ERPNEXT_SHARED_API_KEY, apiSecret: e.ERPNEXT_SHARED_API_SECRET }),
  };
}

type Company = { name: string; abbr: string; company_description?: string | null };

/**
 * tenant.setup: give a self-signed-up client its own company in the shared ERPNext site.
 * ERPNext creates the chart of accounts, default accounts and (UAE / India Compliance) tax templates on insert.
 * Idempotent: the company carries a `nextai:<tenantId>` marker, so a retry reuses it instead of duplicating.
 */
export async function setupTenantErp(c: Container, tenantId: string, erpOverride?: ErpClient): Promise<{ status: string; note: string }> {
  const tenant: Tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
  if (tenant.erpApiKeyEnc) return { status: 'skipped', note: 'ERPNext already connected' };
  const shared = sharedErp();
  if (!shared) return save(c, tenant, {}, 'manual', 'No shared ERPNext configured: connect ERPNext in Admin → Integrations');
  const erp = erpOverride ?? shared.client;

  const marker = `nextai:${tenant.id}`;
  const companies = await erp.list<Company>('Company', { fields: ['name', 'abbr', 'company_description'], limit: 1000 });
  let company = companies.find((co) => (co.company_description ?? '').includes(marker));
  if (!company) {
    const taken = new Set(companies.map((co) => co.name.toLowerCase()));
    const name = taken.has(tenant.name.toLowerCase()) ? `${tenant.name} (${tenant.slug})` : tenant.name;
    const abbr = uniqueAbbr(tenant.name, new Set(companies.map((co) => co.abbr)));
    const created = await erp.create<Company>('Company', {
      company_name: name,
      abbr,
      country: COUNTRY_NAME[tenant.country],
      default_currency: tenant.currency,
      create_chart_of_accounts_based_on: 'Standard Template',
      chart_of_accounts: 'Standard',
      company_description: `Created by NextAi signup (${marker})`,
    });
    company = { name: created.name ?? name, abbr: created.abbr ?? abbr };
  }

  const warnings: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const fy = await erp.list('Fiscal Year', { filters: [['year_start_date', '<=', today], ['year_end_date', '>=', today]], fields: ['name'], limit: 1 });
  if (fy.length === 0) warnings.push(`no Fiscal Year covering ${today} on the shared site`);
  const tpl = tenant.country === 'AE' ? `UAE VAT 5% - ${company.abbr}` : `Input GST In-state - ${company.abbr}`;
  const hasTpl = await erp.list('Purchase Taxes and Charges Template', { filters: [['name', '=', tpl]], limit: 1 });
  if (hasTpl.length === 0) warnings.push(`tax template "${tpl}" missing${tenant.country === 'IN' ? ' (install India Compliance on the shared site)' : ''}`);

  const note = `Company ${company.name} (${company.abbr}) on ${shared.url}${warnings.length ? `; warning: ${warnings.join('; ')}` : ''}`;
  return save(
    c,
    tenant,
    {
      erpSiteUrl: shared.url,
      erpApiKeyEnc: sealErpKey(tenant.id, shared.key),
      erpApiSecretEnc: sealErpSecret(tenant.id, shared.secret),
      settings: { erpCompany: company.name, companyAbbr: company.abbr },
    },
    'done',
    note,
  );
}

async function save(
  c: Container,
  tenant: Tenant,
  data: { erpSiteUrl?: string; erpApiKeyEnc?: string; erpApiSecretEnc?: string; settings?: Record<string, unknown> },
  status: 'done' | 'manual',
  note: string,
) {
  const current = (tenant.settings ?? {}) as Record<string, unknown>;
  const provisioning = { ...((current.provisioning as object) ?? {}), erp_company: { status, at: new Date().toISOString(), note } };
  // Merge, don't re-parse: the settings schema would strip keys it doesn't know (e.g. provisioning progress).
  const settings = { ...current, ...(data.settings ?? {}), provisioning };
  await withSystemTx(c.prisma, (tx) =>
    tx.tenant.update({
      where: { id: tenant.id },
      data: {
        erpSiteUrl: data.erpSiteUrl,
        erpApiKeyEnc: data.erpApiKeyEnc,
        erpApiSecretEnc: data.erpApiSecretEnc,
        settings: settings as Prisma.InputJsonValue,
      },
    }),
  );
  clearAccountCache(tenant.id);
  logger.info({ tenantId: tenant.id, status, note }, 'tenant ERPNext setup');
  return { status, note };
}
