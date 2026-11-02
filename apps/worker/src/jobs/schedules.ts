import type { Container } from '@nextai/core';
import { QUEUES, type QueueName } from '@nextai/shared';

export const SCHEDULES: Array<{ id: string; queue: QueueName; cron: string }> = [];

/** Cross-tenant scheduler handlers (filled in milestone 4). */
export function schedulerHandlers(_c: Container): Partial<Record<QueueName, (d: unknown) => Promise<unknown>>> {
  void QUEUES;
  return {};
}
