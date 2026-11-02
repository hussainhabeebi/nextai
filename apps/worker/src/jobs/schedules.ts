import { SCHEDULE_QUEUES } from '@nextai/core';
import type { QueueName } from '@nextai/shared';

/** Repeatable cross-tenant schedulers; handlers live in @nextai/core jobHandlers. */
export const SCHEDULES: Array<{ id: string; queue: QueueName; cron: string }> = Object.entries(SCHEDULE_QUEUES).map(([queue, cron]) => ({
  id: `sched:${queue}`,
  queue: queue as QueueName,
  cron,
}));
