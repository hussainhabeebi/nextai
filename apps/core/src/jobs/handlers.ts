import { QUEUES, type QueueName } from '@nextai/shared';
import { z } from 'zod';
import type { Container } from '../container.js';
import { postDraft } from '../modules/drafts/service.js';
import { processOcr } from '../modules/ocr/pipeline.js';
import { setupTenantErp } from '../modules/erpnext/company-setup.js';
import { processVoice } from '../modules/voice/pipeline.js';
import { processStatementJob } from '../modules/banking/jobs.js';
import { sendInvoice, sendReceipt, sendReminder } from '../modules/outbound/jobs.js';
import { billingSync } from '../modules/billing/service.js';
import { sendAdminDailyReport } from '../modules/email/reports.js';
import { LIFECYCLE_DOCTYPES, LIFECYCLE_EVENTS, handleLifecycleEvent } from '../modules/lifecycle/events.js';
import { healthErpnext, lifecycleScan, scheduleDailySummary, scheduleDeadlines, scheduleOffice, scheduleReminders, usageRollup } from '../modules/scheduling/schedulers.js';
import { executeAuditRun, scheduleAudits } from '../modules/audit-copilot/service.js';
import { hasFeature } from '../modules/billing/gating.js';
import { submitEInvoice } from '../modules/einvoice/service.js';

const tenantId = z.string().uuid();
export const jobSchemas = {
  [QUEUES.ocr]: z.object({ tenantId, documentId: z.string().uuid(), conversationId: z.number().optional(), userId: z.string().uuid().optional() }),
  [QUEUES.voice]: z.object({ tenantId, r2Key: z.string(), mime: z.string(), conversationId: z.number(), userId: z.string().uuid() }),
  [QUEUES.draftPost]: z.object({ tenantId, draftId: z.string().uuid() }),
  [QUEUES.tenantSetup]: z.object({ tenantId }),
  [QUEUES.outboundInvoice]: z.object({ tenantId, invoiceName: z.string(), draftId: z.string().uuid().optional() }),
  [QUEUES.outboundReceipt]: z.object({ tenantId, paymentName: z.string() }),
  [QUEUES.outboundReminder]: z.object({ tenantId, invoiceName: z.string().optional(), party: z.string().optional(), conversationId: z.number().optional() }),
  [QUEUES.lifecycleEvent]: z.object({ tenantId, doctype: z.enum(LIFECYCLE_DOCTYPES), name: z.string().min(1).max(140), event: z.enum(LIFECYCLE_EVENTS) }),
  [QUEUES.bankStatement]: z.object({ tenantId, r2Key: z.string(), mime: z.string(), name: z.string().optional(), conversationId: z.number().optional(), userId: z.string().uuid().optional() }),
  [QUEUES.einvoiceSubmit]: z.object({ tenantId, invoiceName: z.string().min(1).max(140), sendAfter: z.boolean().optional(), draftId: z.string().uuid().optional(), force: z.boolean().optional() }),
  [QUEUES.auditRun]: z.object({ tenantId, runId: z.string().uuid() }),
} as const;
const fanOut = z.object({ tenantId: z.literal('*') });

export type JobHandler = (data: unknown) => Promise<unknown>;

/** Job handlers shared by apps/worker (BullMQ) and tests (inline). Every payload is validated and tenant-scoped. */
export function jobHandlers(c: Container): Partial<Record<QueueName, JobHandler>> {
  return {
    [QUEUES.ocr]: (d) => processOcr(c, jobSchemas[QUEUES.ocr].parse(d)),
    [QUEUES.tenantSetup]: (d) => setupTenantErp(c, jobSchemas[QUEUES.tenantSetup].parse(d).tenantId),
    [QUEUES.voice]: (d) => processVoice(c, jobSchemas[QUEUES.voice].parse(d)),
    [QUEUES.bankStatement]: (d) => processStatementJob(c, jobSchemas[QUEUES.bankStatement].parse(d)),
    [QUEUES.draftPost]: (d) => {
      const j = jobSchemas[QUEUES.draftPost].parse(d);
      return postDraft(c, j.tenantId, j.draftId);
    },
    [QUEUES.outboundInvoice]: (d) => sendInvoice(c, jobSchemas[QUEUES.outboundInvoice].parse(d)),
    [QUEUES.outboundReceipt]: (d) => sendReceipt(c, jobSchemas[QUEUES.outboundReceipt].parse(d)),
    [QUEUES.outboundReminder]: (d) => sendReminder(c, jobSchemas[QUEUES.outboundReminder].parse(d)),
    [QUEUES.lifecycleEvent]: (d) => handleLifecycleEvent(c, jobSchemas[QUEUES.lifecycleEvent].parse(d)),
    [QUEUES.lifecycleScan]: (d) => (fanOut.parse(d), lifecycleScan(c)),
    [QUEUES.officeTick]: (d) => (fanOut.parse(d), scheduleOffice(c)),
    [QUEUES.scheduleReminders]: (d) => (fanOut.parse(d), scheduleReminders(c)),
    [QUEUES.scheduleDailySummary]: (d) => (fanOut.parse(d), scheduleDailySummary(c)),
    [QUEUES.scheduleDeadlines]: (d) => (fanOut.parse(d), scheduleDeadlines(c)),
    [QUEUES.usageRollup]: (d) => (fanOut.parse(d), usageRollup(c)),
    [QUEUES.healthErpnext]: (d) => (fanOut.parse(d), healthErpnext(c)),
    [QUEUES.billingSync]: (d) => (fanOut.parse(d), billingSync(c)),
    [QUEUES.reportAdminDaily]: (d) => (fanOut.parse(d), sendAdminDailyReport(c)),
    [QUEUES.einvoiceSubmit]: (d) => submitEInvoice(c, jobSchemas[QUEUES.einvoiceSubmit].parse(d)),
    [QUEUES.auditRun]: (d) => {
      const j = jobSchemas[QUEUES.auditRun].parse(d);
      return executeAuditRun(c, j.tenantId, j.runId);
    },
    [QUEUES.scheduleAudit]: (d) => (fanOut.parse(d), scheduleAudits(c, (t) => hasFeature(c, t, 'audit_copilot'))),
  };
}
