import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { tenantDb, withSystemTx } from '../src/lib/db.js';
import { installDefaultPlaybook, scanTimers, startTimer } from '../src/modules/lifecycle/engine.js';
import { officeTick } from '../src/modules/office/schedule.js';
import { localNow, parseDate, parseTime } from '../src/modules/office/util.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { closeShared, createTenant, testContainer } from './helpers.js';
import { cwMessage, postCw } from './webhook-helpers.js';

const c = testContainer();
let app: FastifyInstance;
let A: Awaited<ReturnType<typeof createTenant>>;
const STAFF_INBOX = 777000 + Math.floor(Math.random() * 1000);
const ADMIN = '00000000-0000-4000-8000-000000000001';
const hAdmin = async () => ({ authorization: `Bearer ${await signAccess({ sub: ADMIN, prole: 'super_admin', typ: 'admin' })}` });
/** Business-app login for tenant A (the office is managed by the business owner, not the platform admin). */
const h = async (role: 'owner' | 'tenant_accountant' | 'staff' = 'owner') => ({
  authorization: `Bearer ${await signAccess({ sub: role === 'owner' ? A.owner.id : '00000000-0000-4000-8000-0000000000bb', tid: A.tenant.id, role, typ: 'app' })}`,
});

const HABEEB = '+919700000001';
const ESHA = '+919700000002';
const AKSHAY = '+919700000003';
const ALI = '+919700000004';
const conv: Record<string, number> = { [HABEEB]: 501, [ESHA]: 502, [AKSHAY]: 503, [ALI]: 504, '+919799999999': 509 };

const say = async (phone: string, content: string) => {
  const r = await postCw(app, cwMessage({ inboxId: STAFF_INBOX, phone, content, conversationId: conv[phone] }));
  return r.json().status as string;
};
const staffCw = () => c.cws.get(`${A.tenant.id}:staff`)!;
const lastReply = (phone: string) => staffCw().lastText(conv[phone]) ?? '';
const tenant = () => withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: A.tenant.id } }));
const db = () => tenantDb(c.prisma, A.tenant.id);
const sentTo = async (refPrefix: string) => (await db().outboundMessage.findMany({ where: { ref: { startsWith: refPrefix } } })).map((m) => m.toPhone);
const staffId = async (phone: string) => (await db().staffMember.findFirstOrThrow({ where: { phone } })).id;

beforeAll(async () => {
  await seed(c.prisma);
  A = await createTenant(c.prisma, { settings: { timezone: 'Asia/Kolkata' } });
  app = await buildApp(c);
  // The staff number is connected by NextAi support (admin), like the customer inbox.
  const r = await app.inject({ method: 'PUT', url: `/admin/v1/tenants/${A.tenant.id}/staff-inbox`, headers: await hAdmin(), payload: { inboxId: STAFF_INBOX } });
  expect(r.statusCode).toBe(200);
  for (const [name, phone, roles, erpUser] of [
    ['Habeeb', HABEEB, ['management', 'support'], 'habeeb@nextai.test'],
    ['Esha', ESHA, ['onboarding', 'support'], 'esha@nextai.test'],
    ['Akshay', AKSHAY, ['qa'], 'akshay@nextai.test'],
    ['Ali', ALI, ['sales'], 'ali@nextai.test'],
  ] as const) {
    await app.inject({ method: 'POST', url: `/v1/staff`, headers: await h(), payload: { name, phone, roles, erpUser } });
  }
  await installDefaultPlaybook(c.prisma, A.tenant.id);
  c.chatwoot(await tenant(), 'staff');
});
afterAll(async () => {
  await app.close();
  await closeShared();
});

describe('staff number routing', () => {
  it('rejects the customer inbox as staff number and turns away unknown numbers', async () => {
    const bad = await app.inject({ method: 'PUT', url: `/admin/v1/tenants/${A.tenant.id}/staff-inbox`, headers: await hAdmin(), payload: { inboxId: A.tenant.cwInboxId } });
    expect(bad.statusCode).toBe(400);
    expect(await say('+919799999999', 'hi')).toBe('unknown_staff');
    expect(lastReply('+919799999999')).toContain('for the NextAi team');
    expect(await say(ESHA, 'help')).toBe('office_reply');
    expect(lastReply(ESHA)).toContain('commands');
  });
});

