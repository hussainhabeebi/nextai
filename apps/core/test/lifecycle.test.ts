import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { tenantDb, withSystemTx } from '../src/lib/db.js';
import { scanTimers } from '../src/modules/lifecycle/engine.js';
import { erpTime, handleLifecycleEvent, startMonthlyUpdates } from '../src/modules/lifecycle/events.js';
import { sendStaffDigests } from '../src/modules/lifecycle/digest.js';
import { normalizeLeadPayload } from '../src/routes/webhooks/leadvyne.js';
import { MockLlm } from '../src/ai/mock.js';
import { cwMessage, postCw } from './webhook-helpers.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { closeShared, createTenant, drain, testContainer } from './helpers.js';

const c = testContainer();
let app: FastifyInstance;
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
/** Business-app login for tenant A: the owner manages the pipeline; the accountant can view; staff cannot. */
const h = async (who: 'owner' | 'accountant' | 'staff' = 'owner') => ({
  authorization: `Bearer ${await signAccess(
    who === 'owner'
      ? { sub: A.owner.id, tid: A.tenant.id, role: 'owner', typ: 'app' }
      : { sub: '00000000-0000-4000-8000-0000000000aa', tid: A.tenant.id, role: who === 'accountant' ? 'tenant_accountant' : 'staff', typ: 'app' },
  )}`,
});
const MIN = 60_000;

type Rule = { id: string; key: string; enabled: boolean; levels: Array<{ id: string; level: number; offsetMinutes: number; enabled: boolean }> };
const lifecycle = async () => (await app.inject({ method: 'GET', url: `/v1/lifecycle`, headers: await h() })).json() as { rules: Rule[]; leadWebhook: { configured: boolean } };
const rule = async (key: string) => (await lifecycle()).rules.find((r) => r.key === key)!;
const sentTo = async (ruleRef: string) =>
  (await tenantDb(c.prisma, A.tenant.id).outboundMessage.findMany({ where: { ref: { startsWith: 'lc:' } }, orderBy: { createdAt: 'asc' } })).filter((m) => m.ref!.includes(ruleRef));
const timer = (key: string, docName: string) => withSystemTx(c.prisma, (tx) => tx.lifecycleTimer.findFirst({ where: { tenantId: A.tenant.id, docName, rule: { key } } }));

const SALES = '+919800000001';
const ACCOUNTANT = '+919800000002';
const ESHA = '+919800000003';
const MGMT = '+919800000004';

beforeAll(async () => {
  await seed(c.prisma);
  A = await createTenant(c.prisma, { settings: { timezone: 'Asia/Kolkata' } });
  B = await createTenant(c.prisma);
  app = await buildApp(c);
});
afterAll(async () => {
  await app.close();
  await closeShared();
});

