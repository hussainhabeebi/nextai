import { normalizePhone, tenantSettingsSchema } from '@nextai/shared';
import type { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { Container } from '../../container.js';
import { decrypt } from '../../lib/crypto.js';
import { withSystemTx } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../modules/audit/audit.js';
import {
  ChatwootAdminError,
  connectInbox,
  listInboxes,
  verifyBotToken,
} from '../../modules/chatwoot/admin-api.js';
import { reportEmail } from '../../modules/email/templates.js';
import { emailDailySummary, reportRecipients, sendAdminDailyReport } from '../../modules/email/reports.js';
import { summaryFigures } from '../../modules/outbound/jobs.js';
import { sendWhatsApp } from '../../modules/outbound/whatsapp.js';
import { runProvisionStep } from '../../modules/provisioning/wizard.js';
import { readWebhookTraces } from '../../modules/chatwoot/diagnostics.js';
import { clearAccountCache } from '../../modules/erpnext/mappers.js';
import { sealErpKey, sealErpSecret } from '../../modules/tenants/secrets.js';
import { ErpError } from '@nextai/erpnext-client';
import { R2Storage } from '../../storage/storage.js';

const uuidParam = z.object({ id: z.string().uuid() });
const accountId = z.coerce.number().int().positive();
const inboxId = z.coerce.number().int().positive();

/** Turn upstream errors into 400s the admin UI can show, without leaking tokens. */
async function upstream<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof ChatwootAdminError) throw badRequest(err.message);
    if ((err as Error).name === 'MailError') throw badRequest((err as Error).message);
    if ((err as Error).name === 'TimeoutError') throw badRequest('Upstream timed out');
    if (err instanceof ErpError) throw badRequest(`ERPNext: ${err.userMessage}`);
    if (err instanceof TypeError && /fetch/i.test(err.message)) throw badRequest('Could not reach the server (check the URL)');
    throw err;
  }
}

/**
 * Admin → Integrations: status of every external service (never secrets), Chatwoot inbox connect/test
 * per tenant, Resend email test and report recipients.
 */
