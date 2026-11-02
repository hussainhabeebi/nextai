import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { tenantDb, withSystemTx } from '../src/lib/db.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { closeShared, createTenant, drain, extractionBytes, testContainer } from './helpers.js';

const c = testContainer();
let app: FastifyInstance;
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
let tokA: string;
let tokB: string;
let staffA: string;

beforeAll(async () => {
  await seed(c.prisma);
  A = await createTenant(c.prisma, { settings: { companyAbbr: 'AIL' } });
  B = await createTenant(c.prisma);
  app = await buildApp(c);
  tokA = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'owner', typ: 'app' });
  tokB = await signAccess({ sub: B.owner.id, tid: B.tenant.id, role: 'owner', typ: 'app' });
  staffA = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'staff', typ: 'app' });
});
afterAll(async () => {
  await app.close();
  await closeShared();
});
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

function multipart(filename: string, mime: string, content: Uint8Array) {
  const boundary = '----nx' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('customer app API', () => {
  it('capture → OCR draft visible in approvals → confirm → posted', async () => {
    const mp = multipart('bill.jpg', 'image/jpeg', extractionBytes({ invoiceNo: 'APP-1' }));
    const cap = await app.inject({ method: 'POST', url: '/v1/capture', payload: mp.body, headers: { ...mp.headers, ...auth(tokA) } });
    expect(cap.statusCode).toBe(202);
    await drain(c);
    const list = await app.inject({ method: 'GET', url: '/v1/drafts', headers: auth(tokA) });
    const draft = list.json().items[0];
    expect(draft.status).toBe('pending');
    const detail = await app.inject({ method: 'GET', url: `/v1/drafts/${draft.id}`, headers: auth(tokA) });
    expect(detail.json().documentUrl).toMatch(new RegExp(`tenants/${A.tenant.id}/`));
    const patch = await app.inject({ method: 'PATCH', url: `/v1/drafts/${draft.id}`, headers: auth(tokA), payload: { expenseAccount: 'Office Maintenance Expenses - AIL' } });
    expect(patch.statusCode).toBe(200);
    const conf = await app.inject({ method: 'POST', url: `/v1/drafts/${draft.id}/confirm`, headers: auth(tokA) });
    expect(conf.json().status).toBe('confirmed');
    await drain(c);
    expect((await tenantDb(c.prisma, A.tenant.id).draft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('posted');
  });

  it('tenant B cannot read, edit or confirm tenant A drafts by id', async () => {
    const d = await tenantDb(c.prisma, A.tenant.id).draft.create({ data: { tenantId: A.tenant.id, type: 'journal_entry', payload: { date: '2026-11-01', currency: 'INR', total: 10, lines: [], validationIssues: [] } } });
    expect((await app.inject({ method: 'GET', url: `/v1/drafts/${d.id}`, headers: auth(tokB) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/v1/drafts/${d.id}`, headers: auth(tokB), payload: { total: 99 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/drafts/${d.id}/confirm`, headers: auth(tokB) })).statusCode).toBe(404);
    const listB = await app.inject({ method: 'GET', url: '/v1/drafts', headers: auth(tokB) });
    expect(listB.json().items.map((x: { id: string }) => x.id)).not.toContain(d.id);
  });

  it('dashboard returns figures; settings require owner and are audited', async () => {
    const dash = await app.inject({ method: 'GET', url: '/v1/dashboard', headers: auth(tokA) });
    expect(dash.json()).toMatchObject({ currency: 'INR', cash: 25000, bank: 480000 });
    const denied = await app.inject({ method: 'PATCH', url: '/v1/settings', headers: auth(staffA), payload: { settings: { autoPost: true } } });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({ method: 'PATCH', url: '/v1/settings', headers: auth(tokA), payload: { settings: { autoPost: true } } });
    expect(ok.json().settings.autoPost).toBe(true);
    const logs = await withSystemTx(c.prisma, (tx) => tx.auditLog.findMany({ where: { tenantId: A.tenant.id, action: 'settings.update' } }));
    expect(logs).toHaveLength(1);
  });

  it('creates and posts an invoice from the app, enforces plan user limits', async () => {
    const inv = await app.inject({ method: 'POST', url: '/v1/invoices', headers: auth(tokA), payload: { customer: 'Acme', customerPhone: '9847000000', lines: [{ description: 'Design', qty: 2, rate: 1500 }] } });
    expect(inv.statusCode).toBe(201);
    expect(inv.json().status).toBe('confirmed');
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({ method: 'POST', url: '/v1/team', headers: auth(tokA), payload: { name: `S${i}`, phone: `98470000${10 + i}`, role: 'staff' } });
      expect(r.statusCode).toBe(201);
    }
    const over = await app.inject({ method: 'POST', url: '/v1/team', headers: auth(tokA), payload: { name: 'S9', phone: '9847000099', role: 'staff' } });
    expect(over.statusCode).toBe(402); // business plan: 5 users
  });

  it('suspended tenants are read-only', async () => {
    await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: B.tenant.id }, data: { status: 'suspended' } }));
    expect((await app.inject({ method: 'GET', url: '/v1/drafts', headers: auth(tokB) })).statusCode).toBe(200);
    const w = await app.inject({ method: 'POST', url: '/v1/payments', headers: auth(tokB), payload: { direction: 'in', party: 'X', amount: 5 } });
    expect(w.statusCode).toBe(402);
  });
});
