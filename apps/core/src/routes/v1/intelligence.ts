import { QUEUES, forecastScenarioSchema, isoDate } from '@nextai/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { decideFinding, startAuditRun, workpaper, workpaperCsv } from '../../modules/audit-copilot/service.js';
import { requireFeature } from '../../modules/billing/gating.js';
import { IRP_CANCEL_REASONS, cancelEInvoice, eInvoiceSummary, eInvoicingFor } from '../../modules/einvoice/service.js';
import { baseForecast, simulate } from '../../modules/forecast/service.js';

const ownerOrAccountant = (req: FastifyRequest) => {
  if (req.user!.role !== 'owner' && req.user!.role !== 'tenant_accountant') throw forbidden('Only the owner or the accountant can do this');
};

/** Audit Copilot, cash-flow forecasting and e-invoicing (all tenant-scoped via req.db / req.tenant). */
export const intelligenceRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    const perTenant = { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `ti:${req.user?.tid ?? req.ip}` } } };

    // ---------------- Audit Copilot ----------------
    app.post(
      '/audit/runs',
      { ...perTenant, schema: { tags: ['audit'], body: z.object({ from: isoDate.optional(), to: isoDate.optional() }).default({}) } },
      async (req, reply) => {
        await requireFeature(c, req.tenant!, 'audit_copilot');
        ownerOrAccountant(req);
        const run = await startAuditRun(c, req.tenant!, { ...req.body, requestedBy: req.user!.sub });
        return reply.code(202).send(run);
      },
    );

    app.get('/audit/runs', { schema: { tags: ['audit'] } }, async (req) => {
      await requireFeature(c, req.tenant!, 'audit_copilot');
      const items = await req.db!.auditRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 });
      const latest = items.find((r) => r.status === 'completed');
      const openFindings = latest ? await req.db!.auditFinding.groupBy({ by: ['severity'], where: { status: 'open', runId: latest.id }, _count: { _all: true } }) : [];
      return { items, latestOpen: Object.fromEntries(openFindings.map((f) => [f.severity, f._count._all])) };
    });

    app.get(
      '/audit/runs/:id',
      { schema: { tags: ['audit'], params: z.object({ id: z.string().uuid() }), querystring: z.object({ status: z.enum(['open', 'resolved', 'dismissed']).optional(), severity: z.enum(['low', 'medium', 'high', 'critical']).optional() }) } },
      async (req) => {
        await requireFeature(c, req.tenant!, 'audit_copilot');
        const run = await req.db!.auditRun.findUnique({ where: { id: req.params.id } });
        if (!run) throw notFound('Audit run');
        const findings = await req.db!.auditFinding.findMany({
          where: { runId: run.id, ...(req.query.status ? { status: req.query.status } : {}), ...(req.query.severity ? { severity: req.query.severity } : {}) },
          orderBy: [{ severity: 'desc' }, { amount: 'desc' }],
          take: 500,
        });
        return { run, findings };
      },
    );

    app.patch(
      '/audit/findings/:id',
      { schema: { tags: ['audit'], params: z.object({ id: z.string().uuid() }), body: z.object({ status: z.enum(['open', 'resolved', 'dismissed']), note: z.string().max(1000).optional() }) } },
      async (req) => {
        await requireFeature(c, req.tenant!, 'audit_copilot');
        ownerOrAccountant(req);
        if (req.body.status === 'dismissed' && !req.body.note) throw badRequest('A reason is required to dismiss a finding');
        return decideFinding(c, req.tenant!, req.params.id, req.body.status, req.body.note, { actorId: req.user!.sub, actorType: 'user', channel: 'app', ip: req.ip });
      },
    );

    app.get(
      '/audit/runs/:id/workpaper',
      { schema: { tags: ['audit'], params: z.object({ id: z.string().uuid() }), querystring: z.object({ format: z.enum(['json', 'csv']).default('json') }) } },
      async (req, reply) => {
        await requireFeature(c, req.tenant!, 'audit_copilot');
        const wp = await workpaper(c, req.tenant!, req.params.id);
        if (req.query.format === 'csv') {
          return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="audit-${wp.period.from}-${wp.period.to}.csv"`).send(workpaperCsv(wp));
        }
        return wp;
      },
    );

    // ---------------- Cash-flow forecast ----------------
    app.get('/forecast', { ...perTenant, schema: { tags: ['forecast'], querystring: z.object({ refresh: z.coerce.boolean().default(false) }) } }, async (req) => {
      await requireFeature(c, req.tenant!, 'cash_forecast');
      return baseForecast(c, req.tenant!, req.query.refresh);
    });

    app.post('/forecast/simulate', { ...perTenant, schema: { tags: ['forecast'], body: forecastScenarioSchema } }, async (req) => {
      await requireFeature(c, req.tenant!, 'cash_forecast');
      return simulate(c, req.tenant!, req.body);
    });

    // ---------------- E-invoicing ----------------
    app.get('/einvoices', { schema: { tags: ['einvoice'], querystring: z.object({ status: z.enum(['pending', 'invalid', 'submitted', 'accepted', 'rejected', 'cancelled', 'failed']).optional(), page: z.coerce.number().int().min(0).default(0) }) } }, async (req) => {
      await requireFeature(c, req.tenant!, 'e_invoicing');
      const items = await req.db!.eInvoice.findMany({
        where: req.query.status ? { status: req.query.status } : {},
        orderBy: { createdAt: 'desc' },
        take: 30,
        skip: req.query.page * 30,
        select: { id: true, scheme: true, invoiceName: true, status: true, irn: true, ackNo: true, ackDate: true, total: true, taxTotal: true, buyerTaxId: true, errors: true, attempts: true, createdAt: true },
      });
      return { items, summary: await eInvoiceSummary(c, req.tenant!) };
    });

    app.get('/einvoices/:id', { schema: { tags: ['einvoice'], params: z.object({ id: z.string().uuid() }) } }, async (req) => {
      await requireFeature(c, req.tenant!, 'e_invoicing');
      const e = await req.db!.eInvoice.findUnique({ where: { id: req.params.id } });
      if (!e) throw notFound('E-invoice');
      return { ...e, documentUrl: e.r2Key ? await c.storage.signedUrl(req.tenant!.id, e.r2Key, 300) : null };
    });

    app.post('/einvoices/submit', { schema: { tags: ['einvoice'], body: z.object({ invoiceName: z.string().min(1).max(140) }) } }, async (req, reply) => {
      await requireFeature(c, req.tenant!, 'e_invoicing');
      const { enabled } = eInvoicingFor(req.tenant!);
      if (!enabled) throw forbidden('Turn on e-invoicing in Settings first');
      await c.queue.enqueue(QUEUES.einvoiceSubmit, { tenantId: req.tenant!.id, invoiceName: req.body.invoiceName }, { jobId: `einv-${req.tenant!.id}-${req.body.invoiceName}-${Date.now()}` });
      return reply.code(202).send({ queued: true });
    });

    app.post(
      '/einvoices/:id/cancel',
      { schema: { tags: ['einvoice'], params: z.object({ id: z.string().uuid() }), body: z.object({ reason: z.enum(Object.keys(IRP_CANCEL_REASONS) as [keyof typeof IRP_CANCEL_REASONS, ...Array<keyof typeof IRP_CANCEL_REASONS>]), remark: z.string().max(100).optional() }) } },
      async (req) => {
        await requireFeature(c, req.tenant!, 'e_invoicing');
        ownerOrAccountant(req);
        return cancelEInvoice(c, req.tenant!, req.params.id, req.body.reason, req.body.remark, { id: req.user!.sub, ip: req.ip });
      },
    );
  };
