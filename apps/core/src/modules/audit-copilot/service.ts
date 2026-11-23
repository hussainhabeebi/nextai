import { QUEUES, formatMoney, tenantSettingsSchema, type Currency, type Language } from '@nextai/shared';
import type { AuditFinding, AuditRun, Prisma, Tenant } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Container } from '../../container.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import { conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { audit, type AuditEntry } from '../audit/audit.js';
import { erpContext } from '../erpnext/mappers.js';
import { isoDay, listAll } from '../erpnext/fetch.js';
import { fiscalYearStart } from '../reports/reports.js';
import { incrementUsage } from '../usage/usage.js';
import { RULES, RULE_VERSION, analyze, fingerprint, resolvePolicy, type AuditTxn, type RawFinding } from './rules.js';

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Deterministic JSON (sorted keys) so hashes are reproducible. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Row)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const itemsTotal = (d: Row) => (Array.isArray(d.items) ? (d.items as Row[]).reduce((s, i) => s + num(i.amount ?? num(i.qty) * num(i.rate)), 0) : 0);

/** Normalise ERPNext documents into the audit population. */
export function toTxns(docs: { pi: Row[]; si: Row[]; pe: Row[]; je: Row[] }): AuditTxn[] {
  const base = (d: Row) => ({ name: String(d.name), date: String(d.posting_date ?? '').slice(0, 10), owner: str(d.owner), creation: str(d.creation), cancelled: num(d.docstatus) === 2 });
  const cashOf = (mop: unknown) => (/cash/i.test(String(mop ?? '')) ? ('cash' as const) : ('bank' as const));
  return [
    ...docs.pi.map((d) => ({
      ...base(d),
      doctype: 'Purchase Invoice' as const,
      direction: 'out' as const,
      party: str(d.supplier),
      partyType: 'Supplier' as const,
      amount: Math.abs(num(d.grand_total) || itemsTotal(d)),
      billNo: str(d.bill_no),
      mode: num(d.is_paid) ? cashOf(d.mode_of_payment) : undefined,
      taxId: str(d.tax_id) ?? str(d.supplier_gstin),
      taxAmount: num(d.total_taxes_and_charges),
      isReturn: !!num(d.is_return),
      remarks: str(d.remarks),
    })),
    ...docs.si.map((d) => ({
      ...base(d),
      doctype: 'Sales Invoice' as const,
      direction: 'in' as const,
      party: str(d.customer),
      partyType: 'Customer' as const,
      amount: Math.abs(num(d.grand_total) || itemsTotal(d)),
      taxId: str(d.tax_id),
      taxAmount: num(d.total_taxes_and_charges),
      isReturn: !!num(d.is_return),
      mode: num(d.is_pos) ? cashOf(d.mode_of_payment) : undefined,
    })),
    ...docs.pe.map((d) => ({
      ...base(d),
      doctype: 'Payment Entry' as const,
      direction: d.payment_type === 'Receive' ? ('in' as const) : ('out' as const),
      party: str(d.party),
      partyType: d.party_type === 'Customer' ? ('Customer' as const) : d.party_type === 'Supplier' ? ('Supplier' as const) : undefined,
      amount: Math.abs(num(d.paid_amount) || num(d.received_amount)),
      mode: cashOf(d.mode_of_payment),
      billNo: str(d.reference_no),
    })),
    ...docs.je.map((d) => ({
      ...base(d),
      doctype: 'Journal Entry' as const,
      direction: 'out' as const,
      amount: Math.abs(
        num(d.total_debit) || (Array.isArray(d.accounts) ? (d.accounts as Row[]).reduce((s, a) => s + num(a.debit_in_account_currency), 0) : 0),
      ),
      mode: d.voucher_type === 'Cash Entry' ? ('cash' as const) : d.voucher_type === 'Bank Entry' ? ('bank' as const) : undefined,
      remarks: str(d.user_remark),
    })),
  ].filter((t) => t.date && t.amount >= 0);
}

