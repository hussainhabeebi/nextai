import type { ErpClient, ErpDoc } from '@nextai/erpnext-client';
import { normalizePhone } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { withSystemTx } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { erpContext } from '../erpnext/mappers.js';
import { localDate, localHour } from '../outbound/jobs.js';
import { closeTimers, pickOwner, startTimer } from './engine.js';

/** Doctypes whose ERPNext webhooks feed the lifecycle engine. */
export const LIFECYCLE_DOCTYPES = [
  'Lead',
  'Opportunity',
  'Event',
  'Quotation',
  'Sales Order',
  'Sales Invoice',
  'Payment Entry',
  'Project',
  'Task',
  'Issue',
  'Subscription',
] as const;
export type LifecycleDoctype = (typeof LIFECYCLE_DOCTYPES)[number];
export const LIFECYCLE_EVENTS = ['after_insert', 'on_update', 'on_submit', 'on_cancel', 'on_update_after_submit', 'on_trash'] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

/** Custom fields expected on the ERPNext site (see docs/lifecycle.md). */
export const CF = {
  projectStage: 'custom_stage', // Project: Kickoff | Data Collection | Build | QA | Testing | Live | Hypercare
  demoOutcome: 'custom_demo_outcome', // Opportunity
  leadvyneId: 'custom_leadvyne_id', // Lead
} as const;

const PRE_DATA_STAGES = new Set(['', 'Kickoff', 'Data Collection']);
const ONBOARDING_TEMPLATE = 'Onboarding Template';

// ---------------- Time helpers ----------------

/** Offset (ms) of `tz` from UTC at instant `at`. */
function tzOffsetMs(tz: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** ERPNext local "YYYY-MM-DD[ HH:mm[:ss]]" in the site timezone → UTC instant. Date-only values use `hourLocal`. */
export function erpTime(value: unknown, tz: string, hourLocal = 10): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const [d, t] = value.split(/[ T]/);
  const [hh, mm, ss] = (t ?? `${String(hourLocal).padStart(2, '0')}:00:00`).split(':').map((x) => Number(x) || 0);
  const naive = Date.parse(`${d}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(Math.floor(ss ?? 0)).padStart(2, '0')}Z`);
  if (Number.isNaN(naive)) return null;
  return new Date(naive - tzOffsetMs(tz, new Date(naive)));
}

// ---------------- ERPNext lookups ----------------

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function phoneOf(doc: ErpDoc, tenant: Tenant): string | undefined {
  const raw = str(doc.whatsapp_no) ?? str(doc.mobile_no) ?? str(doc.contact_mobile) ?? str(doc.phone) ?? str(doc.contact_phone);
  if (!raw) return undefined;
  try {
    return normalizePhone(raw, tenant.country);
  } catch {
    return undefined;
  }
}

async function safeGet(erp: ErpClient, doctype: string, name: string | undefined): Promise<ErpDoc | undefined> {
  if (!name) return undefined;
  try {
    return await erp.get(doctype, name);
  } catch {
    return undefined;
  }
}

/** Customer display name + WhatsApp number, from a Customer, Lead or Prospect party. */
async function party(erp: ErpClient, tenant: Tenant, type: string | undefined, name: string | undefined) {
  const doc = await safeGet(erp, type === 'Lead' ? 'Lead' : 'Customer', name);
  if (!doc) return { customerName: name ?? null, customerPhone: null };
  return {
    customerName: str(doc.customer_name) ?? str(doc.lead_name) ?? str(doc.company_name) ?? name ?? null,
    customerPhone: phoneOf(doc, tenant) ?? null,
  };
}

