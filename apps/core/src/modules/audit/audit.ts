import type { ActorType, Channel, Prisma, PrismaClient } from '@prisma/client';
import { withSystemTx, withTenantTx } from '../../lib/db.js';

export interface AuditEntry {
  tenantId?: string | null;
  actorId?: string | null;
  actorType: ActorType;
  channel: Channel;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

const SECRET_KEYS = /(password|secret|token|apiKey|api_key|totp|Enc)$/i;

/** Strip secrets from before/after snapshots. */
export function sanitize(v: unknown): Prisma.InputJsonValue | undefined {
  if (v === undefined || v === null) return undefined;
  return JSON.parse(
    JSON.stringify(v, (k, val) => (k && SECRET_KEYS.test(k) ? '[redacted]' : typeof val === 'bigint' ? val.toString() : val)),
  ) as Prisma.InputJsonValue;
}

/** Append-only audit trail (app role has no UPDATE/DELETE on audit_logs). */
export async function audit(prisma: PrismaClient, e: AuditEntry): Promise<void> {
  const data = {
    tenantId: e.tenantId ?? null,
    actorId: e.actorId ?? null,
    actorType: e.actorType,
    channel: e.channel,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId ?? null,
    before: sanitize(e.before),
    after: sanitize(e.after),
    ip: e.ip ?? null,
  };
  if (e.tenantId) await withTenantTx(prisma, e.tenantId, (tx) => tx.auditLog.create({ data }));
  else await withSystemTx(prisma, (tx) => tx.auditLog.create({ data }));
}