describe('lifecycle admin', () => {
  it('installs the default playbook idempotently, manages staff and edits / switches off / adds / deletes levels', async () => {
    expect((await app.inject({ method: 'POST', url: `/v1/lifecycle/install`, headers: await h('staff') })).statusCode).toBe(403);
    const first = await app.inject({ method: 'POST', url: `/v1/lifecycle/install`, headers: await h() });
    expect(first.json().rulesAdded).toBeGreaterThanOrEqual(19);
    const again = await app.inject({ method: 'POST', url: `/v1/lifecycle/install`, headers: await h() });
    expect(again.json()).toEqual({ rulesAdded: 0, levelsAdded: 0 });

    for (const [name, phone, roles, erpUser] of [
      ['Ali', SALES, ['sales'], 'ali@nextai.test'],
      ['Accountant', ACCOUNTANT, ['accountant'], null],
      ['Esha', ESHA, ['onboarding'], 'esha@nextai.test'],
      ['Boss', MGMT, ['management'], null],
    ] as const) {
      const r = await app.inject({ method: 'POST', url: `/v1/staff`, headers: await h(), payload: { name, phone, roles, erpUser } });
      expect(r.statusCode).toBe(200);
    }
    const bad = await app.inject({ method: 'POST', url: `/v1/staff`, headers: await h(), payload: { name: 'X', phone: 'abc', roles: ['sales'] } });
    expect(bad.statusCode).toBe(400);

    // Switch off level 1 of "call within 1 hour", edit level 2, add and delete a level.
    const fc = await rule('lead.first_call');
    const l1 = fc.levels.find((l) => l.level === 1)!;
    const l2 = fc.levels.find((l) => l.level === 2)!;
    expect((await app.inject({ method: 'PATCH', url: `/v1/lifecycle/levels/${l1.id}`, headers: await h(), payload: { enabled: false } })).statusCode).toBe(200);
    await app.inject({ method: 'PATCH', url: `/v1/lifecycle/levels/${l2.id}`, headers: await h(), payload: { offsetMinutes: 55, message: 'Call {{lead_name}} now!' } });
    const added = await app.inject({ method: 'POST', url: `/v1/lifecycle/rules/${fc.id}/levels`, headers: await h(), payload: { offsetMinutes: 240, audience: 'management', message: 'Lead {{lead_name}} ignored for 4h' } });
    expect(added.json().level).toBe(4);
    const tmp = await app.inject({ method: 'POST', url: `/v1/lifecycle/rules/${fc.id}/levels`, headers: await h(), payload: { offsetMinutes: 300, audience: 'owner', message: 'tmp' } });
    expect((await app.inject({ method: 'DELETE', url: `/v1/lifecycle/levels/${tmp.json().id}`, headers: await h() })).statusCode).toBe(200);

    const after = await rule('lead.first_call');
    expect(after.levels.map((l) => [l.level, l.offsetMinutes, l.enabled])).toEqual([
      [1, 45, false],
      [2, 55, true],
      [3, 90, true],
      [4, 240, true],
    ]);
    const logs = await withSystemTx(c.prisma, (tx) => tx.auditLog.count({ where: { tenantId: A.tenant.id, action: { startsWith: 'lifecycle.' } } }));
    expect(logs).toBeGreaterThanOrEqual(8);
  });
});

