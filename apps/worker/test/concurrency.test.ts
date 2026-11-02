import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { TenantSemaphore } from '../src/concurrency.js';

const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2');
afterAll(() => redis.disconnect());

describe('TenantSemaphore', () => {
  it('caps concurrent jobs per tenant without affecting other tenants', async () => {
    const sem = new TenantSemaphore(redis, 2);
    const q = `q-${Date.now()}`;
    expect(await sem.acquire(q, 'A')).toBe(true);
    expect(await sem.acquire(q, 'A')).toBe(true);
    expect(await sem.acquire(q, 'A')).toBe(false);
    expect(await sem.acquire(q, 'B')).toBe(true);
    await sem.release(q, 'A');
    expect(await sem.acquire(q, 'A')).toBe(true);
  });
});
