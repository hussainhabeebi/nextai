import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scopeArgs, tenantDb, TenantScopeError, withTenantTx } from '../src/lib/db.js';
import { seed } from '../prisma/seed.js';
import { closeShared, createTenant, testContainer } from './helpers.js';

const c = testContainer();
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
let draftB: string;

beforeAll(async () => {
  await seed(c.prisma);
  A = await createTenant(c.prisma);
  B = await createTenant(c.prisma);
  const dbB = tenantDb(c.prisma, B.tenant.id);
  draftB = (
    await dbB.draft.create({
      data: { tenantId: B.tenant.id, type: 'journal_entry', payload: { total: 5 }, status: 'pending' },
    })
  ).id;
});
afterAll(closeShared);

describe('scopeArgs (unit)', () => {
  const T = '11111111-1111-1111-1111-111111111111';
  it('injects tenantId into where and data, overriding caller values', () => {
    expect(scopeArgs('Draft', 'findMany', { where: { tenantId: 'evil' } }, T)).toEqual({ where: { tenantId: T } });
    expect(scopeArgs('Draft', 'create', { data: { tenantId: 'evil', x: 1 } }, T)).toEqual({ data: { tenantId: T, x: 1 } });
    expect(scopeArgs('Plan', 'findMany', { where: {} }, T)).toEqual({ where: {} });
  });
  it('refuses to move rows between tenants', () => {
    expect(() => scopeArgs('Draft', 'update', { where: { id: 'x' }, data: { tenantId: 'other' } }, T)).toThrow(TenantScopeError);
  });
});

describe('tenant isolation (Prisma extension + RLS)', () => {
  it('tenant A cannot read tenant B rows', async () => {
    const dbA = tenantDb(c.prisma, A.tenant.id);
    expect(await dbA.draft.findUnique({ where: { id: draftB } })).toBeNull();
    expect(await dbA.draft.findMany()).toHaveLength(0);
    expect(await dbA.draft.count()).toBe(0);
    expect(await dbA.user.findMany()).toHaveLength(1);
  });

  it('tenant A cannot update or delete tenant B rows', async () => {
    const dbA = tenantDb(c.prisma, A.tenant.id);
    const res = await dbA.draft.updateMany({ where: { id: draftB }, data: { status: 'cancelled' } });
    expect(res.count).toBe(0);
    await expect(dbA.draft.update({ where: { id: draftB }, data: { status: 'cancelled' } })).rejects.toThrow();
    await expect(dbA.draft.delete({ where: { id: draftB } })).rejects.toThrow();
    const stillB = await tenantDb(c.prisma, B.tenant.id).draft.findUnique({ where: { id: draftB } });
    expect(stillB?.status).toBe('pending');
  });

  it('tenant A cannot write rows into tenant B (tenantId is overridden)', async () => {
    const dbA = tenantDb(c.prisma, A.tenant.id);
    const d = await dbA.draft.create({ data: { tenantId: B.tenant.id, type: 'journal_entry', payload: {} } });
    expect(d.tenantId).toBe(A.tenant.id);
  });

  it('RLS blocks raw SQL without tenant context and with another tenant', async () => {
    // no app.tenant_id → zero rows even with a raw query (app role is not owner, RLS forced)
    const none = await c.prisma.$queryRaw<unknown[]>`SELECT id FROM drafts`;
    expect(none).toHaveLength(0);
    const asA = await withTenantTx(c.prisma, A.tenant.id, (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM drafts`);
    expect(asA.map((r) => r.id)).not.toContain(draftB);
    const asB = await withTenantTx(c.prisma, B.tenant.id, (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM drafts`);
    expect(asB.map((r) => r.id)).toContain(draftB);
  });

  it('RLS WITH CHECK rejects inserting a row for another tenant', async () => {
    await expect(
      withTenantTx(c.prisma, A.tenant.id, (tx) =>
        tx.$executeRaw`INSERT INTO drafts (id, tenant_id, type, payload, status, updated_at) VALUES (gen_random_uuid(), ${B.tenant.id}::uuid, 'journal_entry', '{}', 'pending', now())`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('tenants table is only visible to its own tenant', async () => {
    const rows = await withTenantTx(c.prisma, A.tenant.id, (tx) => tx.tenant.findMany());
    expect(rows.map((t) => t.id)).toEqual([A.tenant.id]);
  });

  it('audit log is append-only for the app role', async () => {
    await expect(c.prisma.$executeRaw`UPDATE audit_logs SET action = 'x'`).rejects.toThrow(/permission denied/);
  });
});
