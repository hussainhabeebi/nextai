import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { withSystemTx } from '../src/lib/db.js';
import { decrypt } from '../src/lib/crypto.js';
import { signAccess } from '../src/modules/auth/tokens.js';
import { connectInbox } from '../src/modules/chatwoot/admin-api.js';
import { ResendMailer } from '../src/modules/email/mailer.js';
import { sendAdminDailyReport } from '../src/modules/email/reports.js';
import { sendDailySummary } from '../src/modules/outbound/jobs.js';
import { closeShared, createTenant, testContainer } from './helpers.js';

const c = testContainer();
let app: FastifyInstance;
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
const ADMIN = '00000000-0000-4000-8000-000000000001';
const h = async (prole: 'super_admin' | 'reviewer' | 'support') => ({
  authorization: `Bearer ${await signAccess({ sub: ADMIN, prole, typ: 'admin' })}`,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  await seed(c.prisma);
  A = await createTenant(c.prisma, { settings: { companyAbbr: 'AIL', timezone: 'Asia/Kolkata' } });
  B = await createTenant(c.prisma, { settings: { companyAbbr: 'BIL' } });
  await withSystemTx(c.prisma, (tx) =>
    tx.user.update({ where: { id: A.owner.id }, data: { email: 'Owner@Example.com' } }),
  );
  app = await buildApp(c);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await app.close();
  await closeShared();
});

describe('ResendMailer', () => {
  it('posts to the Resend API with bearer auth, base64 attachments and sanitized tags', async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(200, { id: 're_123' }));
    const m = new ResendMailer('re_key', 'NextAi <r@nextaierp.com>', f as unknown as typeof fetch);
    const r = await m.send({
      to: ['A@x.com', 'a@x.com'],
      subject: 'S',
      html: '<p>h</p>',
      text: 't',
      attachments: [{ filename: 'a.pdf', content: new Uint8Array([1, 2]) }],
      tags: { tenant: 'acme.co' },
    });
    expect(r.id).toBe('re_123');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer re_key');
    const body = JSON.parse(init!.body as string);
    expect(body.to).toEqual(['a@x.com']);
    expect(body.attachments[0].content).toBe(Buffer.from([1, 2]).toString('base64'));
    expect(body.tags).toEqual([{ name: 'tenant', value: 'acme_co' }]);
  });

  it('surfaces Resend errors', async () => {
    const m = new ResendMailer('bad', 'x@y.z', (async () =>
      json(403, { message: 'domain not verified' })) as unknown as typeof fetch);
    await expect(m.send({ to: ['a@x.com'], subject: 's', html: '', text: '' })).rejects.toThrow(
      /403: domain not verified/,
    );
  });
});

