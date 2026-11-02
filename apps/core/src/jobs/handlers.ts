import { QUEUES, type QueueName } from '@nextai/shared';
import { z } from 'zod';
import type { Container } from '../container.js';
import { postDraft } from '../modules/drafts/service.js';
import { processOcr } from '../modules/ocr/pipeline.js';
import { processVoice } from '../modules/voice/pipeline.js';
import { sendInvoice, sendReceipt, sendReminder } from '../modules/outbound/jobs.js';
import { billingSync } from '../modules/billing/service.js';
import { healthErpnext, scheduleDailySummary, scheduleReminders, usageRollup } from '../modules/scheduling/schedulers.js';

const tenantId = z.string().uuid();
export const jobSchemas = {
  [QUEUES.ocr]: z.object({ tenantId, documentId: z.string().uuid(), conversationId: z.number().optional(), userId: z.string().uuid().optional() }),
  [QUEUES.voice]: z.object({ tenantId, r2Key: z.string(), mime: z.string(), conversationId: z.number(), userId: z.string().uuid() }),
  [QUEUES.draftPost]: z.object({ tenantId, draftId: z.string().uuid() }),
  [QUEUES.outboundInvoice]: z.object({ tenantId, invoiceName: z.string(), draftId: z.string().uuid().optional() }),
  [QUEUES.outboundReceipt]: z.object({ tenantId, paymentName: z.string() }),
  [QUEUES.outboundReminder]: z.object({ tenantId, invoiceName: z.string().optional(), party: z.string().optional(), conversationId: z.number().optional() }),
} as const;
const fanOut = z.object({ tenantId: z.literal('*') });

export type JobHandler = (data: unknown) => Promise<unknown>;

/** Job handlers shared by apps/worker (BullMQ) and tests (inline). Every payload is validated and tenant-scoped. */
export function jobHandlers(c: Container): Partial<Record<QueueName, JobHandler>> {
  return {
    [QUEUES.ocr]: (d) => processOcr(c, jobSchemas[QUEUES.ocr].parse(d)),
    [QUEUES.voice]: (d) => processVoice(c, jobSchemas[QUEUES.voice].parse(d)),
    [QUEUES.draftPost]: (d) => {
      const j = jobSchemas[QUEUES.draftPost].parse(d);
      return postDraft(c, j.tenantId, j.draftId);
    },
    [QUEUES.outboundInvoice]: (d) => sendInvoice(c, jobSchemas[QUEUES.outboundInvoice].parse(d)),
    [QUEUES.outboundReceipt]: (d) => sendReceipt(c, jobSchemas[QUEUES.outboundReceipt].parse(d)),
    [QUEUES.outboundReminder]: (d) => sendReminder(c, jobSchemas[QUEUES.outboundReminder].parse(d)),
    [QUEUES.scheduleReminders]: (d) => (fanOut.parse(d), scheduleReminders(c)),
    [QUEUES.scheduleDailySummary]: (d) => (fanOut.parse(d), scheduleDailySummary(c)),
    [QUEUES.usageRollup]: (d) => (fanOut.parse(d), usageRollup(c)),
    [QUEUES.healthErpnext]: (d) => (fanOut.parse(d), healthErpnext(c)),
    [QUEUES.billingSync]: (d) => (fanOut.parse(d), billingSync(c)),
  };
}