function assignees(doc: ErpDoc): string[] {
  try {
    const v = typeof doc._assign === 'string' ? JSON.parse(doc._assign) : doc._assign;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------- Event handler ----------------

export interface LifecycleEventJob {
  tenantId: string;
  doctype: LifecycleDoctype;
  name: string;
  event: LifecycleEvent;
}

/** lifecycle.event — map one ERPNext document change onto lifecycle timers. Always re-reads the document from ERPNext. */
export async function handleLifecycleEvent(c: Container, j: LifecycleEventJob, now = new Date()) {
  const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUnique({ where: { id: j.tenantId } }));
  if (!tenant?.erpApiKeyEnc) return { status: 'skipped' };
  // Only tenants with an installed playbook use the lifecycle (customer businesses' ERPNext sites are untouched).
  const rules = await withSystemTx(c.prisma, (tx) => tx.lifecycleRule.count({ where: { tenantId: tenant.id } }));
  if (rules === 0) return { status: 'not_enabled' };
  const erp = c.erp(tenant);
  const { settings } = erpContext(tenant);
  const tz = settings.timezone;
  const hour = settings.reminders.hourLocal;
  const T = (v: unknown) => erpTime(v, tz, hour);
  const tid = tenant.id;

  if (j.event === 'on_trash') {
    const n = await withSystemTx(c.prisma, (tx) =>
      tx.lifecycleTimer.updateMany({ where: { tenantId: tid, doctype: j.doctype, docName: j.name, status: 'open' }, data: { status: 'cancelled', completedAt: now } }),
    );
    return { status: 'cancelled', count: n.count };
  }

  const doc = await safeGet(erp, j.doctype, j.name);
  if (!doc) return { status: 'not_found' };

  switch (j.doctype) {
    case 'Lead': {
      const status = str(doc.status) ?? 'Lead';
      if (['Lead', 'Open'].includes(status)) {
        const owner = await pickOwner(c, tid, 'sales', str(doc.lead_owner));
        if (owner?.erpUser && !str(doc.lead_owner)) {
          await erp.update('Lead', j.name, { lead_owner: owner.erpUser }).catch(() => undefined);
          await erp.assign('Lead', j.name, [owner.erpUser], 'Call within 1 hour').catch(() => undefined);
        }
        const base = {
          doctype: 'Lead',
          docName: j.name,
          anchorAt: T(doc.creation) ?? now,
          owner,
          customerName: str(doc.lead_name) ?? str(doc.company_name) ?? j.name,
          customerPhone: phoneOf(doc, tenant),
          context: { lead_name: str(doc.lead_name) ?? j.name, source: str(doc.source) ?? 'website', phone: phoneOf(doc, tenant) },
        };
        await startTimer(c, tid, { ...base, ruleKey: 'lead.assign' }, now);
        await startTimer(c, tid, { ...base, ruleKey: 'lead.first_call' }, now);
      } else {
        await closeTimers(c, tid, ['lead.first_call'], 'Lead', j.name, ['Do Not Contact'].includes(status) ? 'cancelled' : 'done');
      }
      return { status: 'ok' };
    }

    case 'Opportunity': {
      if (str(doc.opportunity_from) === 'Lead' && str(doc.party_name)) await closeTimers(c, tid, ['lead.first_call'], 'Lead', str(doc.party_name)!);
      const status = str(doc.status) ?? 'Open';
      if (['Lost', 'Closed'].includes(status)) {
        await closeTimers(c, tid, ['demo.outcome', 'proposal.send'], 'Opportunity', j.name, 'cancelled');
        return { status: 'ok' };
      }
      if (str(doc[CF.demoOutcome])) await closeTimers(c, tid, ['demo.outcome'], 'Opportunity', j.name);
      if (/proposal|quot/i.test(str(doc.sales_stage) ?? '')) {
        const p = await party(erp, tenant, str(doc.opportunity_from), str(doc.party_name));
        await startTimer(c, tid, { ruleKey: 'proposal.send', doctype: 'Opportunity', docName: j.name, anchorAt: now, ...p, customerName: str(doc.customer_name) ?? p.customerName }, now);
      }
      return { status: 'ok' };
    }

    case 'Event': {
      const link = (Array.isArray(doc.event_participants) ? (doc.event_participants as ErpDoc[]) : []).find((p) => p.reference_doctype === 'Opportunity');
      const oppName = str(link?.reference_docname);
      if (!oppName) return { status: 'ignored' };
      const opp = await safeGet(erp, 'Opportunity', oppName);
      const p = opp ? await party(erp, tenant, str(opp.opportunity_from), str(opp.party_name)) : { customerName: null, customerPhone: null };
      const customerName = str(opp?.customer_name) ?? p.customerName;
      const customerPhone = (opp && phoneOf(opp, tenant)) ?? p.customerPhone;
      const ownerErpUser = str(opp?.opportunity_owner) ?? str(doc.owner);
      const status = str(doc.status) ?? 'Open';
      if (status === 'Cancelled') {
        await closeTimers(c, tid, ['demo.reminder'], 'Event', j.name, 'cancelled');
      } else if (status === 'Completed' || status === 'Closed') {
        await closeTimers(c, tid, ['demo.reminder'], 'Event', j.name);
        await startTimer(c, tid, { ruleKey: 'demo.outcome', doctype: 'Opportunity', docName: oppName, anchorAt: now, ownerErpUser, customerName, customerPhone, context: { event: j.name } }, now);
      } else {
        const start = T(doc.starts_on);
        if (!start) return { status: 'ignored' };
        const startLocal = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(start);
        await startTimer(c, tid, { ruleKey: 'demo.reminder', doctype: 'Event', docName: j.name, anchorAt: start, ownerErpUser, customerName, customerPhone, context: { start_time: startLocal, opportunity: oppName } }, now);
      }
      return { status: 'ok' };
    }

    case 'Quotation': {
      const oppName = str(doc.opportunity);
      if (j.event === 'on_cancel' || ['Lost', 'Cancelled'].includes(str(doc.status) ?? '')) {
        await closeTimers(c, tid, ['proposal.followup'], 'Quotation', j.name, 'cancelled');
        return { status: 'ok' };
      }
      if (str(doc.status) === 'Ordered') {
        await closeTimers(c, tid, ['proposal.followup'], 'Quotation', j.name);
        return { status: 'ok' };
      }
      if (doc.docstatus === 1) {
        if (oppName) await closeTimers(c, tid, ['proposal.send'], 'Opportunity', oppName);
        const p = await party(erp, tenant, str(doc.quotation_to), str(doc.party_name));
        await startTimer(
          c,
          tid,
          { ruleKey: 'proposal.followup', doctype: 'Quotation', docName: j.name, anchorAt: T(doc.modified) ?? now, ...p, customerName: str(doc.customer_name) ?? p.customerName, context: { amount: `${doc.currency ?? ''} ${doc.grand_total ?? ''}`.trim(), opportunity: oppName } },
          now,
        );
      }
      return { status: 'ok' };
    }

    case 'Sales Order': {
      if (doc.docstatus !== 1) return { status: 'ignored' };
      const quotations = new Set((Array.isArray(doc.items) ? (doc.items as ErpDoc[]) : []).map((i) => str(i.prevdoc_docname)).filter(Boolean) as string[]);
      for (const q of quotations) await closeTimers(c, tid, ['proposal.followup'], 'Quotation', q);
      const p = await party(erp, tenant, 'Customer', str(doc.customer));
      await startTimer(c, tid, { ruleKey: 'deal.won', doctype: 'Sales Order', docName: j.name, anchorAt: now, ...p, context: { amount: `${doc.currency ?? ''} ${doc.grand_total ?? ''}`.trim() } }, now);
      return { status: 'ok' };
    }

    case 'Sales Invoice': {
      if (j.event === 'on_cancel' || doc.docstatus === 2) {
        await closeTimers(c, tid, ['invoice.due', 'collection.overdue'], 'Sales Invoice', j.name, 'cancelled');
        return { status: 'ok' };
      }
      if (doc.docstatus !== 1) return { status: 'ignored' };
      if (Number(doc.outstanding_amount ?? 0) <= 0) {
        await closeTimers(c, tid, ['invoice.due', 'collection.overdue'], 'Sales Invoice', j.name);
        return { status: 'ok' };
      }
      const due = T(doc.due_date) ?? T(doc.posting_date) ?? now;
      const p = await party(erp, tenant, 'Customer', str(doc.customer));
      const s = { doctype: 'Sales Invoice', docName: j.name, anchorAt: due, ...p, context: { amount: `${doc.currency ?? ''} ${doc.outstanding_amount ?? doc.grand_total ?? ''}`.trim(), due_date: str(doc.due_date) } };
      await startTimer(c, tid, { ...s, ruleKey: 'invoice.due' }, now);
      await startTimer(c, tid, { ...s, ruleKey: 'collection.overdue' }, now);
      return { status: 'ok' };
    }

    case 'Payment Entry': {
      if (doc.docstatus !== 1 || str(doc.payment_type) !== 'Receive' || str(doc.party_type) !== 'Customer') return { status: 'ignored' };
      // Paid invoices: close their payment and collection timers.
      for (const ref of Array.isArray(doc.references) ? (doc.references as ErpDoc[]) : []) {
        if (ref.reference_doctype !== 'Sales Invoice') continue;
        const inv = await safeGet(erp, 'Sales Invoice', str(ref.reference_name));
        if (inv && Number(inv.outstanding_amount ?? 0) <= 0) await closeTimers(c, tid, ['invoice.due', 'collection.overdue'], 'Sales Invoice', String(inv.name));
      }
      // First payment from this customer → create the onboarding Project from the template.
      const handover = await withSystemTx(c.prisma, (tx) => tx.lifecycleRule.findUnique({ where: { tenantId_key: { tenantId: tid, key: 'handover.project' } } }));
      if (!handover?.enabled) return { status: 'ok' };
      const customer = str(doc.party)!;
      const projects = await erp.list('Project', { filters: { customer }, fields: ['name'], limit: 1 });
      if (projects.length > 0) return { status: 'ok' };
      const owner = await pickOwner(c, tid, 'onboarding');
      const project = await erp.create('Project', {
        project_name: `${str(doc.party_name) ?? customer} — Onboarding`,
        customer,
        project_template: ONBOARDING_TEMPLATE,
        expected_start_date: localDate(tz, now),
        [CF.projectStage]: 'Kickoff',
      });
      const projectName = String(project.name);
      if (owner?.erpUser) await erp.assign('Project', projectName, [owner.erpUser], 'Onboarding: first payment received').catch(() => undefined);
      const p = await party(erp, tenant, 'Customer', customer);
      const s = { doctype: 'Project', docName: projectName, anchorAt: now, owner, ...p, context: { project: projectName, payment: j.name } };
      await startTimer(c, tid, { ...s, ruleKey: 'handover.project' }, now);
      await startTimer(c, tid, { ...s, ruleKey: 'kickoff.data' }, now);
      return { status: 'project_created', project: projectName };
    }

    case 'Project': {
      const stage = str(doc[CF.projectStage]) ?? '';
      const status = str(doc.status) ?? 'Open';
      if (status === 'Cancelled') {
        await withSystemTx(c.prisma, (tx) => tx.lifecycleTimer.updateMany({ where: { tenantId: tid, doctype: 'Project', docName: j.name, status: 'open' }, data: { status: 'cancelled', completedAt: now } }));
        return { status: 'ok' };
      }
      if (!PRE_DATA_STAGES.has(stage)) await closeTimers(c, tid, ['kickoff.data'], 'Project', j.name);
      if (stage === 'Live') {
        const p = await party(erp, tenant, 'Customer', str(doc.customer));
        const s = { doctype: 'Project', docName: j.name, anchorAt: now, ...p, context: { project: j.name } };
        // Owners: go-live → onboarding (assignee); reviews → QA.
        await startTimer(c, tid, { ...s, ruleKey: 'golive', ownerErpUser: assignees(doc)[0] }, now);
        await startTimer(c, tid, { ...s, ruleKey: 'review.day7' }, now);
        await startTimer(c, tid, { ...s, ruleKey: 'review.day30' }, now);
      }
      return { status: 'ok' };
    }

    case 'Task': {
      const status = str(doc.status) ?? 'Open';
      if (['Completed', 'Cancelled'].includes(status)) {
        await closeTimers(c, tid, ['task.due'], 'Task', j.name, status === 'Completed' ? 'done' : 'cancelled');
        return { status: 'ok' };
      }
      const end = T(doc.exp_end_date);
      if (!end) return { status: 'ignored' };
      const project = await safeGet(erp, 'Project', str(doc.project));
      const p = await party(erp, tenant, 'Customer', str(project?.customer));
      await startTimer(
        c,
        tid,
        { ruleKey: 'task.due', doctype: 'Task', docName: j.name, anchorAt: end, ownerErpUser: assignees(doc)[0], ...p, customerPhone: null, context: { subject: str(doc.subject) ?? j.name, project: str(doc.project) } },
        now,
      );
      return { status: 'ok' };
    }

    case 'Issue': {
      const status = str(doc.status) ?? 'Open';
      const p = await party(erp, tenant, 'Customer', str(doc.customer));
      const customerPhone = p.customerPhone ?? phoneOf(doc, tenant) ?? null;
      const s = { doctype: 'Issue', docName: j.name, anchorAt: T(doc.opening_date ? `${doc.opening_date} ${doc.opening_time ?? '00:00:00'}` : doc.creation) ?? now, ...p, customerPhone, ownerErpUser: assignees(doc)[0], context: { subject: str(doc.subject) } };
      if (['Resolved', 'Closed'].includes(status)) {
        await closeTimers(c, tid, ['support.issue'], 'Issue', j.name);
        await startTimer(c, tid, { ...s, ruleKey: 'support.resolved', anchorAt: now }, now);
      } else {
        await startTimer(c, tid, { ...s, ruleKey: 'support.issue' }, now);
      }
      return { status: 'ok' };
    }

    case 'Subscription': {
      const status = str(doc.status) ?? 'Active';
      if (status === 'Cancelled' || status === 'Completed') {
        await closeTimers(c, tid, ['renewal'], 'Subscription', j.name, 'cancelled');
        return { status: 'ok' };
      }
      const end = T(doc.end_date) ?? T(doc.current_invoice_end);
      if (!end) return { status: 'ignored' };
      const p = await party(erp, tenant, str(doc.party_type), str(doc.party));
      // Renewed (end date moved) → the timer re-anchors and the 30/15/7-day levels fire again for the new term.
      const existing = await withSystemTx(c.prisma, (tx) => tx.lifecycleTimer.findFirst({ where: { tenantId: tid, doctype: 'Subscription', docName: j.name, rule: { key: 'renewal' } } }));
      if (existing && existing.anchorAt.getTime() !== end.getTime()) {
        await withSystemTx(c.prisma, (tx) => tx.lifecycleTimer.update({ where: { id: existing.id }, data: { status: 'open', sentLevels: [], completedAt: null } }));
      }
      await startTimer(c, tid, { ruleKey: 'renewal', doctype: 'Subscription', docName: j.name, anchorAt: end, ...p, context: { end_date: localDate(tz, end) } }, now);
      return { status: 'ok' };
    }
  }
  logger.debug({ tenantId: tid, doctype: j.doctype }, 'lifecycle event ignored');
  return { status: 'ignored' };
}

// ---------------- Monthly bot update ----------------

/** On the 1st of each month (tenant local, at the reminder hour), start the monthly-update timer for every live Project. */
export async function startMonthlyUpdates(c: Container, tenant: Tenant, now = new Date()) {
  const { settings } = erpContext(tenant);
  const today = localDate(settings.timezone, now);
  if (!today.endsWith('-01') || localHour(settings.timezone, now) !== settings.reminders.hourLocal) return 0;
  const rule = await withSystemTx(c.prisma, (tx) => tx.lifecycleRule.findUnique({ where: { tenantId_key: { tenantId: tenant.id, key: 'bot.monthly_update' } } }));
  if (!rule?.enabled) return 0;
  const erp = c.erp(tenant);
  const live = await erp.list('Project', { filters: { [CF.projectStage]: 'Live' }, fields: ['name', 'customer', '_assign'], limit: 500 });
  const month = today.slice(0, 7);
  for (const pr of live) {
    const p = await party(erp, tenant, 'Customer', str(pr.customer));
    await startTimer(c, tenant.id, { ruleKey: 'bot.monthly_update', doctype: 'Project', docName: `${pr.name}@${month}`, anchorAt: now, ...p, context: { project: String(pr.name), month } }, now);
  }
  return live.length;
}
