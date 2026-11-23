import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { tenantDb, withSystemTx } from '../src/lib/db.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { closeShared, createTenant, testContainer } from './helpers.js';
import { cwMessage, postCw } from './webhook-helpers.js';

const c = testContainer();
let app: FastifyInstance;
const post = (url: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload, headers });
const rnd = () => Math.floor(1000000 + Math.random() * 8999999);

beforeAll(async () => {
  await seed(c.prisma);
  app = await buildApp(c);
});
afterAll(async () => {
  await app.close();
  await closeShared();
});

describe('staff added by the owner', () => {
  it('UAE staff: added in local format, gets an OTP on WhatsApp for "050 …", logs in and becomes active', async () => {
    const A = await createTenant(c.prisma, { country: 'AE', currency: 'AED', settings: { whatsappNumber: '+971 4 555 0100' } });
    const owner = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'owner', typ: 'app' });
    const local = `050 ${rnd()}`.slice(0, 12); // "050 1234567"
    const added = await post('/v1/team', { name: 'Rasheed', phone: local, role: 'staff' }, { authorization: `Bearer ${owner}` });
    expect(added.statusCode).toBe(201);
    const m = added.json();
    const e164 = `+9715${local.replace(/\D/g, '').slice(2)}`;
    expect(m).toMatchObject({ phone: e164, status: 'invited' });
    expect(m.invite.text).toMatch(/Rasheed! .* has added you to NextAi[\s\S]*on WhatsApp to \+971 4 555 0100[\s\S]*\/login and enter \+9715/);
    expect(m.invite.whatsappLink).toMatch(new RegExp(`^https://wa\\.me/${e164.slice(1)}\\?text=`));

    const otp = await post('/v1/auth/otp/request', { phone: local.replace(/\s/g, '') });
    expect(otp.json()).toMatchObject({ sent: true, channel: 'whatsapp' });
    const sent = c.cws.get(A.tenant.id)!.sent.at(-1)!;
    expect(sent.content).toContain(otp.json().devCode);
    const login = await post('/v1/auth/otp/verify', { phone: local, code: otp.json().devCode });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ tenantId: A.tenant.id, userId: m.id });
    expect((await tenantDb(c.prisma, A.tenant.id).user.findUnique({ where: { id: m.id } }))!.status).toBe('active');
  });

  it('staff can use the bot straight away: first message gets a welcome and is handled', async () => {
    const A = await createTenant(c.prisma);
    const owner = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'owner', typ: 'app' });
    const phone = `98${rnd()}1`.slice(0, 10);
    const m = (await post('/v1/team', { name: 'Anil Kumar', phone, role: 'staff' }, { authorization: `Bearer ${owner}` })).json();
    c.chatwoot(A.tenant);
    await postCw(app, cwMessage({ inboxId: A.tenant.cwInboxId!, phone: `+91${phone}`, content: 'paid 500 for tea', conversationId: 9901 }));
    const msgs = c.cws.get(A.tenant.id)!.sent.filter((x) => x.conversationId === 9901).map((x) => x.content);
    expect(msgs[0]).toMatch(/Hi Anil![\s\S]*set up for .* as staff/);
    expect(msgs.at(-1)).toMatch(/Expense[\s\S]*500[\s\S]*1\. Confirm/);
    expect((await tenantDb(c.prisma, A.tenant.id).user.findUnique({ where: { id: m.id } }))!.status).toBe('active');
  });

  it('before WhatsApp is connected: code by the staff member\'s email, or a clear reason instead of a silent "sent"', async () => {
    const A = await createTenant(c.prisma);
    await withSystemTx(c.prisma, (tx) => tx.tenant.update({ where: { id: A.tenant.id }, data: { cwBotTokenEnc: null } }));
    const owner = await signAccess({ sub: A.owner.id, tid: A.tenant.id, role: 'owner', typ: 'app' });
    const auth = { authorization: `Bearer ${owner}` };
    const p1 = `97${rnd()}2`.slice(0, 10);
    const noEmail = (await post('/v1/team', { name: 'No Email', phone: p1, role: 'staff' }, auth)).json();
    const r1 = (await post('/v1/auth/otp/request', { phone: p1 })).json();
    expect(r1).toMatchObject({ sent: false, channel: 'none', message: expect.stringMatching(/add your email in Settings → Team/) });
    expect(noEmail.invite.text).toMatch(/your login code comes once our WhatsApp is connected/);

    const p2 = `96${rnd()}3`.slice(0, 10);
    const withEmail = (await post('/v1/team', { name: 'Priya', phone: p2, email: 'priya@example.com', role: 'tenant_accountant' }, auth)).json();
    expect(withEmail.invite.text).toMatch(/as our accountant[\s\S]*by email \(priya@example.com\)/);
    const r2 = (await post('/v1/auth/otp/request', { phone: p2 })).json();
    expect(r2).toMatchObject({ sent: true, channel: 'email' });
    expect(c.mailer.sent.at(-1)!).toMatchObject({ to: ['priya@example.com'], subject: `${r2.devCode} is your NextAi login code` });

    // the owner adds an email later; a removed member can be added back
    await app.inject({ method: 'PATCH', url: `/v1/team/${noEmail.id}`, payload: { email: 'late@example.com' }, headers: auth });
    expect((await app.inject({ method: 'GET', url: `/v1/team/${noEmail.id}/invite`, headers: auth })).json().text).toMatch(/by email \(late@example.com\)/);
    await app.inject({ method: 'DELETE', url: `/v1/team/${noEmail.id}`, headers: auth });
    const back = await post('/v1/team', { name: 'No Email', phone: p1, role: 'staff' }, auth);
    expect(back.statusCode).toBe(201);
    expect(back.json()).toMatchObject({ id: noEmail.id, status: 'invited' });
  });
});