async function loadPopulation(c: Container, tenant: Tenant, from: string, to: string) {
  const erp = c.erp(tenant);
  const { company } = erpContext(tenant);
  const range: [string, string, unknown] = ['posting_date', 'between', [from, to]];
  const co: [string, string, unknown] = ['company', '=', company];
  const submitted: [string, string, unknown] = ['docstatus', '=', 1];
  const [pi, si, pe, je, sup] = await Promise.all([
    listAll<Row>(erp, 'Purchase Invoice', { filters: [co, submitted, range], fields: ['name', 'supplier', 'bill_no', 'posting_date', 'grand_total', 'total_taxes_and_charges', 'tax_id', 'is_paid', 'mode_of_payment', 'is_return', 'owner', 'creation', 'docstatus'] }),
    // cancelled invoices too, so they are not reported as sequence gaps
    listAll<Row>(erp, 'Sales Invoice', { filters: [co, ['docstatus', 'in', [1, 2]], range], fields: ['name', 'customer', 'posting_date', 'grand_total', 'total_taxes_and_charges', 'tax_id', 'is_return', 'is_pos', 'owner', 'creation', 'docstatus'] }),
    listAll<Row>(erp, 'Payment Entry', { filters: [co, submitted, range], fields: ['name', 'payment_type', 'party_type', 'party', 'posting_date', 'paid_amount', 'received_amount', 'mode_of_payment', 'reference_no', 'owner', 'creation', 'docstatus'] }),
    listAll<Row>(erp, 'Journal Entry', { filters: [co, submitted, range], fields: ['name', 'voucher_type', 'posting_date', 'total_debit', 'user_remark', 'owner', 'creation', 'docstatus'] }),
    listAll<Row>(erp, 'Supplier', { fields: ['name', 'creation'] }),
  ]);
  const txns = toTxns({ pi: pi.rows, si: si.rows, pe: pe.rows, je: je.rows });
  const supplierSince = Object.fromEntries(sup.rows.filter((s) => s.creation).map((s) => [String(s.name), String(s.creation)]));
  return { txns, supplierSince, truncated: pi.truncated || si.truncated || pe.truncated || je.truncated };
}

export interface StartAuditInput {
  from?: string;
  to?: string;
  trigger?: 'manual' | 'schedule';
  requestedBy?: string;
}

/** Create a run and queue the work. One active run per tenant. */
export async function startAuditRun(c: Container, tenant: Tenant, input: StartAuditInput = {}): Promise<AuditRun> {
  const db = tenantDb(c.prisma, tenant.id);
  const active = await db.auditRun.findFirst({ where: { status: 'running', startedAt: { gte: new Date(Date.now() - 30 * 60_000) } } });
  if (active) throw conflict('An audit is already running for this business');
  const to = input.to ?? isoDay(new Date());
  const from = input.from ?? fiscalYearStart(tenant.country);
  if (from > to) throw conflict('Audit period start is after its end');
  const run = await db.auditRun.create({ data: { tenantId: tenant.id, periodFrom: from, periodTo: to, trigger: input.trigger ?? 'manual', requestedBy: input.requestedBy } });
  await c.queue.enqueue(QUEUES.auditRun, { tenantId: tenant.id, runId: run.id }, { jobId: `audit-${run.id}` });
  return run;
}

function findingEvidence(f: RawFinding, parameters: Record<string, unknown>) {
  return {
    rule: f.rule,
    ruleVersion: RULE_VERSION,
    parameters,
    observed: f.observed,
    // snapshot of each tested document as it was when the test ran
    transactions: f.txns.map((t) => ({ doctype: t.doctype, name: t.name, date: t.date, party: t.party, amount: t.amount, billNo: t.billNo, mode: t.mode, taxId: t.taxId, taxAmount: t.taxAmount, owner: t.owner, creation: t.creation })),
  };
}