describe('check-in, stand-up and blockers', () => {
  it('records attendance, asks for the plan and flags blockers to management', async () => {
    await say(ESHA, 'in at client site');
    expect(lastReply(ESHA)).toMatch(/Checked in .*\n[\s\S]*What's your plan today/);
    const { date } = localNow('Asia/Kolkata');
    const att = await db().attendance.findFirstOrThrow({ where: { staffId: await staffId(ESHA), date } });
    expect(att.checkInAt).not.toBeNull();
    expect(att.note).toBe('at client site');
    expect((await db().staffMember.findFirstOrThrow({ where: { phone: ESHA } })).presence).toBe('in');

    await say(ESHA, 'Finish Noor onboarding\nblocker: waiting for ERPNext login');
    const st = await db().standup.findFirstOrThrow({ where: { staffId: await staffId(ESHA), date } });
    expect(st.blockers).toBe('waiting for ERPNext login');
    expect(await sentTo('office:blocker:')).toEqual([HABEEB]);

    await say(ESHA, 'busy on call with Noor');
    expect((await db().staffMember.findFirstOrThrow({ where: { phone: ESHA } })).presence).toBe('busy');
    await say(ESHA, 'back');
    await say(HABEEB, 'who is in');
    expect(lastReply(HABEEB)).toContain('🟢 Esha');
  });
});

describe('my work on WhatsApp', () => {
  it('lists lifecycle steps + ERPNext tasks and closes them with "done N"', async () => {
    const t = await tenant();
    const ali = await db().staffMember.findFirstOrThrow({ where: { phone: ALI } });
    await startTimer(c, t.id, { ruleKey: 'lead.first_call', doctype: 'Lead', docName: 'CRM-LEAD-9', anchorAt: new Date(), owner: ali, customerName: 'Sara Bakery' });
    const erp = c.erp(t);
    await erp.create('Task', { name: 'TASK-77', subject: 'Prepare demo deck', status: 'Open', _assign: JSON.stringify(['ali@nextai.test']), exp_end_date: '2030-01-01' });

    await say(ALI, 'tasks');
    const list = lastReply(ALI);
    expect(list).toContain('1. 🟡 Lead qualified — call within 1 hour — Sara Bakery');
    expect(list).toContain('2. 📌 Prepare demo deck');

    await say(ALI, 'done 1 called, interested in demo');
    expect(lastReply(ALI)).toContain('✅ Done: Lead qualified');
    const timer = await db().lifecycleTimer.findFirstOrThrow({ where: { docName: 'CRM-LEAD-9' } });
    expect(timer.status).toBe('done');
    expect((timer.context as Record<string, string>).done_note).toBe('called, interested in demo');

    await say(ALI, 'done 2');
    expect((await erp.get('Task', 'TASK-77')).status).toBe('Completed');
    await say(ALI, 'done 9');
    expect(lastReply(ALI)).toContain('could not find');

    await say(ALI, 'status sara');
    expect(lastReply(ALI)).toContain('📋 Sara Bakery');
  });
});

describe('leave, approvals and leave cover', () => {
  it('leave goes to management for approval; while away, reminders go to the backup', async () => {
    const ali = await staffId(ALI);
    const esha = await staffId(ESHA);
    await app.inject({ method: 'PATCH', url: `/v1/office/staff/${ali}`, headers: await h(), payload: { backupStaffId: esha } });

    await say(ALI, 'leave today fever');
    expect(lastReply(ALI)).toMatch(/Leave request #(\d+) sent/);
    const approval = await db().approval.findFirstOrThrow({ where: { kind: 'leave' } });
    expect(approval.details).toContain('Cover: Esha');
    expect(await sentTo(`office:approval:${approval.id}`)).toEqual([HABEEB]);

    await say(ESHA, `approve ${approval.code}`);
    expect(lastReply(ESHA)).toContain("can't decide");
    await say(HABEEB, `approve ${approval.code} get well soon`);
    expect((await db().leaveRequest.findFirstOrThrow({ where: { staffId: ali } })).status).toBe('approved');
    expect(lastReply(HABEEB)).toContain('Ali has been told');
    expect(await sentTo(`office:decision:${approval.id}`)).toEqual([ALI]);

    // Ali's "call within 1 hour" reminder goes to Esha while Ali is on leave.
    const t = await tenant();
    const timer = await startTimer(c, t.id, { ruleKey: 'lead.first_call', doctype: 'Lead', docName: 'CRM-LEAD-10', anchorAt: new Date(), owner: await db().staffMember.findFirstOrThrow({ where: { id: ali } }), customerName: 'Zed Cafe' });
    await scanTimers(c, new Date(timer!.anchorAt.getTime() + 61 * 60000));
    const msgs = await db().outboundMessage.findMany({ where: { ref: `lc:${timer!.id}:2` } });
    expect(msgs.map((m) => m.toPhone)).toEqual([ESHA]);
  });

  it('other approvals: request on WhatsApp, decide in the admin console', async () => {
    await say(ESHA, 'request discount 15% for Noor Foods annual plan');
    const a = await db().approval.findFirstOrThrow({ where: { kind: 'discount' } });
    expect(a.amount).toBe('15%');
    await say(HABEEB, 'approvals');
    expect(lastReply(HABEEB)).toContain(`#${a.code}`);
    const r = await app.inject({ method: 'POST', url: `/v1/office/approvals/${a.code}/decide`, headers: await h(), payload: { decision: 'rejected', note: 'max 10%' } });
    expect(r.json().status).toBe('rejected');
    expect(staffCw().sent.some((m) => m.content.includes('❌ Rejected') && m.content.includes('max 10%'))).toBe(true);
    const again = await app.inject({ method: 'POST', url: `/v1/office/approvals/${a.code}/decide`, headers: await h(), payload: { decision: 'approved' } });
    expect(again.statusCode).toBe(400);
  });
});

describe('announcements', () => {
  it('management announces to a role; staff acknowledge with OK', async () => {
    await say(ESHA, 'announce: free lunch');
    expect(lastReply(ESHA)).toContain('Only management');
    await say(HABEEB, 'announce sales: Target 10 demos this week');
    expect(lastReply(HABEEB)).toContain('Sent to 1 person');
    await say(ALI, 'ok');
    expect(lastReply(ALI)).toContain('Acknowledged');
    const list = (await app.inject({ method: 'GET', url: `/v1/office/announcements`, headers: await h() })).json();
    expect(list.items[0]).toMatchObject({ text: 'Target 10 demos this week', roles: ['sales'], acked: ['Ali'], pending: [] });
  });
});

describe('meetings', () => {
  it('schedules from WhatsApp, reminds, asks the organizer for notes and turns action lines into tasks', async () => {
    await say(HABEEB, 'meet Esha and Akshay tomorrow 3pm for 45m onboarding sync');
    expect(lastReply(HABEEB)).toMatch(/Meeting #\d+ "Onboarding sync"/);
    const m = await db().meeting.findFirstOrThrow({ where: { title: 'Onboarding sync' } });
    expect(m.durationMin).toBe(45);
    expect(m.attendeeIds).toHaveLength(3);
    expect(localNow('Asia/Kolkata', m.startsAt).minutes).toBe(15 * 60);
    const erp = c.erps.get(A.tenant.id)!;
    expect([...erp.docs.get('Event')!.values()].some((e) => String(e.subject).includes('Onboarding sync'))).toBe(true);
    expect((await sentTo(`office:meet:${m.id}`)).sort()).toEqual([AKSHAY, ESHA].sort());

    const t = await tenant();
    await officeTick(c, t, new Date(m.startsAt.getTime() - 10 * 60000));
    expect((await sentTo(`office:remind:${m.id}`)).sort()).toEqual([AKSHAY, ESHA, HABEEB].sort());
    await officeTick(c, t, new Date(m.startsAt.getTime() - 9 * 60000));
    expect(await sentTo(`office:remind:${m.id}`)).toHaveLength(3);

    await officeTick(c, t, new Date(m.startsAt.getTime() + 46 * 60000));
    expect(await sentTo(`office:notesask:${m.id}`)).toEqual([HABEEB]);
    await say(HABEEB, 'Agreed the new menu flow\n- Esha: update the menu by friday\n- Akshay: test checkout');
    expect(lastReply(HABEEB)).toContain('Notes saved');
    const after = await db().meeting.findFirstOrThrow({ where: { id: m.id } });
    expect(after.status).toBe('done');
    expect(after.taskNames).toHaveLength(2);
    const task = await erp.get('Task', after.taskNames[0]!);
    expect(task).toMatchObject({ subject: 'Esha: update the menu by friday', _assign: JSON.stringify(['esha@nextai.test']) });
  });
});

describe('daily and weekly schedule', () => {
  it('late nudge + management list, end-of-day prompt, AI team summary and weekly report — once each', async () => {
    const t = await tenant();
    const day = '2030-01-14'; // a Monday
    const ist = (hh: number, mm: number) => new Date(Date.parse(`${day}T00:00:00Z`) + ((hh * 60 + mm) - 330) * 60000);
    await db().attendance.create({ data: { tenantId: t.id, staffId: await staffId(ESHA), date: day, checkInAt: ist(8, 55) } });
    await db().standup.create({ data: { tenantId: t.id, staffId: await staffId(ESHA), date: day, plan: 'Noor onboarding', done: 'Menu uploaded' } });

    const r1 = await officeTick(c, t, ist(9, 20));
    expect(r1.done).toEqual(expect.arrayContaining(['reset', 'late', 'weekly']));
    expect((await sentTo(`office:nudge:${day}`)).sort()).toEqual([AKSHAY, ALI, HABEEB].sort());
    expect(await sentTo(`office:late:${day}`)).toEqual([]); // the only manager is himself not checked in
    expect(await sentTo(`office:weekly:${day}`)).toEqual([HABEEB]);
    expect((await officeTick(c, t, ist(9, 25))).done).toEqual([]);

    await officeTick(c, t, ist(18, 5));
    expect(await sentTo(`office:eod:${day}`)).toEqual([ESHA]);
    await officeTick(c, t, ist(19, 5));
    expect(await sentTo(`office:summary:${day}`)).toEqual([HABEEB]);
    expect(staffCw().sent.some((m) => m.content.startsWith(`📊 Team day — ${day} (1/4 in)`))).toBe(true);
    await officeTick(c, t, ist(19, 10));
    expect(await sentTo(`office:summary:${day}`)).toHaveLength(1);
  });

  it('check-out asks what got done and passes a handover on', async () => {
    await say(ESHA, 'out');
    expect(lastReply(ESHA)).toContain('Checked out');
    await say(ESHA, 'Uploaded Noor menu.\nhandover Akshay: test Noor checkout tomorrow');
    expect(await sentTo('office:handover:')).toEqual([AKSHAY]);
    expect((await db().staffMember.findFirstOrThrow({ where: { phone: ESHA } })).presence).toBe('out');
  });
});

describe('office dashboard API', () => {
  it('is the business owner\'s: the accountant can view, staff cannot, another business sees only its own data', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/office/floor', headers: await h('tenant_accountant') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/v1/office/settings', headers: await h('tenant_accountant'), payload: { settings: { workStart: '10:00' } } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/office/floor', headers: await h('staff') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/lifecycle', headers: await h('staff') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/office/floor' })).statusCode).toBe(401);
    // The office endpoints no longer exist in the admin console.
    expect((await app.inject({ method: 'GET', url: `/admin/v1/tenants/${A.tenant.id}/office/floor`, headers: await hAdmin() })).statusCode).toBe(404);

    const B = await createTenant(c.prisma);
    const hB = { authorization: `Bearer ${await signAccess({ sub: B.owner.id, tid: B.tenant.id, role: 'owner', typ: 'app' })}` };
    const floorB = (await app.inject({ method: 'GET', url: '/v1/office/floor', headers: hB })).json();
    expect(floorB.stats.total).toBe(0);
    expect(floorB.cards).toEqual([]);
    const settingsB = (await app.inject({ method: 'GET', url: '/v1/office/settings', headers: hB })).json();
    expect(settingsB.staffNumberConnected).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/v1/office/settings', headers: await h() })).json().staffNumberConnected).toBe(true);
  });

  it('floor, performance, attendance and stand-ups', async () => {
    const floor = (await app.inject({ method: 'GET', url: `/v1/office/floor`, headers: await h() })).json();
    expect(floor.stats.total).toBe(4);
    expect(floor.stats.onLeave).toBe(1);
    expect(floor.cards.find((x: { name: string }) => x.name === 'Ali').presence).toBe('leave');
    const perf = (await app.inject({ method: 'GET', url: `/v1/office/performance?days=7`, headers: await h() })).json();
    expect(perf.items.find((x: { name: string }) => x.name === 'Ali')).toMatchObject({ stepsDone: 1, onTime: 1 });
    const att = (await app.inject({ method: 'GET', url: `/v1/office/attendance`, headers: await h() })).json();
    expect(att.rows.some((r: { staffName: string }) => r.staffName === 'Esha')).toBe(true);
    expect(att.leaves[0]).toMatchObject({ staffName: 'Ali', status: 'approved' });
    const su = (await app.inject({ method: 'GET', url: `/v1/office/standups`, headers: await h() })).json();
    expect(su.items.find((x: { name: string }) => x.name === 'Esha').blockers).toBe('waiting for ERPNext login');
  });

  it('free text is answered by the AI from the person\'s own work', async () => {
    await say(AKSHAY, 'what should I focus on?');
    expect(lastReply(AKSHAY)).toContain('Staff: Akshay (qa)');
  });
});

describe('date and time parsing', () => {
  it('understands common phrasings', () => {
    const today = '2026-11-23'; // Monday
    expect(parseDate('leave tomorrow', today)!.date).toBe('2026-11-24');
    expect(parseDate('on friday', today)!.date).toBe('2026-11-27');
    expect(parseDate('25/12 to 27/12', today)!.date).toBe('2026-12-25');
    expect(parseDate('5 jan', today)!.date).toBe('2027-01-05');
    expect(parseDate('2027-02-01', today)!.date).toBe('2027-02-01');
    expect(parseTime('3pm')!.minutes).toBe(900);
    expect(parseTime('at 11:30')!.minutes).toBe(690);
    expect(parseTime('9.15 am')!.minutes).toBe(555);
    expect(parseTime('at 3')!.minutes).toBe(900);
  });
});