export const integrationRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    const anyAdmin = { onRequest: app.requireAdmin() };
    const superOnly = { onRequest: app.requireAdmin(['super_admin']) };
    const ops = { onRequest: app.requireAdmin(['super_admin', 'support']) };
    const sys = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => withSystemTx(c.prisma, fn);
    const adminAudit = (
      req: FastifyRequest,
      action: string,
      entityId?: string,
      after?: unknown,
      tenantId?: string,
    ) =>
      audit(c.prisma, {
        tenantId,
        actorId: req.admin!.sub,
        actorType: 'admin',
        channel: 'admin',
        action,
        entity: 'integration',
        entityId,
        after,
        ip: req.ip,
      });
    const loadTenant = async (id: string) =>
      (await sys((tx) => tx.tenant.findUnique({ where: { id } }))) ?? Promise.reject(notFound('Tenant'));

    app.get('/integrations', { ...anyAdmin, schema: { tags: ['admin'] } }, async () => {
      const e = env();
      const tenants = await sys((tx) =>
        tx.tenant.findMany({
          where: { status: { not: 'suspended' } },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            cwAccountId: true,
            cwInboxId: true,
            cwBotTokenEnc: true,
            erpSiteUrl: true,
            erpApiKeyEnc: true,
            settings: true,
            users: { where: { role: 'owner' }, select: { name: true, phone: true, email: true } },
          },
        }),
      );
      return {
        chatwoot: {
          baseUrl: e.CHATWOOT_BASE_URL,
          // Shown with the secret masked; the connect action writes the real URL into Chatwoot.
          webhookUrl: `${e.API_URL.replace(/\/+$/, '')}/webhooks/chatwoot?token=••••••`,
          webhookIpAllowlist: e.CHATWOOT_ALLOWED_IPS,
          webhookBlockedInProd: e.NODE_ENV === 'production' && e.CHATWOOT_ALLOWED_IPS.length === 0,
          lastWebhook: await readWebhookTraces(c.redis),
          mock: e.MOCK_EXTERNALS,
        },
        email: {
          provider: 'resend',
          configured: c.mailer.configured,
          from: c.mailer.from,
          adminReportRecipients: e.ADMIN_REPORT_EMAILS,
        },
        stripe: { configured: !!(e.STRIPE_SECRET_KEY && e.STRIPE_WEBHOOK_SECRET) },
        storage: { r2: c.storage instanceof R2Storage },
        ai: { vision: e.AI_VISION_PROVIDER, stt: e.AI_STT_PROVIDER, llm: e.AI_LLM_PROVIDER },
        provisioner: { configured: !!(e.PROVISIONER_URL && e.PROVISIONER_SECRET) },
        appUrl: e.APP_URL,
        apiUrl: e.API_URL,
        tenants: tenants.map((tn) => {
          const s = tenantSettingsSchema.safeParse(tn.settings ?? {});
          const owner = tn.users[0];
          return {
            id: tn.id,
            name: tn.name,
            slug: tn.slug,
            status: tn.status,
            chatwoot: { connected: !!tn.cwBotTokenEnc, accountId: tn.cwAccountId, inboxId: tn.cwInboxId },
            erpnext: {
              connected: !!tn.erpApiKeyEnc,
              siteUrl: tn.erpSiteUrl,
              company: s.success ? (s.data.erpCompany ?? null) : null,
              abbr: s.success ? (s.data.companyAbbr ?? null) : null,
            },
            owner: owner ? { name: owner.name, phone: owner.phone, email: owner.email } : null,
            emailReports: s.success ? s.data.emailReports : { enabled: true, recipients: [] },
          };
        }),
      };
    });

    // ---------------- ERPNext ----------------
    /**
     * Connect an existing ERPNext site (no provisioner needed): verify the API key, pick the company and store the
     * credentials encrypted. Without `company`, a site with several companies returns the list to choose from.
     */
    app.post(
      '/tenants/:id/erpnext/connect',
      {
        ...superOnly,
        schema: {
          tags: ['admin'],
          params: uuidParam,
          body: z.object({
            siteUrl: z.string().url(),
            apiKey: z.string().min(5),
            apiSecret: z.string().min(5),
            company: z.string().min(1).optional(),
          }),
        },
      },
      async (req) => {
        const tenant = await loadTenant(req.params.id);
        const b = req.body;
        const siteUrl = b.siteUrl.replace(/\/+$/, '');
        const candidate = { ...tenant, erpSiteUrl: siteUrl, erpApiKeyEnc: sealErpKey(tenant.id, b.apiKey), erpApiSecretEnc: sealErpSecret(tenant.id, b.apiSecret) };
        const erp = c.erp(candidate);
        const ping = await erp.ping();
        if (!ping.ok) throw badRequest('Could not log in to ERPNext with this URL and API key/secret');
        const companies = await upstream(() =>
          erp.list<{ name: string; abbr: string; default_currency?: string; country?: string }>('Company', {
            fields: ['name', 'abbr', 'default_currency', 'country'],
            limit: 100,
          }),
        );
        if (companies.length === 0) throw badRequest('This ERPNext site has no company yet: finish the ERPNext setup wizard first');
        const chosen = b.company ? companies.find((co) => co.name === b.company) : companies.length === 1 ? companies[0] : undefined;
        if (b.company && !chosen) throw badRequest(`Company "${b.company}" not found on this site`);
        if (!chosen) return { ok: false, needsCompany: true, companies: companies.map((co) => ({ name: co.name, abbr: co.abbr, currency: co.default_currency })) };

        const warnings: string[] = [];
        if (chosen.default_currency && chosen.default_currency !== tenant.currency)
          warnings.push(`Company currency is ${chosen.default_currency} but the business is set to ${tenant.currency}`);
        const fy = await upstream(() => erp.list('Fiscal Year', { fields: ['name'], limit: 1 }));
        if (fy.length === 0) warnings.push('No Fiscal Year found: entries will be rejected until one exists');

        // Merge, don't re-parse: the settings schema strips unknown keys such as provisioning progress.
        const settings = { ...((tenant.settings ?? {}) as object), erpCompany: chosen.name, companyAbbr: chosen.abbr };
        await sys((tx) =>
          tx.tenant.update({
            where: { id: tenant.id },
            data: {
              erpSiteUrl: siteUrl,
              erpApiKeyEnc: candidate.erpApiKeyEnc,
              erpApiSecretEnc: candidate.erpApiSecretEnc,
              settings: settings as Prisma.InputJsonValue,
            },
          }),
        );
        clearAccountCache(tenant.id);
        await adminAudit(req, 'erpnext.connect', tenant.id, { siteUrl, company: chosen.name, abbr: chosen.abbr, user: ping.user }, tenant.id);
        return { ok: true, siteUrl, company: chosen.name, abbr: chosen.abbr, user: ping.user, latencyMs: ping.latencyMs, warnings };
      },
    );

    // ---------------- Chatwoot ----------------
    app.post(
      '/integrations/chatwoot/inboxes',
      {
        ...superOnly,
        schema: { tags: ['admin'], body: z.object({ accountId, userToken: z.string().min(8) }) },
      },
      async (req) => ({ items: await upstream(() => listInboxes(req.body.userToken, req.body.accountId)) }),
    );

    app.post(
      '/tenants/:id/chatwoot/connect',
      {
        ...superOnly,
        schema: {
          tags: ['admin'],
          params: uuidParam,
          body: z.union([
            z.object({ mode: z.literal('auto'), accountId, inboxId, userToken: z.string().min(8) }),
            z.object({ mode: z.literal('manual'), accountId, inboxId, botToken: z.string().min(8) }),
          ]),
        },
      },
      async (req) => {
        const tenant = await loadTenant(req.params.id);
        const b = req.body;
        const other = await sys((tx) =>
          tx.tenant.findFirst({
            where: { cwInboxId: b.inboxId, id: { not: tenant.id } },
            select: { name: true },
          }),
        );
        if (other) throw badRequest(`Inbox ${b.inboxId} is already connected to ${other.name}`);
        let botToken: string;
        let detail: Record<string, unknown> = {};
        if (b.mode === 'auto') {
          const r = await upstream(() => connectInbox(b.userToken, b.accountId, b.inboxId));
          botToken = r.botToken;
          detail = { inbox: r.inbox, botId: r.botId, botCreated: r.created };
        } else {
          botToken = b.botToken;
        }
        const check = await upstream(() => verifyBotToken(botToken, b.accountId, b.inboxId));
        const step = await runProvisionStep(
          c,
          tenant.id,
          'chatwoot_inbox',
          { chatwoot: { accountId: b.accountId, inboxId: b.inboxId, botToken } },
          req.admin!.sub,
        );
        await adminAudit(
          req,
          'chatwoot.connect',
          tenant.id,
          { mode: b.mode, accountId: b.accountId, inboxId: b.inboxId, ...detail },
          tenant.id,
        );
        return {
          ok: true,
          mode: b.mode,
          ...detail,
          openConversations: check.openConversations,
          note: step.note,
        };
      },
    );

    app.post(
      '/tenants/:id/chatwoot/verify',
      { ...ops, schema: { tags: ['admin'], params: uuidParam } },
      async (req) => {
        const tenant = await loadTenant(req.params.id);
        if (!tenant.cwBotTokenEnc || !tenant.cwAccountId || !tenant.cwInboxId)
          throw badRequest('Chatwoot is not connected for this tenant');
        if (env().MOCK_EXTERNALS) return { ok: true, mock: true };
        const token = decrypt(tenant.cwBotTokenEnc, `cw_bot:${tenant.id}`);
        return upstream(() => verifyBotToken(token, tenant.cwAccountId!, tenant.cwInboxId!));
      },
    );

    app.post(
      '/tenants/:id/chatwoot/test',
      {
        ...ops,
        schema: { tags: ['admin'], params: uuidParam, body: z.object({ phone: z.string().min(6) }) },
      },
      async (req) => {
        const tenant = await loadTenant(req.params.id);
        if (!tenant.cwBotTokenEnc) throw badRequest('Chatwoot is not connected for this tenant');
        const phone = normalizePhone(req.body.phone, tenant.country);
        const r = await upstream(() =>
          sendWhatsApp(c, tenant, {
            kind: 'notice',
            phone,
            name: 'NextAi test',
            templateKey: 'connection_test', // no template row → plain text (works inside the 24h window)
            params: [],
            fallbackText: `✅ NextAi is connected to ${tenant.name}'s WhatsApp. You can send a bill photo here.`,
          }),
        );
        await adminAudit(
          req,
          'chatwoot.test_message',
          tenant.id,
          { conversationId: r.conversationId },
          tenant.id,
        );
        return { ok: true, conversationId: r.conversationId };
      },
    );

    // ---------------- Email (Resend) ----------------
    app.post(
      '/integrations/email/test',
      { ...superOnly, schema: { tags: ['admin'], body: z.object({ to: z.string().email() }) } },
      async (req) => {
        if (!c.mailer.configured) throw badRequest('RESEND_API_KEY is not set');
        const { html, text } = reportEmail({
          title: 'Resend is connected',
          intro: 'This test email confirms NextAi can send daily summaries and admin reports.',
          rows: [
            { label: 'Sender', value: c.mailer.from },
            { label: 'Sent at', value: new Date().toISOString() },
          ],
          footer: 'Sent from Admin → Integrations.',
        });
        const r = await upstream(() =>
          c.mailer.send({
            to: [req.body.to],
            subject: 'NextAi: email test',
            html,
            text,
            replyTo: env().MAIL_REPLY_TO,
            tags: { type: 'test' },
          }),
        );
        await adminAudit(req, 'email.test', undefined, { to: req.body.to, id: r.id });
        return { ok: true, id: r.id };
      },
    );

    app.put(
      '/tenants/:id/email-reports',
      {
        ...ops,
        schema: {
          tags: ['admin'],
          params: uuidParam,
          body: z.object({ enabled: z.boolean(), recipients: z.array(z.string().email()).max(10) }),
        },
      },
      async (req) => {
        const before = await loadTenant(req.params.id);
        const settings = {
          ...(before.settings as object),
          emailReports: {
            enabled: req.body.enabled,
            recipients: [...new Set(req.body.recipients.map((r) => r.toLowerCase()))],
          },
        };
        await sys((tx) =>
          tx.tenant.update({
            where: { id: before.id },
            data: { settings: settings as Prisma.InputJsonValue },
          }),
        );
        await adminAudit(req, 'email.recipients', before.id, settings.emailReports, before.id);
        return { ok: true, emailReports: settings.emailReports };
      },
    );

    /** Send today's summary email now (bypasses the once-per-day guard). */
    app.post(
      '/tenants/:id/email-summary',
      { ...ops, schema: { tags: ['admin'], params: uuidParam } },
      async (req) => {
        const tenant = await loadTenant(req.params.id);
        if (!c.mailer.configured) throw badRequest('RESEND_API_KEY is not set');
        const to = await reportRecipients(c, tenant);
        if (to.length === 0)
          throw badRequest(
            'No recipients: add an owner email or report recipients, and make sure email reports are enabled',
          );
        const { day, vars } = await summaryFigures(c, tenant);
        const r = await upstream(() => emailDailySummary(c, tenant, day, vars, { force: true }));
        await adminAudit(req, 'email.summary_now', tenant.id, r, tenant.id);
        return { ok: true, ...r, to };
      },
    );

    app.post(
      '/integrations/admin-report/send',
      { ...superOnly, schema: { tags: ['admin'] } },
      async (req) => {
        if (!c.mailer.configured) throw badRequest('RESEND_API_KEY is not set');
        if (env().ADMIN_REPORT_EMAILS.length === 0) throw badRequest('ADMIN_REPORT_EMAILS is empty');
        const r = await upstream(() => sendAdminDailyReport(c));
        await adminAudit(req, 'email.admin_report_now');
        return { ok: true, ...r };
      },
    );
  };