describe('lead → reminders → escalation', () => {
  it('Leadvyne lead is created in ERPNext, assigned round-robin, reminded per level and escalated to the accountant', async () => {
    const rot = await app.inject({ method: 'POST', url: `/v1/lifecycle/lead-webhook-secret`, headers: await h() });
    const secret = rot.json().secret as string;
    const body = JSON.stringify({ id: 'lv-1', name: 'Fatima Traders', phone: '9876543210', source: 'meta_ads', campaign: 'Nov promo' });
    const sig = (s: string) => 'sha256=' + createHmac('sha256', s).update(body).digest('hex');
    const url = `/webhooks/leadvyne/${A.tenant.slug}`;
    expect((await app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json', 'x-leadvyne-signature': sig('nope') } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json', 'x-leadvyne-signature': sig(secret) } });
    expect(ok.json().status).toBe('created');
    const leadName = ok.json().lead as string;
    expect((await app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json', 'x-leadvyne-signature': sig(secret) } })).json().status).toBe('duplicate');

    await drain(c);
    const erp = c.erps.get(A.tenant.id)!;
    const lead = await erp.get('Lead', leadName);
    expect(lead).toMatchObject({ mobile_no: '+919876543210', source: 'Advertisement', lead_owner: 'ali@nextai.test' });
    expect(erp.calls.some((x) => x.method === 'assign')).toBe(true);

    const t0 = (await timer('lead.first_call', leadName))!;
    const at = (m: number) => new Date(t0.anchorAt.getTime() + m * MIN);

    await scanTimers(c, at(1));
    expect((await sentTo(':1')).map((m) => m.toPhone)).toContain(SALES); // lead.assign level 1

    await scanTimers(c, at(50)); // first_call level 1 is switched off → nothing
    expect((await timer('lead.first_call', leadName))!.sentLevels).toEqual([]);

    await scanTimers(c, at(56)); // edited level 2 (55 min)
    await scanTimers(c, at(57)); // repeat scan: no double send
    expect((await timer('lead.first_call', leadName))!.sentLevels).toEqual([2]);

    await scanTimers(c, at(91)); // escalation → accountant
    const firstCall = await withSystemTx(c.prisma, (tx) => tx.lifecycleTimer.findUniqueOrThrow({ where: { id: t0.id } }));
    expect(firstCall.sentLevels).toEqual([2, 3]);
    const msgs = await tenantDb(c.prisma, A.tenant.id).outboundMessage.findMany({ where: { ref: { in: [`lc:${t0.id}:2`, `lc:${t0.id}:3`] } } });
    expect(msgs.map((m) => m.toPhone).sort()).toEqual([ACCOUNTANT, SALES].sort());

    // Converting the Lead to an Opportunity closes the timer before the 4h management level.
    await erp.create('Opportunity', { name: 'CRM-OPP-1', opportunity_from: 'Lead', party_name: leadName, status: 'Open' });
    await handleLifecycleEvent(c, { tenantId: A.tenant.id, doctype: 'Opportunity', name: 'CRM-OPP-1', event: 'after_insert' });
    expect((await timer('lead.first_call', leadName))!.status).toBe('done');
    await scanTimers(c, at(241));
    expect((await timer('lead.first_call', leadName))!.sentLevels).toEqual([2, 3]);
  });

  it('demo reminders follow a rescheduled Event and a disabled rule sends nothing', async () => {
    const erp = c.erps.get(A.tenant.id)!;
    await erp.create('Customer', { name: 'Fatima Traders', customer_name: 'Fatima Traders', mobile_no: '+919876543210' });
    await erp.update('Opportunity', 'CRM-OPP-1', { opportunity_from: 'Customer', party_name: 'Fatima Traders', customer_name: 'Fatima Traders', opportunity_owner: 'ali@nextai.test' });
    const inTwoDays = new Date(Date.now() + 2 * 86400_000);
    const local = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium' }).format(d);
    await erp.create('Event', { name: 'EV-1', starts_on: local(inTwoDays), status: 'Open', event_participants: [{ reference_doctype: 'Opportunity', reference_docname: 'CRM-OPP-1' }] });
    await handleLifecycleEvent(c, { tenantId: A.tenant.id, doctype: 'Event', name: 'EV-1', event: 'after_insert' });
    const t1 = (await timer('demo.reminder', 'EV-1'))!;
    expect(Math.abs(t1.anchorAt.getTime() - inTwoDays.getTime())).toBeLessThan(1000);
    expect(t1.customerPhone).toBe('+919876543210');

    // Rescheduled one day later → anchor moves.
    const inThreeDays = new Date(inTwoDays.getTime() + 86400_000);
    await erp.update('Event', 'EV-1', { starts_on: local(inThreeDays) });
    await handleLifecycleEvent(c, { tenantId: A.tenant.id, doctype: 'Event', name: 'EV-1', event: 'on_update' });
    expect(Math.abs((await timer('demo.reminder', 'EV-1'))!.anchorAt.getTime() - inThreeDays.getTime())).toBeLessThan(1000);

    // Rule switched off from admin → the 24h-before reminders are not sent.
    const demo = await rule('demo.reminder');
    await app.inject({ method: 'PATCH', url: `/v1/lifecycle/rules/${demo.id}`, headers: await h(), payload: { enabled: false } });
    await scanTimers(c, new Date(inThreeDays.getTime() - 23 * 60 * MIN));
    expect((await timer('demo.reminder', 'EV-1'))!.sentLevels).toEqual([]);
    await app.inject({ method: 'PATCH', url: `/v1/lifecycle/rules/${demo.id}`, headers: await h(), payload: { enabled: true } });
    await scanTimers(c, new Date(inThreeDays.getTime() - 23 * 60 * MIN));
    expect((await timer('demo.reminder', 'EV-1'))!.sentLevels).toEqual([1, 2]);
  });
});

describe('first payment → onboarding project', () => {
  it('creates the Project from the Onboarding Template once, assigns Esha and starts handover + data collection', async () => {
    const erp = c.erps.get(A.tenant.id)!;
    await erp.create('Sales Invoice', { name: 'SINV-9', customer: 'Fatima Traders', docstatus: 1, due_date: '2026-12-01', outstanding_amount: 0, grand_total: 5000, currency: 'INR' });
    await erp.submit('Sales Invoice', 'SINV-9');
    await erp.create('Payment Entry', { name: 'PE-1', docstatus: 1, payment_type: 'Receive', party_type: 'Customer', party: 'Fatima Traders', references: [{ reference_doctype: 'Sales Invoice', reference_name: 'SINV-9' }] });
    await erp.submit('Payment Entry', 'PE-1');
    const r = await handleLifecycleEvent(c, { tenantId: A.tenant.id, doctype: 'Payment Entry', name: 'PE-1', event: 'on_submit' });
    expect(r.status).toBe('project_created');
    const project = await erp.get('Project', (r as { project: string }).project);
    expect(project).toMatchObject({ customer: 'Fatima Traders', project_template: 'Onboarding Template', custom_stage: 'Kickoff', _assign: JSON.stringify(['esha@nextai.test']) });
    const handover = (await timer('handover.project', String(project.name)))!;
    expect(handover.customerPhone).toBe('+919876543210');
    expect((await timer('kickoff.data', String(project.name)))!.status).toBe('open');

    await erp.create('Payment Entry', { name: 'PE-2', docstatus: 1, payment_type: 'Receive', party_type: 'Customer', party: 'Fatima Traders', references: [] });
    await erp.submit('Payment Entry', 'PE-2');
    expect((await handleLifecycleEvent(c, { tenantId: A.tenant.id, doctype: 'Payment Entry', name: 'PE-2', event: 'on_submit' })).status).toBe('ok');
    expect((await erp.list('Project', { filters: { customer: 'Fatima Traders' } })).length).toBe(1);

    // Moving the project to Live closes data collection and starts go-live + reviews.
    await erp.update('Project', String(project.name), { custom_stage: 'Live' });
    await handleLifecycleEvent(c, { tenantId: A.tenant.id, doctype: 'Project', name: String(project.name), event: 'on_update' });
    expect((await timer('kickoff.data', String(project.name)))!.status).toBe('done');
    expect((await timer('golive', String(project.name)))!.status).toBe('open');
    expect((await timer('review.day30', String(project.name)))!.status).toBe('open');
  });

  it('does nothing for tenants without an installed playbook', async () => {
    c.erp(B.tenant);
    const erp = c.erps.get(B.tenant.id)!;
    await erp.create('Payment Entry', { name: 'PE-B', docstatus: 1, payment_type: 'Receive', party_type: 'Customer', party: 'Someone' });
    await erp.submit('Payment Entry', 'PE-B');
    expect((await handleLifecycleEvent(c, { tenantId: B.tenant.id, doctype: 'Payment Entry', name: 'PE-B', event: 'on_submit' })).status).toBe('not_enabled');
    expect(erp.calls.some((x) => x.method === 'create' && x.args[0] === 'Project')).toBe(false);
  });
});

describe('customer replies on WhatsApp', () => {
  const NOOR = '+919811111111';
  const say = (content: string, attachments?: Array<{ file_type: string; data_url: string }>) =>
    postCw(app, cwMessage({ inboxId: A.tenant.cwInboxId!, phone: NOOR, content, attachments, conversationId: 9090 }));
  let project = '';

  it('kickoff: files go to the Project, the AI ticks the checklist and chases only what is missing', async () => {
    const erp = c.erps.get(A.tenant.id)!;
    await erp.create('Customer', { name: 'Noor Foods', customer_name: 'Noor Foods', mobile_no: NOOR });
    await erp.create('Payment Entry', { name: 'PE-N1', payment_type: 'Receive', party_type: 'Customer', party: 'Noor Foods', references: [] });
    await erp.submit('Payment Entry', 'PE-N1');
    project = ((await handleLifecycleEvent(c, { tenantId: A.tenant.id, doctype: 'Payment Entry', name: 'PE-N1', event: 'on_submit' })) as { project: string }).project;
    const before = (await timer('kickoff.data', project))!;
    await withSystemTx(c.prisma, (tx) => tx.lifecycleTimer.update({ where: { id: before.id }, data: { sentLevels: [1] } }));

    const url = 'https://app.aiingo.com/rails/active_storage/logo.png';
    c.chatwoot(A.tenant);
    c.cws.get(A.tenant.id)!.attachments.set(url, { content: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    const r1 = await say('Here is our product list with prices', [{ file_type: 'image', data_url: url }]);
    expect(r1.json().status).toBe('customer_reply');
    const t1 = (await timer('kickoff.data', project))!;
    expect(t1.status).toBe('open');
    expect(t1.sentLevels).toEqual([]); // chase restarts from the reply
    expect((t1.context as Record<string, string>).data_received!.split('|').sort()).toEqual(['Logo', 'Prices', 'Product list']);
    expect(c.cws.get(A.tenant.id)!.lastText(9090)).toContain('Still needed: FAQs, Business hours');
    expect(erp.files.some((f) => f.filename === 'logo.png' && f.attachTo?.name === project)).toBe(true);
    expect([...erp.docs.get('Comment')!.values()].some((x) => x.reference_name === project)).toBe(true);

    await say('FAQs and our business hours: 9 to 6');
    expect((await timer('kickoff.data', project))!.status).toBe('done');
    expect(c.cws.get(A.tenant.id)!.lastText(9090)).toContain('We now have everything');
  });

  it('monthly update: the reply becomes a Task for the AI manager and closes the step', async () => {
    const erp = c.erps.get(A.tenant.id)!;
    await app.inject({ method: 'POST', url: `/v1/staff`, headers: await h(), payload: { name: 'AI Manager', phone: '+919800000005', roles: ['ai_manager'], erpUser: 'ai@nextai.test' } });
    await app.inject({ method: 'POST', url: `/v1/staff`, headers: await h(), payload: { name: 'Akshay', phone: '+919800000006', roles: ['qa'], erpUser: 'akshay@nextai.test' } });
    await erp.update('Project', project, { custom_stage: 'Live' });
    // 1st of next month, 10:00 IST (the tenant reminder hour).
    const d = new Date();
    const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 4, 30));
    const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: A.tenant.id } }));
    expect(await startMonthlyUpdates(c, tenant, first)).toBeGreaterThanOrEqual(1);
    const month = first.toISOString().slice(0, 7);
    expect((await timer('bot.monthly_update', `${project}@${month}`))!.status).toBe('open');

    c.queue.jobs = [];
    expect((await say('New offer: 20% off biryani this month')).json().status).toBe('customer_reply');
    const m = (await timer('bot.monthly_update', `${project}@${month}`))!;
    expect(m.status).toBe('done');
    const task = await erp.get('Task', (m.context as Record<string, string>).task!);
    expect(task).toMatchObject({ project, _assign: JSON.stringify(['ai@nextai.test']) });
    expect(c.queue.jobs.some((j) => j.name === 'lifecycle.event')).toBe(true);
  });

  it('support: a message with no open step opens an Issue; "still not working" after resolve re-opens it', async () => {
    const erp = c.erps.get(A.tenant.id)!;
    c.queue.jobs = [];
    expect((await say('The bot is not replying to customers')).json().status).toBe('customer_reply');
    const issue = [...erp.docs.get('Issue')!.values()].find((i) => i.customer === 'Noor Foods')!;
    expect(issue.subject).toBe('The bot is not replying to customers');
    await drain(c);
    expect((await timer('support.issue', String(issue.name)))!.status).toBe('open');

    // A follow-up message is added to the open Issue as a comment.
    await say('Also the menu is old');
    expect([...erp.docs.get('Comment')!.values()].some((x) => x.reference_name === issue.name && String(x.content).includes('menu is old'))).toBe(true);

    await erp.update('Issue', String(issue.name), { status: 'Resolved' });
    await handleLifecycleEvent(c, { tenantId: A.tenant.id, doctype: 'Issue', name: String(issue.name), event: 'on_update' });
    await scanTimers(c, new Date(Date.now() + MIN));
    expect((await timer('support.resolved', String(issue.name)))!.status).toBe('done'); // confirmation sent (single level)

    expect((await say('It is still not working')).json().status).toBe('customer_reply');
    expect((await erp.get('Issue', String(issue.name))).status).toBe('Open');
    const reopened = (await timer('support.issue', String(issue.name)))!;
    expect(reopened.status).toBe('open');
    expect(reopened.sentLevels).toEqual([1, 2]);
    expect(await timer('support.resolved', String(issue.name))).toBeNull();
  });

  it('day-7 review computes the health score, writes it to the Project and alerts management below the threshold', async () => {
    const erp = c.erps.get(A.tenant.id)!;
    await handleLifecycleEvent(c, { tenantId: A.tenant.id, doctype: 'Project', name: project, event: 'on_update' });
    const r = await app.inject({ method: 'PATCH', url: `/v1/lifecycle/settings`, headers: await h(), payload: { healthThreshold: 95 } });
    expect(r.json().healthThreshold).toBe(95);
    const t = (await timer('review.day7', project))!;
    await scanTimers(c, new Date(t.anchorAt.getTime() + 7 * 1440 * MIN + MIN));
    const after = (await timer('review.day7', project))!;
    const ctx = after.context as Record<string, string>;
    // A week later: the re-opened Issue (−10), the monthly-update Task is now overdue (−5) and the Issue escalated (−5).
    expect(ctx.health_reasons).toBe('1 open issue(s) (−10), 1 overdue task(s) (−5), 1 escalated step(s) (−5)');
    expect(ctx.health_score).toBe('80');
    expect((await erp.get('Project', project)).custom_health_score).toBe(80);
    const alerts = await tenantDb(c.prisma, A.tenant.id).outboundMessage.findMany({ where: { ref: `lc:${t.id}:health` } });
    expect(alerts.map((a) => a.toPhone)).toEqual([MGMT]);
  });
});