/** audit.run job: tests 100% of the period's transactions and stores findings + evidence. */
export async function executeAuditRun(c: Container, tenantId: string, runId: string): Promise<AuditRun> {
  const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
  const db = tenantDb(c.prisma, tenantId);
  const run = await db.auditRun.findUnique({ where: { id: runId } });
  if (!run) throw notFound('Audit run');
  if (run.status !== 'running') return run;
  const settings = tenantSettingsSchema.parse(tenant.settings ?? {});
  const cur = tenant.currency as Currency;
  const policy = resolvePolicy(settings.auditPolicy, tenant.country, cur);
  try {
    const { txns, supplierSince, truncated } = await loadPopulation(c, tenant, run.periodFrom, run.periodTo);
    const { findings, benford } = analyze(txns, { country: tenant.country, currency: cur, policy, supplierSince });

    const datasetHash = sha(canonical([...txns].sort((a, b) => `${a.doctype}:${a.name}`.localeCompare(`${b.doctype}:${b.name}`))));
    const prev = await db.auditRun.findFirst({ where: { status: 'completed', id: { not: runId } }, orderBy: { startedAt: 'desc' } });

    // carry forward earlier decisions so a dismissed issue is not re-raised as new
    const fps = findings.map((f) => fingerprint(f.rule, f.txns));
    const decided = await db.auditFinding.findMany({ where: { fingerprint: { in: fps }, status: { not: 'open' } }, orderBy: { createdAt: 'desc' } });
    const decision = new Map<string, AuditFinding>();
    for (const d of decided) if (!decision.has(d.fingerprint)) decision.set(d.fingerprint, d);

    const parameters = { ...policy, country: tenant.country, currency: cur };
    const rows = findings.map((f, i) => {
      const prior = decision.get(fps[i]!);
      return {
        tenantId,
        runId,
        rule: f.rule,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        amount: f.amount ?? null,
        fingerprint: fps[i]!,
        txnRefs: f.txns.map((t) => ({ doctype: t.doctype, name: t.name })) as Prisma.InputJsonValue,
        evidence: findingEvidence(f, parameters) as unknown as Prisma.InputJsonValue,
        status: prior?.status ?? ('open' as const),
        resolution: prior ? `${prior.resolution ?? ''} (decision carried from run ${prior.runId.slice(0, 8)})`.trim() : null,
        resolvedBy: prior?.resolvedBy ?? null,
        resolvedAt: prior?.resolvedAt ?? null,
      };
    });
    if (rows.length) await db.auditFinding.createMany({ data: rows });

    const findingsHash = sha(canonical(rows.map((r) => ({ fingerprint: r.fingerprint, rule: r.rule, severity: r.severity, amount: r.amount, evidence: r.evidence }))));
    const evidenceHash = sha(`${prev?.evidenceHash ?? 'genesis'}|${datasetHash}|${findingsHash}`);

    const count = <K extends string>(xs: K[]) => xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
    const open = rows.filter((r) => r.status === 'open');
    const summary = {
      coveragePct: 100,
      truncated,
      population: count(txns.filter((t) => !t.cancelled).map((t) => t.doctype)),
      bySeverity: count(open.map((r) => r.severity)),
      byRule: count(rows.map((r) => r.rule)),
      carriedDecisions: rows.length - open.length,
      exposure: Math.round(open.reduce((s, r) => s + (r.amount ?? 0), 0) * 100) / 100,
      rulesApplied: [...RULES],
      ruleVersion: RULE_VERSION,
      policy: parameters,
      benford,
      findingsHash,
      narrative: await narrative(c, tenant, findings.filter((_, i) => rows[i]!.status === 'open'), txns.length),
    };
    const done = await db.auditRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        txnCount: txns.filter((t) => !t.cancelled).length,
        totalValue: Math.round(txns.filter((t) => !t.cancelled).reduce((s, t) => s + t.amount, 0) * 100) / 100,
        datasetHash,
        prevHash: prev?.evidenceHash ?? null,
        evidenceHash,
        summary: summary as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
    await audit(c.prisma, { tenantId, actorType: 'system', channel: 'system', action: 'audit_run.completed', entity: 'audit_run', entityId: runId, after: { txnCount: done.txnCount, findings: rows.length, evidenceHash } });
    return done;
  } catch (err) {
    logger.warn({ tenantId, runId, err: (err as Error).message }, 'audit run failed');
    return db.auditRun.update({ where: { id: runId }, data: { status: 'failed', error: (err as Error).message.slice(0, 500), finishedAt: new Date() } });
  }
}

/** Plain-language summary for the owner. Falls back to a deterministic summary when the LLM is unavailable. */
async function narrative(c: Container, tenant: Tenant, open: RawFinding[], tested: number): Promise<string> {
  const cur = tenant.currency as Currency;
  const top = open.slice(0, 12).map((f) => `- [${f.severity}] ${f.title}${f.amount ? ` (${formatMoney(f.amount, cur)})` : ''}`);
  const fallback = open.length
    ? `Tested all ${tested} transactions. ${open.length} item(s) need attention; most important: ${open[0]!.title}.`
    : `Tested all ${tested} transactions. No exceptions found.`;
  if (!open.length) return fallback;
  try {
    const { text, usage } = await c.ai.llm.answer(
      'Summarise these audit exceptions for the business owner in at most 3 short bullet points: what matters most and what to do next. Do not invent facts.',
      `Transactions tested: ${tested} (100% of the period).\nExceptions:\n${top.join('\n')}`,
      (tenant.language as Language) ?? 'en',
    );
    await incrementUsage(c.prisma, tenant.id, { aiTokens: usage.tokens, aiCostMicros: usage.costMicros });
    return text.trim() || fallback;
  } catch {
    return fallback;
  }
}

