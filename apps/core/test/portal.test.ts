import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { tenantDb, withSystemTx } from '../src/lib/db.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { closeShared, createTenant, testContainer } from './helpers.js';

const c = testContainer();
let app: FastifyInstance;
const CA = '+919800012345';

const draft = (tenantId: string, status: string, party: string, total: number) =>
  tenantDb(c.prisma, tenantId).draft.create({
    data: { tenantId, type: 'purchase_invoice', status: status as never, error: status === 'failed' ? 'Your books rejected this: missing tax template' : null, payload: { partyName: party, date: '2026-11-10', currency: 'INR', lines: [], total, validationIssues: [] } },
  });
const member = (tenantId: string, role: 'tenant_accountant' | 'owner', status: 'active' | 'disabled' = 'active') =>
  withSystemTx(c.prisma, (tx) => tx.user.create({ data: { tenantId, phone: CA, name: 'CA Anil', role, status } }));

describe('accountant portal', () => {
  let tok: string;
  let A: Awaited<ReturnType<typeof createTenant>>;
  let B: Awaited<ReturnType<typeof createTenant>>;
  let Other: Awaited<ReturnType<typeof createTenant>>;
  let Gone: Awaited<ReturnType<typeof createTenant>>;

  beforeAll(async () => {
    await seed(c.prisma);
    A = await createTenant(c.prisma, { name: 'Kochi Bakers' });
    B = await createTenant(c.prisma, { name: 'Gulf Mart', country: 'AE', currency: 'AED', settings: { taxRegime: 'vat', timezone: 'Asia/Dubai' } });
    Other = await createTenant(c.prisma, { name: 'Not My Client' });
    Gone = await createTenant(c.prisma, { name: 'Former Client' });
    const caA = await member(A.tenant.id, 'tenant_accountant');
    await member(B.tenant.id, 'tenant_accountant');
    await member(Gone.tenant.id, 'tenant_accountant', 'disabled');
    await draft(A.tenant.id, 'needs_review', 'Kerala Paper Mart', 2950);
    await draft(A.tenant.id, 'failed', 'AM Motors', 8000);
    await draft(Other.tenant.id, 'needs_review', 'Secret Supplier', 999);
    await draft(Gone.tenant.id, 'needs_review', 'Old Supplier', 111);
    await tenantDb(c.prisma, B.tenant.id).bankLine.create({ data: { tenantId: B.tenant.id, date: '2026-11-15', amount: 430, direction: 'out', description: 'DEWA', source: 'statement', fingerprint: 'p1' } });
    app = await buildApp(c);
    tok = await signAccess({ sub: caA.id, tid: A.tenant.id, role: 'tenant_accountant', typ: 'app' });
  });
  afterAll(async () => {
    await app.close();
    await closeShared();
  });

  it('lists every business the accountant works on, busiest first, and nothing else', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/portal', headers: { authorization: `Bearer ${tok}` } });
    expect(res.statusCode).toBe(200);
    const { businesses, queue } = res.json();
    expect(businesses.map((b: { name: string }) => b.name)).toEqual(['Kochi Bakers', 'Gulf Mart']);
    expect(businesses[0]).toMatchObject({ role: 'tenant_accountant', needsReview: 1, failed: 1, pending: 0, bankToCheck: 0, current: true });
    expect(businesses[0].nextDeadline).toMatchObject({ what: expect.stringMatching(/GSTR/) });
    expect(businesses[1]).toMatchObject({ country: 'AE', needsReview: 0, bankToCheck: 1, current: false });
    expect(businesses[1].nextDeadline?.what ?? 'VAT').toMatch(/VAT/);

    // one queue: failed first; other businesses' drafts never appear
    expect(queue.map((q: { business: string; status: string; party: string }) => [q.business, q.status, q.party])).toEqual([
      ['Kochi Bakers', 'failed', 'AM Motors'],
      ['Kochi Bakers', 'needs_review', 'Kerala Paper Mart'],
    ]);
    expect(queue[0]).toMatchObject({ total: '₹8,000.00', error: expect.stringMatching(/tax template/) });
    expect(JSON.stringify(res.json())).not.toMatch(/Secret Supplier|Not My Client|Former Client|Old Supplier/);
  });
});