describe('email reports', () => {
  it('daily summary emails the owner once per day alongside WhatsApp', async () => {
    c.mailer.sent.length = 0;
    await sendDailySummary(c, A.tenant);
    await sendDailySummary(c, A.tenant);
    expect(c.mailer.sent).toHaveLength(1);
    expect(c.mailer.sent[0]!.to).toEqual(['owner@example.com']);
    expect(c.mailer.sent[0]!.html).toMatch(/5,05,000/);
    expect(
      c.cws.get(A.tenant.id)!.sent.filter((m) => m.template?.name === 'nextai_daily_summary').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('skips email when the tenant has no recipients', async () => {
    c.mailer.sent.length = 0;
    await sendDailySummary(c, B.tenant);
    expect(c.mailer.sent).toHaveLength(0);
  });

  it('admin daily report is skipped without ADMIN_REPORT_EMAILS', async () => {
    expect(await sendAdminDailyReport(c)).toEqual({ skipped: 'not_configured' });
  });
});

describe('admin integrations API', () => {
  it('lists integration status without secrets, for any admin', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/v1/integrations', headers: await h('support') });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.chatwoot.webhookUrl).not.toContain(process.env.CHATWOOT_WEBHOOK_SECRET);
    expect(JSON.stringify(body)).not.toContain('cwBotTokenEnc');
    expect(body.tenants.find((t: { id: string }) => t.id === A.tenant.id).chatwoot.connected).toBe(true);
  });

  it('updates email recipients and sends a summary now', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/admin/v1/tenants/${B.tenant.id}/email-reports`,
      headers: await h('support'),
      payload: { enabled: true, recipients: ['CA@firm.com'] },
    });
    expect(put.statusCode).toBe(200);
    c.mailer.sent.length = 0;
    const now = await app.inject({
      method: 'POST',
      url: `/admin/v1/tenants/${B.tenant.id}/email-summary`,
      headers: await h('support'),
    });
    expect(now.statusCode).toBe(200);
    expect(c.mailer.sent[0]!.to).toEqual(['ca@firm.com']);
    const bad = await app.inject({
      method: 'PUT',
      url: `/admin/v1/tenants/${B.tenant.id}/email-reports`,
      headers: await h('support'),
      payload: { enabled: true, recipients: ['nope'] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('sends a test email (super_admin only)', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/v1/integrations/email/test',
          headers: await h('support'),
          payload: { to: 'a@b.co' },
        })
      ).statusCode,
    ).toBe(403);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/v1/integrations/email/test',
      headers: await h('super_admin'),
      payload: { to: 'a@b.co' },
    });
    expect(r.statusCode).toBe(200);
  });

  it('manual connect verifies the bot token, stores it encrypted, and rejects inboxes owned by another tenant', async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json(200, { data: { meta: { all_count: 3 } } }),
    );
    vi.stubGlobal('fetch', f);
    const r = await app.inject({
      method: 'POST',
      url: `/admin/v1/tenants/${B.tenant.id}/chatwoot/connect`,
      headers: await h('super_admin'),
      payload: { mode: 'manual', accountId: 7, inboxId: 876543, botToken: 'bot-token-xyz' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().openConversations).toBe(3);
    expect(String(f.mock.calls[0]![0])).toContain('/api/v1/accounts/7/conversations?inbox_id=876543');
    const t = await withSystemTx(c.prisma, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: B.tenant.id } }),
    );
    expect(t.cwInboxId).toBe(876543);
    expect(decrypt(t.cwBotTokenEnc!, `cw_bot:${t.id}`)).toBe('bot-token-xyz');
    const clash = await app.inject({
      method: 'POST',
      url: `/admin/v1/tenants/${A.tenant.id}/chatwoot/connect`,
      headers: await h('super_admin'),
      payload: { mode: 'manual', accountId: 7, inboxId: 876543, botToken: 'bot-token-xyz' },
    });
    expect(clash.statusCode).toBe(400);
  });

  it('turns a rejected Chatwoot token into a 400 with a hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, { error: 'Invalid Access Token' })),
    );
    const r = await app.inject({
      method: 'POST',
      url: `/admin/v1/tenants/${B.tenant.id}/chatwoot/connect`,
      headers: await h('super_admin'),
      payload: { mode: 'manual', accountId: 7, inboxId: 876543, botToken: 'wrong-token' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toMatch(/token rejected/);
  });
});

describe('connectInbox (Chatwoot one-click)', () => {
  it('creates the Agent Bot with our webhook URL and assigns it to the inbox', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        url: u,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (u.endsWith('/inboxes/55'))
        return json(200, {
          id: 55,
          name: 'Acme WhatsApp',
          channel_type: 'Channel::Whatsapp',
          phone_number: '+971500000000',
        });
      if (u.endsWith('/agent_bots') && (init?.method ?? 'GET') === 'GET') return json(200, []);
      if (u.endsWith('/agent_bots'))
        return json(200, { id: 9, name: 'NextAi Accountant', access_token: 'bot-secret' });
      if (u.endsWith('/set_agent_bot')) return json(200, {});
      return json(404, {});
    }) as typeof fetch;
    const r = await connectInbox('user-token', 3, 55, { fetch: f });
    expect(r).toMatchObject({
      botId: 9,
      botToken: 'bot-secret',
      created: true,
      inbox: { channelType: 'Channel::Whatsapp' },
    });
    const create = calls.find((x) => x.method === 'POST' && x.url.endsWith('/agent_bots'))!;
    expect((create.body as { outgoing_url: string }).outgoing_url).toBe(
      `${process.env.API_URL ?? 'http://localhost:8090'}/webhooks/chatwoot?token=${encodeURIComponent(process.env.CHATWOOT_WEBHOOK_SECRET!)}`,
    );
    expect(calls.find((x) => x.url.endsWith('/inboxes/55/set_agent_bot'))!.body).toEqual({ agent_bot: 9 });
  });
});
