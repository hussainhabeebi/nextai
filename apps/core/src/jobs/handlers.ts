import { QUEUES, type QueueName } from '@nextai/shared';
import { z } from 'zod';
import type { Container } from '../container.js';
import { postDraft } from '../modules/drafts/service.js';
import { processOcr } from '../modules/ocr/pipeline.js';
import { processVoice } from '../modules/voice/pipeline.js';

const tenantId = z.string().uuid();
export const jobSchemas = {
  [QUEUES.ocr]: z.object({ tenantId, documentId: z.string().uuid(), conversationId: z.number().optional(), userId: z.string().uuid().optional() }),
  [QUEUES.voice]: z.object({ tenantId, r2Key: z.string(), mime: z.string(), conversationId: z.number(), userId: z.string().uuid() }),
  [QUEUES.draftPost]: z.object({ tenantId, draftId: z.string().uuid() }),
} as const;

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
  };
}