describe('staff given at signup', () => {
  it('are added as invited members (within the plan limit), can get a code and log in', async () => {
    const ownerPhone = `+9198${rnd()}`.slice(0, 13);
    const staffLocal = `95${rnd()}4`.slice(0, 10);
    const start = await post('/v1/signup', {
      businessName: 'Kochi Bakers',
      ownerName: 'Anu',
      email: `anu.${rnd()}@example.com`,
      phone: ownerPhone,
      country: 'IN',
      plan: 'growth', // 4 users: owner + 3
      team: [
        { name: 'Anil', phone: staffLocal, email: 'anil@example.com' },
        { name: 'Owner Again', phone: ownerPhone },
        { name: 'CA Priya', phone: `+9194${rnd()}`.slice(0, 13), role: 'tenant_accountant' },
        { name: 'Third', phone: `+9193${rnd()}`.slice(0, 13) },
        { name: 'Over Limit', phone: `+9192${rnd()}`.slice(0, 13) },
      ],
    });
    expect(start.statusCode).toBe(200);
    const ok = await post('/v1/signup/verify', { signupId: start.json().signupId, code: start.json().devCode });
    expect(ok.statusCode).toBe(200);
    const users = await withSystemTx(c.prisma, (tx) => tx.user.findMany({ where: { tenantId: ok.json().tenantId }, orderBy: { createdAt: 'asc' } }));
    // Created in the same instant (equal createdAt), so compare as a set rather than by insertion order.
    expect(users.map((u) => [u.name, u.role, u.status]).sort()).toEqual([
      ['Anu', 'owner', 'invited'], // active once they open the signup link
      ['Anil', 'staff', 'invited'],
      ['CA Priya', 'tenant_accountant', 'invited'],
      ['Third', 'staff', 'invited'],
    ].sort());
    expect(users.find((u) => u.name === 'Anil')!.phone).toBe(`+91${staffLocal}`);

    const otp = (await post('/v1/auth/otp/request', { phone: staffLocal })).json();
    expect(otp).toMatchObject({ sent: true, channel: 'email' });
    const login = await post('/v1/auth/otp/verify', { phone: staffLocal, code: otp.devCode });
    expect(login.json()).toMatchObject({ tenantId: ok.json().tenantId, userId: users[1]!.id });
  });
});