describe('staff digest and report', () => {
  it('sends one morning digest per staff member per day', async () => {
    const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: A.tenant.id } }));
    const nineIst = new Date(Date.UTC(2030, 0, 15, 3, 35)); // 09:05 Asia/Kolkata
    const n = await sendStaffDigests(c, tenant, nineIst);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await sendStaffDigests(c, tenant, nineIst)).toBe(0);
    const digests = await tenantDb(c.prisma, A.tenant.id).outboundMessage.findMany({ where: { ref: { startsWith: 'lc:digest:2030-01-15' } } });
    expect(digests.length).toBe(n);
  });

  it('reports the funnel, lead sources, stages and owners', async () => {
    const r = (await app.inject({ method: 'GET', url: `/v1/lifecycle/report?days=30`, headers: await h('accountant') })).json();
    expect(r.funnel[0]).toMatchObject({ key: 'lead.assign', count: 1 });
    expect(r.funnel.find((f: { key: string }) => f.key === 'handover.project').count).toBe(2);
    expect(r.sources).toEqual({ Advertisement: 1 });
    expect(r.stages.find((s: { key: string }) => s.key === 'lead.first_call')).toMatchObject({ started: 1, done: 1, escalated: 1 });
    expect(r.owners.some((o: { name: string }) => o.name === 'Ali')).toBe(true);
  });
});

