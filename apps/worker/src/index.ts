import { BullJobQueue, createContainer, env, jobHandlers, logger } from '@nextai/core';
import { QUEUES, type QueueName } from '@nextai/shared';
import { DelayedError, Queue, Worker, type Job } from 'bullmq';
import { TenantSemaphore } from './concurrency.js';
import { schedulerHandlers, SCHEDULES } from './jobs/schedules.js';

process.env.SERVICE_NAME ??= 'worker';
const c = createContainer();
env();
const connection = c.redis;
const handlers = { ...jobHandlers(c), ...schedulerHandlers(c) };

/** Global throughput limits (per queue, across all tenants) and per-queue worker concurrency. */
const QUEUE_CONFIG: Partial<Record<QueueName, { concurrency: number; limiter?: { max: number; duration: number }; perTenant: number }>> = {
  [QUEUES.ocr]: { concurrency: 8, limiter: { max: 60, duration: 60_000 }, perTenant: 2 },
  [QUEUES.voice]: { concurrency: 4, limiter: { max: 60, duration: 60_000 }, perTenant: 2 },
  [QUEUES.draftPost]: { concurrency: 8, limiter: { max: 120, duration: 60_000 }, perTenant: 1 }, // serialize ERPNext writes per tenant
  [QUEUES.outboundInvoice]: { concurrency: 4, limiter: { max: 80, duration: 60_000 }, perTenant: 2 },
  [QUEUES.outboundReceipt]: { concurrency: 4, limiter: { max: 80, duration: 60_000 }, perTenant: 2 },
  [QUEUES.outboundReminder]: { concurrency: 4, limiter: { max: 80, duration: 60_000 }, perTenant: 2 },
};

const deadLetter = new Queue(QUEUES.deadLetter, { connection });
const workers: Worker[] = [];

for (const [name, handler] of Object.entries(handlers) as Array<[QueueName, (d: unknown) => Promise<unknown>]>) {
  const cfg = QUEUE_CONFIG[name] ?? { concurrency: 1, perTenant: 1 };
  const sem = new TenantSemaphore(connection, cfg.perTenant);
  const worker = new Worker(
    name,
    async (job: Job, token?: string) => {
      const tenantId = (job.data as { tenantId?: string }).tenantId;
      if (!tenantId) throw new Error(`Job ${job.id} has no tenantId`);
      const scoped = tenantId !== '*';
      if (scoped && !(await sem.acquire(name, tenantId))) {
        // tenant at its concurrency cap → retry shortly without consuming an attempt
        await job.moveToDelayed(Date.now() + 1500 + Math.floor(Math.random() * 1000), token);
        throw new DelayedError();
      }
      try {
        return await handler(job.data);
      } finally {
        if (scoped) await sem.release(name, tenantId);
      }
    },
    { connection, concurrency: cfg.concurrency, limiter: cfg.limiter },
  );
  worker.on('failed', async (job, err) => {
    if (!job) return;
    const final = job.attemptsMade >= (job.opts.attempts ?? 1);
    logger.warn({ queue: name, jobId: job.id, tenantId: job.data?.tenantId, attempt: job.attemptsMade, final, err: err.message }, 'job failed');
    if (final) {
      await deadLetter.add('dead', { queue: name, jobId: job.id, tenantId: job.data?.tenantId, data: job.data, error: err.message, failedAt: new Date().toISOString() });
      logger.error({ queue: name, jobId: job.id, tenantId: job.data?.tenantId, alert: true }, 'job moved to dead-letter queue');
      // TODO(alerting): forward to Sentry (SENTRY_DSN) / PagerDuty.
    }
  });
  workers.push(worker);
}

// Repeatable schedulers (cross-tenant fan-out jobs use tenantId "*").
const q = new BullJobQueue(connection);
for (const s of SCHEDULES) {
  await q.queue(s.queue).upsertJobScheduler(s.id, { pattern: s.cron }, { name: s.queue, data: { tenantId: '*' } });
}
logger.info({ queues: Object.keys(handlers) }, 'worker started');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await Promise.all(workers.map((w) => w.close()));
    await deadLetter.close();
    await q.close();
    await c.close();
    process.exit(0);
  });
}
