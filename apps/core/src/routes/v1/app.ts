import { QUEUES, REPORT_NAMES, draftPayloadSchema, draftStatusSchema, normalizePhone, tenantSettingsSchema, type Currency, type DraftPayload, type ReportKey } from '@nextai/shared';
import type { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { sha256 } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../modules/audit/audit.js';
import { cancelDraft, confirmDraft, createDraft, getDraft, updateDraftPayload } from '../../modules/drafts/service.js';
import { erpContext } from '../../modules/erpnext/mappers.js';
import { booksContext, runReport, totalOutstanding } from '../../modules/reports/reports.js';
import { incrementUsage } from '../../modules/usage/usage.js';
import { tenantKey } from '../../storage/storage.js';
import { assertWithinLimit, requireFeature } from '../../modules/billing/gating.js';

const actorOf = (req: FastifyRequest) => ({ id: req.user!.sub, type: 'user' as const, channel: 'app' as const, ip: req.ip });
const requireOwner = (req: FastifyRequest) => {
  if (req.user!.role !== 'owner') throw forbidden('Only the business owner can do this');
};
const today = () => new Date().toISOString().slice(0, 10);
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4']);

export const appRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    // per-tenant rate limit for app traffic (keyed by verified tenant claim)
    const perTenant = { config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `t:${req.user?.tid ?? req.ip}` } } };

    // ---------------- Dashboard ----------------
    app.get('/dashboard', { ...perTenant, schema: { tags: ['app'] } }, async (req) => {
      const t = req.tenant!;
      const { company } = erpContext(t);
      const erp = c.erp(t);
      const safe = async <T>(f: () => Promise<T>, fallback: T) => {
        try {
          return await f();
        } catch {
          return fallback;
        }
      };
      const [bal, ar, ap, pending, posted] = await Promise.all([
        safe(() => erp.getBalances(company), { cash: 0, bank: 0, accounts: [] }),
        safe(() => runReport(c, t, 'receivables'), { columns: [], result: [] }),
        safe(() => runReport(c, t, 'payables'), { columns: [], result: [] }),
        req.db!.draft.count({ where: { status: { in: ['pending', 'needs_review'] } } }),
        req.db!.draft.findMany({ where: { status: 'posted', updatedAt: { gte: new Date(Date.now() - 32 * 86400_000) } } }),
      ]);
      const month = today().slice(0, 7);
      const sum = (types: string[], pred: (p: DraftPayload) => boolean) =>
        posted.filter((d) => types.includes(d.type) && pred(d.payload as DraftPayload)).reduce((s, d) => s + (d.payload as DraftPayload).total, 0);
      const salesMtd = sum(['sales_invoice'], (p) => p.date.startsWith(month));
      const expMtd = sum(['purchase_invoice', 'journal_entry'], (p) => p.date.startsWith(month));
      const taxDue = posted
        .filter((d) => (d.payload as DraftPayload).date.startsWith(month))
        .reduce((s, d) => {
          const tx = (d.payload as DraftPayload).taxes ?? {};
          const v = (tx.cgst ?? 0) + (tx.sgst ?? 0) + (tx.igst ?? 0) + (tx.vat ?? 0);
          return s + (d.type === 'sales_invoice' ? v : d.type === 'purchase_invoice' ? -v : 0);
        }, 0);
      const alerts: Array<{ kind: string; text: string }> = [];
      if (t.status === 'past_due') alerts.push({ kind: 'billing', text: 'Payment failed — update your card.' });
      if (pending) alerts.push({ kind: 'approvals', text: `${pending} item(s) need your approval.` });
      return {
        currency: t.currency as Currency,
        cash: bal.cash,
        bank: bal.bank,
        receivables: totalOutstanding(ar),
        payables: totalOutstanding(ap),
        todaySales: sum(['sales_invoice'], (p) => p.date === today()),
        todayExpenses: sum(['purchase_invoice', 'journal_entry'], (p) => p.date === today()),
        profitMtd: salesMtd - expMtd,
        taxDue: Math.max(0, taxDue),
        pendingApprovals: pending,
        alerts,
        tenantStatus: t.status,
      };
    });

    // ---------------- Drafts / approvals ----------------
    app.get(
      '/drafts',
      { ...perTenant, schema: { tags: ['app'], querystring: z.object({ status: draftStatusSchema.optional(), cursor: z.string().uuid().optional(), limit: z.coerce.number().min(1).max(50).default(20) }) } },
      async (req) => {
        const { status, cursor, limit } = req.query;
        const items = await req.db!.draft.findMany({
          where: { status: status ?? { in: ['pending', 'needs_review', 'failed'] } },
          orderBy: { createdAt: 'desc' },
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        return { items: items.slice(0, limit), nextCursor: items.length > limit ? items[limit - 1]!.id : null };
      },
    );

    app.get('/drafts/:id', { schema: { tags: ['app'], params: z.object({ id: z.string().uuid() }) } }, async (req) => {
      const d = await getDraft(c, req.tenant!.id, req.params.id);
      let documentUrl: string | null = null;
      if (d.documentId) {
        const doc = await req.db!.document.findUnique({ where: { id: d.documentId } });
        if (doc) documentUrl = await c.storage.signedUrl(req.tenant!.id, doc.r2Key, 300);
      }
      return { ...d, documentUrl };
    });

    app.patch(
      '/drafts/:id',
      { schema: { tags: ['app'], params: z.object({ id: z.string().uuid() }), body: draftPayloadSchema.partial() } },
      async (req) => updateDraftPayload(c, req.tenant!, req.params.id, req.body as Partial<DraftPayload>, actorOf(req)),
    );
    app.post('/drafts/:id/confirm', { schema: { tags: ['app'], params: z.object({ id: z.string().uuid() }) } }, async (req) =>
      confirmDraft(c, req.tenant!, req.params.id, actorOf(req)),
    );
    app.post('/drafts/:id/cancel', { schema: { tags: ['app'], params: z.object({ id: z.string().uuid() }) } }, async (req) =>
      cancelDraft(c, req.tenant!, req.params.id, actorOf(req)),
    );

    // ---------------- Capture (multipart; pages of one bill or a voice note) ----------------
    app.post('/capture', { ...perTenant, schema: { tags: ['app'], consumes: ['multipart/form-data'] } }, async (req, reply) => {
      const t = req.tenant!;
      await assertWithinLimit(c, t, 'ocrPagesPerMonth');
      const results: Array<{ documentId?: string; duplicate?: boolean; voice?: boolean }> = [];
      for await (const part of req.files()) {
        if (!ALLOWED_MIME.has(part.mimetype)) throw badRequest(`Unsupported file type ${part.mimetype}`);
        const buf = await part.toBuffer();
        const hash = sha256(buf);
        if (part.mimetype.startsWith('audio/')) {
          const key = tenantKey(t.id, 'voice', today().slice(0, 7), `${hash}.audio`);
          await c.storage.put(t.id, key, buf, part.mimetype);
          // App voice notes are transcribed and answered in the user's WhatsApp conversation if one exists.
          results.push({ voice: true });
          continue;
        }
        const existing = await req.db!.document.findUnique({ where: { tenantId_sha256: { tenantId: t.id, sha256: hash } } });
        if (existing) {
          results.push({ documentId: existing.id, duplicate: true });
          continue;
        }
        const key = tenantKey(t.id, 'docs', today().slice(0, 7), `${hash}.${part.mimetype.split('/')[1]}`);
        await c.storage.put(t.id, key, buf, part.mimetype);
        const doc = await req.db!.document.create({ data: { tenantId: t.id, r2Key: key, sha256: hash, mime: part.mimetype, source: 'app', uploadedBy: req.user!.sub } });
        await c.queue.enqueue(QUEUES.ocr, { tenantId: t.id, documentId: doc.id, userId: req.user!.sub }, { jobId: `ocr-${doc.id}` });
        results.push({ documentId: doc.id });
      }
      return reply.code(202).send({ items: results });
    });

    // ---------------- Invoices ----------------
    app.get('/invoices', { ...perTenant, schema: { tags: ['app'], querystring: z.object({ type: z.enum(['invoice', 'quotation', 'credit_note']).default('invoice'), page: z.coerce.number().min(0).default(0) }) } }, async (req) => {
      const doctype = req.query.type === 'quotation' ? 'Quotation' : 'Sales Invoice';
      const filters: Array<[string, string, unknown]> = req.query.type === 'credit_note' ? [['is_return', '=', 1]] : req.query.type === 'invoice' ? [['is_return', '=', 0]] : [];
      const items = await c.erp(req.tenant!).list(doctype, {
        filters,
        fields: ['name', 'customer', 'party_name', 'posting_date', 'transaction_date', 'due_date', 'grand_total', 'outstanding_amount', 'status', 'currency', 'docstatus'],
        orderBy: 'creation desc',
        limit: 20,
        start: req.query.page * 20,
      });
      return { items };
    });

    const invoiceBody = z.object({
      customer: z.string().min(1).max(140),
      customerPhone: z.string().optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      lines: z.array(z.object({ description: z.string().min(1), qty: z.number().positive(), rate: z.number().nonnegative() })).min(1),
      taxTemplate: z.string().optional(),
      postNow: z.boolean().default(true),
    });
    app.post('/invoices', { schema: { tags: ['app'], body: invoiceBody } }, async (req, reply) => {
      const t = req.tenant!;
      const b = req.body;
      const lines = b.lines.map((l) => ({ ...l, amount: Math.round(l.qty * l.rate * 100) / 100 }));
      const payload: DraftPayload = {
        partyName: b.customer,
        partyPhone: b.customerPhone ? normalizePhone(b.customerPhone, t.country) : undefined,
        date: b.date ?? today(),
        dueDate: b.dueDate,
        currency: t.currency as Currency,
        lines,
        taxTemplate: b.taxTemplate,
        total: lines.reduce((s, l) => s + l.amount, 0),
        validationIssues: [],
      };
      const draft = await createDraft(c, t, { userId: req.user!.sub, type: 'sales_invoice', payload, actor: actorOf(req) });
      // Creating from the app with "post now" is an explicit confirmation.
      const result = b.postNow ? await confirmDraft(c, t, draft.id, actorOf(req)) : draft;
      return reply.code(201).send(result);
    });

    app.get('/invoices/:id/pdf', { schema: { tags: ['app'], params: z.object({ id: z.string().min(1).max(140) }) } }, async (req, reply) => {
      const pdf = await c.erp(req.tenant!).downloadPdf('Sales Invoice', req.params.id, erpContext(req.tenant!).settings.invoiceTemplate);
      return reply.type('application/pdf').header('content-disposition', `inline; filename="${req.params.id.replace(/[^\w.-]/g, '_')}.pdf"`).send(Buffer.from(pdf));
    });

    app.post('/invoices/:id/send', { schema: { tags: ['app'], params: z.object({ id: z.string().min(1).max(140) }) } }, async (req) => {
      await assertWithinLimit(c, req.tenant!, 'invoicesSentPerMonth');
      await c.queue.enqueue(QUEUES.outboundInvoice, { tenantId: req.tenant!.id, invoiceName: req.params.id }, { jobId: `inv-${req.tenant!.id}-${req.params.id}-${Date.now()}` });
      return { queued: true };
    });

    // ---------------- Payments ----------------
    app.post(
      '/payments',
      {
        schema: {
          tags: ['app'],
          body: z.object({ direction: z.enum(['in', 'out']), party: z.string().min(1), amount: z.number().positive(), mode: z.enum(['cash', 'bank', 'upi', 'card']).default('bank'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), reference: z.string().optional() }),
        },
      },
      async (req, reply) => {
        const b = req.body;
        const payload: DraftPayload = { partyName: b.party, date: b.date ?? today(), currency: req.tenant!.currency as Currency, lines: [], total: b.amount, paymentMode: b.mode, referenceNo: b.reference, validationIssues: [] };
        const draft = await createDraft(c, req.tenant!, { userId: req.user!.sub, type: b.direction === 'in' ? 'payment_in' : 'payment_out', payload, actor: actorOf(req) });
        return reply.code(201).send(await confirmDraft(c, req.tenant!, draft.id, actorOf(req)));
      },
    );

    // ---------------- Parties ----------------
    app.get('/parties', { ...perTenant, schema: { tags: ['app'], querystring: z.object({ kind: z.enum(['customer', 'supplier']).default('customer'), q: z.string().max(100).optional() }) } }, async (req) => {
      const t = req.tenant!;
      const doctype = req.query.kind === 'customer' ? 'Customer' : 'Supplier';
      const nameField = req.query.kind === 'customer' ? 'customer_name' : 'supplier_name';
      const parties = await c.erp(t).list<{ name: string; mobile_no?: string }>(doctype, {
        filters: req.query.q ? [[nameField, 'like', `%${req.query.q}%`]] : [],
        fields: ['name', nameField, 'mobile_no'],
        limit: 50,
      });
      let balances: Record<string, number> = {};
      try {
        const r = await runReport(c, t, req.query.kind === 'customer' ? 'receivables' : 'payables');
        balances = Object.fromEntries((r.result as Array<Record<string, unknown>>).filter((x) => x?.party).map((x) => [String(x.party), Number(x.outstanding) || 0]));
      } catch {
        /* balances optional */
      }
      return { items: parties.map((p) => ({ id: p.name, name: p.name, phone: p.mobile_no ?? null, balance: balances[p.name] ?? 0 })) };
    });

    app.get('/parties/:id/statement', { schema: { tags: ['app'], params: z.object({ id: z.string().min(1).max(140) }), querystring: z.object({ kind: z.enum(['customer', 'supplier']).default('customer') }) } }, async (req) => {
      const r = await runReport(c, req.tenant!, 'general_ledger', { party_type: req.query.kind === 'customer' ? 'Customer' : 'Supplier', party: [req.params.id] });
      return r;
    });

    app.post('/parties/:id/remind', { schema: { tags: ['app'], params: z.object({ id: z.string().min(1).max(140) }) } }, async (req) => {
      await c.queue.enqueue(QUEUES.outboundReminder, { tenantId: req.tenant!.id, party: req.params.id });
      await audit(c.prisma, { tenantId: req.tenant!.id, actorId: req.user!.sub, actorType: 'user', channel: 'app', action: 'party.remind', entity: 'party', entityId: req.params.id, ip: req.ip });
      return { queued: true };
    });

    // ---------------- Reports ----------------
    app.get(
      '/reports/:name',
      { ...perTenant, schema: { tags: ['app'], params: z.object({ name: z.enum(Object.keys(REPORT_NAMES) as [ReportKey, ...ReportKey[]]) }), querystring: z.object({ from: z.string().optional(), to: z.string().optional() }) } },
      async (req) => {
        const r = await runReport(c, req.tenant!, req.params.name, { ...(req.query.from ? { from: req.query.from } : {}), ...(req.query.to ? { to: req.query.to } : {}) });
        return { name: REPORT_NAMES[req.params.name], ...r };
      },
    );

    app.get('/tax', { schema: { tags: ['app'] } }, async (req) => {
      await requireFeature(c, req.tenant!, 'tax_centre');
      const t = req.tenant!;
      const posted = await req.db!.draft.findMany({ where: { status: 'posted', updatedAt: { gte: new Date(Date.now() - 400 * 86400_000) } } });
      const byMonth = new Map<string, { output: number; input: number }>();
      for (const d of posted) {
        const p = d.payload as DraftPayload;
        const tx = p.taxes ?? {};
        const v = (tx.cgst ?? 0) + (tx.sgst ?? 0) + (tx.igst ?? 0) + (tx.vat ?? 0);
        const m = p.date.slice(0, 7);
        const row = byMonth.get(m) ?? { output: 0, input: 0 };
        if (d.type === 'sales_invoice') row.output += v;
        if (d.type === 'purchase_invoice') row.input += v;
        byMonth.set(m, row);
      }
      const periods = [...byMonth.entries()].sort().reverse().map(([period, v]) => ({ period, ...v, net: v.output - v.input }));
      // Statutory due dates (simplified): GSTR-3B 20th of next month; UAE VAT 28th after quarter end; CT 9 months after FY end.
      const dueDates =
        t.country === 'IN'
          ? [{ name: 'GSTR-1', day: 11 }, { name: 'GSTR-3B', day: 20 }]
          : [{ name: 'VAT return (quarterly)', day: 28 }, { name: 'Corporate Tax return', day: 0 }];
      return { regime: erpContext(t).settings.taxRegime, periods, dueDates };
    });

    // ---------------- Ask your books ----------------
    app.post('/ask', { ...perTenant, schema: { tags: ['app'], body: z.object({ question: z.string().min(2).max(500) }) } }, async (req) => {
      const t = req.tenant!;
      await requireFeature(c, t, 'ask_books');
      const context = await booksContext(c, t);
      const lang = (t.language as 'en' | 'ml' | 'ar') ?? 'en';
      const { text, usage } = await c.ai.llm.answer(req.body.question, context, lang);
      await incrementUsage(c.prisma, t.id, { aiTokens: usage.tokens, aiCostMicros: usage.costMicros });
      return { answer: text };
    });

    // ---------------- Settings ----------------
    app.get('/settings', { schema: { tags: ['app'] } }, async (req) => {
      const t = req.tenant!;
      return { name: t.name, country: t.country, currency: t.currency, language: t.language, settings: tenantSettingsSchema.parse(t.settings) };
    });

    const settingsPatch = z.object({
      name: z.string().min(2).max(200).optional(),
      language: z.enum(['en', 'ml', 'ar']).optional(),
      settings: tenantSettingsSchema
        .pick({ autoPost: true, reminders: true, dailySummary: true, taxId: true, bank: true, invoiceTemplate: true, autoSendInvoices: true, companyName: true })
        .partial()
        .optional(),
    });
    app.patch('/settings', { schema: { tags: ['app'], body: settingsPatch } }, async (req) => {
      requireOwner(req);
      const t = req.tenant!;
      const merged = tenantSettingsSchema.parse({ ...(t.settings as object), ...(req.body.settings ?? {}) });
      const updated = await req.db!.tenant.update({
        where: { id: t.id },
        data: { name: req.body.name, language: req.body.language, settings: merged as Prisma.InputJsonValue },
      });
      await audit(c.prisma, { tenantId: t.id, actorId: req.user!.sub, actorType: 'user', channel: 'app', action: 'settings.update', entity: 'tenant', entityId: t.id, before: { name: t.name, language: t.language, settings: t.settings }, after: { name: updated.name, language: updated.language, settings: merged }, ip: req.ip });
      return { name: updated.name, language: updated.language, settings: merged };
    });

    // ---------------- Team ----------------
    app.get('/team', { schema: { tags: ['app'] } }, async (req) => {
      const users = await req.db!.user.findMany({ orderBy: { createdAt: 'asc' } });
      return { items: users.map((u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role, status: u.status })) };
    });
    app.post(
      '/team',
      { schema: { tags: ['app'], body: z.object({ name: z.string().min(1).max(100), phone: z.string().min(8).max(20), role: z.enum(['staff', 'tenant_accountant']) }) } },
      async (req, reply) => {
        requireOwner(req);
        const t = req.tenant!;
        await assertWithinLimit(c, t, 'users');
        const phone = normalizePhone(req.body.phone, t.country);
        const exists = await req.db!.user.findFirst({ where: { phone } });
        if (exists) throw conflict('That number is already on your team');
        const u = await req.db!.user.create({ data: { tenantId: t.id, name: req.body.name, phone, role: req.body.role, status: 'invited' } });
        await audit(c.prisma, { tenantId: t.id, actorId: req.user!.sub, actorType: 'user', channel: 'app', action: 'team.invite', entity: 'user', entityId: u.id, after: { name: u.name, role: u.role }, ip: req.ip });
        return reply.code(201).send({ id: u.id, name: u.name, phone: u.phone, role: u.role, status: u.status });
      },
    );
    app.delete('/team/:id', { schema: { tags: ['app'], params: z.object({ id: z.string().uuid() }) } }, async (req) => {
      requireOwner(req);
      if (req.params.id === req.user!.sub) throw badRequest('You cannot remove yourself');
      const u = await req.db!.user.findUnique({ where: { id: req.params.id } });
      if (!u) throw notFound('User');
      await req.db!.user.update({ where: { id: u.id }, data: { status: 'disabled' } });
      await audit(c.prisma, { tenantId: req.tenant!.id, actorId: req.user!.sub, actorType: 'user', channel: 'app', action: 'team.disable', entity: 'user', entityId: u.id, ip: req.ip });
      return { ok: true };
    });

    // ---------------- Web push ----------------
    app.post(
      '/push/subscribe',
      { schema: { tags: ['app'], body: z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }) } },
      async (req) => {
        await req.db!.pushSubscription.upsert({
          where: { endpoint: req.body.endpoint },
          update: { keys: req.body.keys, userId: req.user!.sub },
          create: { tenantId: req.tenant!.id, userId: req.user!.sub, endpoint: req.body.endpoint, keys: req.body.keys },
        });
        return { ok: true };
      },
    );
  };