describe('leadvyne payload variants', () => {
  it('accepts nested / aliased fields and the ?token= form', async () => {
    expect(normalizeLeadPayload({ lead: { full_name: 'Sara', mobile: '0501234567', lead_source: 'whatsapp', leadgen_id: 77 } })).toMatchObject({ id: '77', name: 'Sara', phone: '0501234567', source: 'whatsapp' });
    const rot = await app.inject({ method: 'POST', url: `/v1/lifecycle/lead-webhook-secret`, headers: await h() });
    const r = await app.inject({
      method: 'POST',
      url: `/webhooks/leadvyne/${A.tenant.slug}?token=${encodeURIComponent(rot.json().secret)}`,
      payload: { data: { first_name: 'Ravi', last_name: 'K', phone_number: '9123456789', platform: 'website', lead_id: 'x-2' } },
    });
    expect(r.json().status).toBe('created');
    expect(await c.erps.get(A.tenant.id)!.get('Lead', r.json().lead)).toMatchObject({ lead_name: 'Ravi K', source: 'Website' });
  });

  it('mock checklist matcher', async () => {
    const r = await new MockLlm().checkItems({ text: 'sending FAQ now', fileNames: ['menu-prices.pdf'], items: ['Product list', 'Prices', 'FAQs'] });
    expect(r.covered).toEqual(['Prices', 'FAQs']);
  });
});

describe('erpTime', () => {
  it('converts ERPNext local times in the site timezone to UTC', () => {
    expect(erpTime('2026-12-01 10:30:00', 'Asia/Kolkata')!.toISOString()).toBe('2026-12-01T05:00:00.000Z');
    expect(erpTime('2026-12-01', 'Asia/Dubai', 10)!.toISOString()).toBe('2026-12-01T06:00:00.000Z');
    expect(erpTime(null, 'Asia/Kolkata')).toBeNull();
  });
});