export async function decideFinding(c: Container, tenant: Tenant, findingId: string, status: 'resolved' | 'dismissed' | 'open', note: string | undefined, actor: Pick<AuditEntry, 'actorId' | 'actorType' | 'channel' | 'ip'>) {
  const db = tenantDb(c.prisma, tenant.id);
  const before = await db.auditFinding.findUnique({ where: { id: findingId } });
  if (!before) throw notFound('Finding');
  const after = await db.auditFinding.update({
    where: { id: findingId },
    data: status === 'open' ? { status, resolution: null, resolvedBy: null, resolvedAt: null } : { status, resolution: note ?? null, resolvedBy: actor.actorId ?? null, resolvedAt: new Date() },
  });
  await audit(c.prisma, { tenantId: tenant.id, ...actor, action: `audit_finding.${status}`, entity: 'audit_finding', entityId: findingId, before: { status: before.status }, after: { status, note } });
  return after;
}

/** Self-contained evidence pack for an accountant / external auditor. */
export async function workpaper(c: Container, tenant: Tenant, runId: string) {
  const db = tenantDb(c.prisma, tenant.id);
  const run = await db.auditRun.findUnique({ where: { id: runId } });
  if (!run) throw notFound('Audit run');
  const findings = await db.auditFinding.findMany({ where: { runId }, orderBy: [{ severity: 'desc' }, { amount: 'desc' }] });
  return {
    workpaper: 'NextAi Audit Copilot — full-population test',
    business: tenant.name,
    period: { from: run.periodFrom, to: run.periodTo },
    generatedAt: new Date().toISOString(),
    run: { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, trigger: run.trigger, txnCount: run.txnCount, totalValue: run.totalValue },
    integrity: {
      datasetHash: run.datasetHash,
      prevHash: run.prevHash,
      evidenceHash: run.evidenceHash,
      method: 'evidenceHash = sha256(prevHash | datasetHash | sha256(canonical findings)); datasetHash = sha256(canonical sorted population)',
    },
    summary: run.summary,
    findings: findings.map((f) => ({ id: f.id, rule: f.rule, severity: f.severity, title: f.title, detail: f.detail, amount: f.amount, status: f.status, resolution: f.resolution, resolvedAt: f.resolvedAt, fingerprint: f.fingerprint, evidence: f.evidence })),
  };
}

export function workpaperCsv(wp: Awaited<ReturnType<typeof workpaper>>): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['severity', 'rule', 'title', 'amount', 'status', 'resolution', 'documents', 'detail', 'fingerprint'];
  const lines = wp.findings.map((f) => {
    const docs = ((f.evidence as { transactions?: Array<{ doctype: string; name: string }> }).transactions ?? []).map((t) => `${t.doctype} ${t.name}`).join('; ');
    return [f.severity, f.rule, f.title, f.amount, f.status, f.resolution, docs, f.detail, f.fingerprint].map(esc).join(',');
  });
  return [`# ${wp.business} ${wp.period.from}..${wp.period.to} evidenceHash=${wp.integrity.evidenceHash}`, head.join(','), ...lines].join('\n');
}

/** schedule.audit — weekly; rolling 12 months for every tenant with the feature and weekly runs on. */
export async function scheduleAudits(c: Container, hasFeature: (t: Tenant) => Promise<boolean>) {
  const tenants = await withSystemTx(c.prisma, (tx) => tx.tenant.findMany({ where: { status: { in: ['trial', 'active'] }, erpApiKeyEnc: { not: null } } }));
  let queued = 0;
  for (const t of tenants) {
    try {
      if (!tenantSettingsSchema.parse(t.settings ?? {}).auditPolicy.weeklyRun || !(await hasFeature(t))) continue;
      const from = new Date();
      from.setUTCFullYear(from.getUTCFullYear() - 1);
      await startAuditRun(c, t, { from: isoDay(from), trigger: 'schedule' });
      queued++;
    } catch (err) {
      logger.warn({ tenantId: t.id, err: (err as Error).message }, 'scheduled audit skipped');
    }
  }
  return { queued };
}
