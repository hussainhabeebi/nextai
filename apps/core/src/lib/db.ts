import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Multi-tenant database access.
 *
 * Two layers of isolation:
 *  1. `tenantDb(base, tenantId)` – Prisma client extension that injects `tenantId` into every
 *     where/data clause for tenant-owned models, overriding anything the caller supplied.
 *  2. Postgres RLS – every query from the extension runs in a transaction that first does
 *     `set_config('app.tenant_id', <id>, true)`, so even a raw/forgotten filter cannot cross tenants.
 *
 * `systemDb(base)` sets `app.bypass_rls = on` and must only be used for: webhook tenant resolution,
 * cross-tenant scheduler fan-out, login lookup by phone, and audited admin actions.
 */

export const TENANT_MODELS = new Set<string>([
  'User',
  'Session',
  'Document',
  'Draft',
  'VendorMapping',
  'Subscription',
  'UsageCounter',
  'AuditLog',
  'OutboundMessage',
  'PushSubscription',
  'WebhookEvent',
]);

const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);

export class TenantScopeError extends Error {}

type AnyArgs = Record<string, unknown> & {
  where?: Record<string, unknown>;
  data?: unknown;
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};

/** Exported for unit tests. Returns a new args object scoped to tenantId. */
export function scopeArgs(model: string | undefined, operation: string, args: unknown, tenantId: string): unknown {
  if (!model || !TENANT_MODELS.has(model)) return args;
  const a: AnyArgs = { ...((args as AnyArgs) ?? {}) };

  const assertNoMove = (data: unknown): void => {
    if (data && typeof data === 'object' && 'tenantId' in data && (data as { tenantId: unknown }).tenantId !== tenantId) {
      throw new TenantScopeError(`Refusing to change tenantId on ${model}`);
    }
    if (data && typeof data === 'object' && 'tenant' in data) {
      throw new TenantScopeError(`Refusing relation write to tenant on ${model}`);
    }
  };
  const withTenant = (data: unknown): Record<string, unknown> => {
    const d = { ...(data as Record<string, unknown>) };
    delete d.tenant;
    d.tenantId = tenantId;
    return d;
  };

  if (WHERE_OPS.has(operation)) {
    a.where = { ...(a.where ?? {}), tenantId };
  }
  switch (operation) {
    case 'create':
      a.data = withTenant(a.data);
      break;
    case 'createMany':
    case 'createManyAndReturn':
      a.data = Array.isArray(a.data) ? a.data.map(withTenant) : withTenant(a.data);
      break;
    case 'update':
    case 'updateMany':
    case 'updateManyAndReturn':
      assertNoMove(a.data);
      break;
    case 'upsert':
      a.create = withTenant(a.create);
      assertNoMove(a.update);
      break;
  }
  return a;
}

export function createPrisma(url?: string): PrismaClient {
  return new PrismaClient({
    datasources: url ? { db: { url } } : undefined,
    log: [{ level: 'warn', emit: 'stdout' }],
  });
}

export function tenantDb(base: PrismaClient, tenantId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new TenantScopeError('Invalid tenant id');
  return base.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const scoped = scopeArgs(model, operation, args, tenantId) as typeof args;
          const [, result] = await base.$transaction([
            base.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
            query(scoped),
          ]);
          return result;
        },
      },
    },
  });
}

export function systemDb(base: PrismaClient) {
  return base.$extends({
    name: 'system-bypass',
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await base.$transaction([
            base.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof tenantDb>;
export type SystemDb = ReturnType<typeof systemDb>;
export type Tx = Prisma.TransactionClient;

/** Interactive transaction pinned to a tenant (RLS enforced). Callers still pass tenantId explicitly. */
export async function withTenantTx<T>(base: PrismaClient, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return base.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

/** Interactive transaction with RLS bypass (system context). */
export async function withSystemTx<T>(base: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return base.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return fn(tx);
  });
}
