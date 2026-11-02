import type { Redis } from 'ioredis';

/**
 * Per-tenant concurrency limit across all worker processes (BullMQ OSS has no group limits).
 * A Redis counter per (queue, tenant) with a safety TTL; acquire fails fast when the tenant is at its cap.
 */
export class TenantSemaphore {
  constructor(
    private readonly redis: Redis,
    private readonly limit: number,
    private readonly ttlSeconds = 600,
  ) {}

  private key(queue: string, tenantId: string) {
    return `sem:${queue}:${tenantId}`;
  }

  async acquire(queue: string, tenantId: string): Promise<boolean> {
    const k = this.key(queue, tenantId);
    const n = await this.redis.incr(k);
    await this.redis.expire(k, this.ttlSeconds);
    if (n > this.limit) {
      await this.redis.decr(k);
      return false;
    }
    return true;
  }

  async release(queue: string, tenantId: string): Promise<void> {
    const k = this.key(queue, tenantId);
    const n = await this.redis.decr(k);
    if (n <= 0) await this.redis.del(k);
  }
}
