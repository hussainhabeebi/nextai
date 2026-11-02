import { QUEUES, type QueueName } from '@nextai/shared';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/** Every job carries tenantId (except cross-tenant schedulers, which fan out per tenant). */
export interface JobData {
  tenantId: string;
  [k: string]: unknown;
}

export interface JobQueue {
  enqueue(name: QueueName, data: JobData, opts?: { jobId?: string; delayMs?: number; priority?: number }): Promise<void>;
}

export const DEFAULT_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

export class BullJobQueue implements JobQueue {
  private readonly queues = new Map<string, Queue>();
  constructor(private readonly connection: Redis) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTS });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue(name: QueueName, data: JobData, opts: { jobId?: string; delayMs?: number; priority?: number } = {}) {
    if (!data.tenantId) throw new Error(`Job ${name} missing tenantId`);
    await this.queue(name).add(name, data, { jobId: opts.jobId, delay: opts.delayMs, priority: opts.priority });
  }

  allQueues(): Queue[] {
    return Object.values(QUEUES).map((n) => this.queue(n));
  }

  async close() {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

/** Test/dev queue: records jobs; optionally runs a handler inline. */
export class MemoryJobQueue implements JobQueue {
  jobs: Array<{ name: QueueName; data: JobData }> = [];
  handler?: (name: QueueName, data: JobData) => Promise<void>;
  async enqueue(name: QueueName, data: JobData) {
    if (!data.tenantId) throw new Error(`Job ${name} missing tenantId`);
    this.jobs.push({ name, data });
    if (this.handler) await this.handler(name, data);
  }
  take(name?: QueueName) {
    const out = this.jobs.filter((j) => !name || j.name === name);
    this.jobs = this.jobs.filter((j) => name && j.name !== name);
    return out;
  }
}
