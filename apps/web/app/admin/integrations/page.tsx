'use client';

import { useState } from 'react';
import { H1 } from '@/components/admin/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { adminApi, ApiError } from '@/lib/api';
import { useAdmin } from '@/lib/admin-auth';
import { useApi } from '@/lib/hooks';

type TenantRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  chatwoot: { connected: boolean; accountId: number | null; inboxId: number | null };
  erpnext: { connected: boolean; siteUrl: string | null; company: string | null; abbr: string | null };
  owner: { name: string; phone: string | null; email: string | null } | null;
  emailReports: { enabled: boolean; recipients: string[] };
};
type Status = {
  chatwoot: {
    baseUrl: string;
    webhookUrl: string;
    webhookIpAllowlist: string[];
    webhookBlockedInProd: boolean;
    mock: boolean;
  };
  email: { provider: string; configured: boolean; from: string; adminReportRecipients: string[] };
  stripe: { configured: boolean };
  storage: { r2: boolean };
  ai: { vision: string; stt: string; llm: string };
  provisioner: { configured: boolean };
  appUrl: string;
  apiUrl: string;
  tenants: TenantRow[];
};
type Inbox = { id: number; name: string; channelType: string; phoneNumber?: string };

const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

function Card({ title, ok, children }: { title: string; ok: boolean | null; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-card p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-semibold">{title}</span>
        <Badge tone={ok === null ? 'neutral' : ok ? 'green' : 'amber'}>
          {ok === null ? 'n/a' : ok ? 'Ready' : 'Needs setup'}
        </Badge>
      </div>
      <div className="space-y-1 text-sm text-muted">{children}</div>
    </div>
  );
}

function Result({ r }: { r: { ok: boolean; text: string } | null }) {
  if (!r) return null;
  return <p className={`mt-2 break-words text-sm ${r.ok ? 'text-emerald-600' : 'text-red-600'}`}>{r.text}</p>;
}

function TenantPanel({ t, canConnect, onSaved }: { t: TenantRow; canConnect: boolean; onSaved: () => void }) {
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [cw, setCw] = useState({
    accountId: t.chatwoot.accountId ? String(t.chatwoot.accountId) : '',
    inboxId: t.chatwoot.inboxId ? String(t.chatwoot.inboxId) : '',
    userToken: '',
    botToken: '',
  });
  const [inboxes, setInboxes] = useState<Inbox[] | null>(null);
  const [erp, setErp] = useState({ siteUrl: t.erpnext.connected ? (t.erpnext.siteUrl ?? '') : '', apiKey: '', apiSecret: '', company: '' });
  const [companies, setCompanies] = useState<Array<{ name: string; abbr: string; currency?: string }> | null>(null);
  const [phone, setPhone] = useState(t.owner?.phone ?? '');
  const [recipients, setRecipients] = useState(t.emailReports.recipients.join(', '));
  const [enabled, setEnabled] = useState(t.emailReports.enabled);
  const [res, setRes] = useState<Record<string, { ok: boolean; text: string } | null>>({});
  const [busy, setBusy] = useState('');

  const act = async (key: string, f: () => Promise<string>) => {
    setBusy(key);
    setRes((r) => ({ ...r, [key]: null }));
    try {
      const text = await f();
      setRes((r) => ({ ...r, [key]: { ok: true, text } }));
    } catch (e) {
      setRes((r) => ({ ...r, [key]: { ok: false, text: msg(e) } }));
    } finally {
      setBusy('');
    }
  };

  return (
    <details className="rounded-xl border border-line bg-card">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-4">
        <span className="font-medium">{t.name}</span>
        <span className="text-xs text-muted">{t.slug}</span>
        <Badge tone={t.chatwoot.connected ? 'green' : 'amber'}>
          {t.chatwoot.connected ? `WhatsApp inbox ${t.chatwoot.inboxId}` : 'WhatsApp not connected'}
        </Badge>
        <Badge tone={t.erpnext.connected ? 'green' : 'amber'}>
          {t.erpnext.connected ? `ERPNext: ${t.erpnext.company ?? 'connected'}` : 'ERPNext not connected'}
        </Badge>
        <Badge tone={t.emailReports.enabled ? 'green' : 'neutral'}>
          {t.emailReports.enabled ? 'Email reports on' : 'Email reports off'}
        </Badge>
      </summary>
      <div className="grid gap-6 border-t border-line p-4 lg:grid-cols-2">
        <section>
          <h3 className="mb-2 font-semibold">Chatwoot / WhatsApp</h3>
          {canConnect && (
            <>
              <div className="mb-3 flex gap-2 text-sm">
                <Button
                  size="md"
                  variant={mode === 'auto' ? 'primary' : 'secondary'}
                  onClick={() => setMode('auto')}
                >
                  Admin token (automatic)
                </Button>
                <Button
                  size="md"
                  variant={mode === 'manual' ? 'primary' : 'secondary'}
                  onClick={() => setMode('manual')}
                >
                  Bot token (manual)
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Account ID" hint="Number in the Chatwoot URL: /app/accounts/<id>/…">
                  <Input
                    inputMode="numeric"
                    value={cw.accountId}
                    onChange={(e) => setCw({ ...cw, accountId: e.target.value })}
                  />
                </Field>
                <Field label="Inbox ID" hint="Settings → Inboxes → the WhatsApp inbox: /inboxes/<id>">
                  <Input
                    inputMode="numeric"
                    value={cw.inboxId}
                    onChange={(e) => setCw({ ...cw, inboxId: e.target.value })}
                  />
                </Field>
              </div>
              {mode === 'auto' ? (
                <Field
                  label="Your Chatwoot access token"
                  hint="Profile settings → Access Token (administrator). Used once, not stored."
                >
                  <Input
                    type="password"
                    autoComplete="off"
                    value={cw.userToken}
                    onChange={(e) => setCw({ ...cw, userToken: e.target.value })}
                  />
                </Field>
              ) : (
                <Field
                  label="Agent Bot token"
                  hint="Settings → Bots → NextAi → Access token. Stored encrypted."
                >
                  <Input
                    type="password"
                    autoComplete="off"
                    value={cw.botToken}
                    onChange={(e) => setCw({ ...cw, botToken: e.target.value })}
                  />
                </Field>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {mode === 'auto' && (
                  <Button
                    variant="secondary"
                    disabled={!cw.accountId || !cw.userToken || !!busy}
                    onClick={() =>
                      act('inboxes', async () => {
                        const r = await adminApi.post<{ items: Inbox[] }>(
                          '/admin/v1/integrations/chatwoot/inboxes',
                          { accountId: Number(cw.accountId), userToken: cw.userToken },
                        );
                        setInboxes(r.items);
                        return `${r.items.length} inbox(es) found`;
                      })
                    }
                  >
                    Find inboxes
                  </Button>
                )}
                <Button
                  disabled={
                    !cw.accountId || !cw.inboxId || !(mode === 'auto' ? cw.userToken : cw.botToken) || !!busy
                  }
                  onClick={() =>
                    act('connect', async () => {
                      const body =
                        mode === 'auto'
                          ? {
                              mode,
                              accountId: Number(cw.accountId),
                              inboxId: Number(cw.inboxId),
                              userToken: cw.userToken,
                            }
                          : {
                              mode,
                              accountId: Number(cw.accountId),
                              inboxId: Number(cw.inboxId),
                              botToken: cw.botToken,
                            };
                      const r = await adminApi.post<{ openConversations: number; botCreated?: boolean }>(
                        `/admin/v1/tenants/${t.id}/chatwoot/connect`,
                        body,
                      );
                      setCw((x) => ({ ...x, userToken: '', botToken: '' }));
                      onSaved();
                      return `Connected${r.botCreated ? ' (Agent Bot created and assigned)' : ''}. Open conversations: ${r.openConversations}.`;
                    })
                  }
                >
                  {busy === 'connect' ? 'Connecting…' : 'Connect inbox'}
                </Button>
              </div>
              <Result r={res.inboxes ?? null} />
              {inboxes && (
                <ul className="mt-2 space-y-1 text-sm">
                  {inboxes.map((i) => (
                    <li key={i.id}>
                      <button
                        className="text-brand underline"
                        onClick={() => setCw({ ...cw, inboxId: String(i.id) })}
                      >
                        #{i.id} {i.name}
                      </button>{' '}
                      <span className="text-muted">
                        {i.channelType.replace('Channel::', '')} {i.phoneNumber ?? ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Result r={res.connect ?? null} />
            </>
          )}
          {t.chatwoot.connected && (
            <div className="mt-4 space-y-2">
              <Field
                label="Send a test WhatsApp to"
                hint="Free-text works only within 24h of that number messaging the inbox."
              >
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+9715…" />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={!!busy}
                  onClick={() =>
                    act('verify', async () => {
                      const r = await adminApi.post<{ openConversations?: number; mock?: boolean }>(
                        `/admin/v1/tenants/${t.id}/chatwoot/verify`,
                      );
                      return r.mock
                        ? 'OK (mock mode)'
                        : `Bot token OK. Open conversations: ${r.openConversations}`;
                    })
                  }
                >
                  Verify token
                </Button>
                <Button
                  variant="secondary"
                  disabled={!phone || !!busy}
                  onClick={() =>
                    act('test', async () => {
                      const r = await adminApi.post<{ conversationId: number }>(
                        `/admin/v1/tenants/${t.id}/chatwoot/test`,
                        { phone },
                      );
                      return `Sent (conversation ${r.conversationId})`;
                    })
                  }
                >
                  Send test message
                </Button>
              </div>
              <Result r={res.verify ?? null} />
              <Result r={res.test ?? null} />
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 font-semibold">ERPNext (books)</h3>
          {t.erpnext.connected && (
            <p className="mb-2 text-sm text-muted">
              Connected to {t.erpnext.siteUrl} · company {t.erpnext.company} ({t.erpnext.abbr}). Entries confirmed on
              WhatsApp or in the app are posted here.
            </p>
          )}
          {canConnect ? (
            <>
              <p className="mb-2 text-sm text-muted">
                Connect an existing ERPNext site. In ERPNext: User → (an API user with Accounts Manager role) →
                Settings → API Access → Generate Keys.
              </p>
              <div className="grid gap-2">
                <Field label="Site URL" hint="e.g. https://books.example.com">
                  <Input value={erp.siteUrl} onChange={(e) => setErp({ ...erp, siteUrl: e.target.value })} placeholder="https://" />
                </Field>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="API key">
                    <Input value={erp.apiKey} onChange={(e) => setErp({ ...erp, apiKey: e.target.value })} autoComplete="off" />
                  </Field>
                  <Field label="API secret" hint="Stored encrypted.">
                    <Input type="password" value={erp.apiSecret} onChange={(e) => setErp({ ...erp, apiSecret: e.target.value })} autoComplete="off" />
                  </Field>
                </div>
                {companies && (
                  <Field label="Company" hint="This site has several companies: choose the one for this business.">
                    <select
                      className="min-h-12 w-full rounded-xl border border-line bg-card px-3 text-base text-fg"
                      value={erp.company}
                      onChange={(e) => setErp({ ...erp, company: e.target.value })}
                    >
                      <option value="">Choose…</option>
                      {companies.map((co) => (
                        <option key={co.name} value={co.name}>
                          {co.name} ({co.abbr}{co.currency ? `, ${co.currency}` : ''})
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  disabled={!erp.siteUrl || !erp.apiKey || !erp.apiSecret || (!!companies && !erp.company) || !!busy}
                  onClick={() =>
                    act('erp', async () => {
                      const r = await adminApi.post<{
                        ok: boolean;
                        needsCompany?: boolean;
                        companies?: Array<{ name: string; abbr: string; currency?: string }>;
                        company?: string;
                        abbr?: string;
                        user?: string;
                        warnings?: string[];
                      }>(`/admin/v1/tenants/${t.id}/erpnext/connect`, { ...erp, company: erp.company || undefined });
                      if (r.needsCompany) {
                        setCompanies(r.companies ?? []);
                        return 'Signed in. Choose the company, then Connect again.';
                      }
                      setErp({ ...erp, apiKey: '', apiSecret: '' });
                      setCompanies(null);
                      onSaved();
                      return [`Connected to ${r.company} (${r.abbr}) as ${r.user}.`, ...(r.warnings ?? [])].join(' ');
                    })
                  }
                >
                  {t.erpnext.connected ? 'Reconnect' : 'Connect ERPNext'}
                </Button>
              </div>
              <Result r={res.erp ?? null} />
            </>
          ) : (
            !t.erpnext.connected && <p className="text-sm text-muted">Ask a super admin to connect ERPNext.</p>
          )}
        </section>

        <section>
          <h3 className="mb-2 font-semibold">Email reports (Resend)</h3>
          <p className="mb-2 text-sm text-muted">
            Daily summary goes to the owner{t.owner?.email ? ` (${t.owner.email})` : ' (no email on file)'}{' '}
            plus these recipients, at the tenant&apos;s summary hour.
          </p>
          <label className="mb-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Send
            daily summary by email
          </label>
          <Field label="Extra recipients" hint="Comma separated, up to 10 (e.g. the accountant).">
            <Input
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="accounts@example.com"
            />
          </Field>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              disabled={!!busy}
              onClick={() =>
                act('recipients', async () => {
                  const list = recipients
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  await adminApi.put(`/admin/v1/tenants/${t.id}/email-reports`, {
                    enabled,
                    recipients: list,
                  });
                  onSaved();
                  return 'Saved';
                })
              }
            >
              Save
            </Button>
            <Button
              variant="secondary"
              disabled={!!busy}
              onClick={() =>
                act('summary', async () => {
                  const r = await adminApi.post<{ to: string[] }>(`/admin/v1/tenants/${t.id}/email-summary`);
                  return `Summary sent to ${r.to.join(', ')}`;
                })
              }
            >
              Send today&apos;s summary now
            </Button>
          </div>
          <Result r={res.recipients ?? null} />
          <Result r={res.summary ?? null} />
        </section>
      </div>
    </details>
  );
}

export default function Integrations() {
  const { role } = useAdmin();
  const isSuper = role === 'super_admin';
  const { data, reload } = useApi<Status>('/admin/v1/integrations', adminApi);
  const [testTo, setTestTo] = useState('');
  const [mailRes, setMailRes] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (f: () => Promise<string>) => {
    setMailRes(null);
    try {
      setMailRes({ ok: true, text: await f() });
    } catch (e) {
      setMailRes({ ok: false, text: msg(e) });
    }
  };

  return (
    <div>
      <H1
        action={
          <Button variant="secondary" onClick={() => void reload()}>
            Refresh
          </Button>
        }
      >
        Integrations
      </H1>
      {data && (
        <>
          <div className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Card title="Chatwoot (WhatsApp)" ok={!data.chatwoot.webhookBlockedInProd}>
              <p>
                Base URL: {data.chatwoot.baseUrl}
                {data.chatwoot.mock ? ' (mock mode)' : ''}
              </p>
              <p className="break-all">Agent Bot webhook: {data.chatwoot.webhookUrl}</p>
              <p>IP allowlist: {data.chatwoot.webhookIpAllowlist.join(', ') || '—'}</p>
              {data.chatwoot.webhookBlockedInProd && (
                <p className="text-red-600">
                  CHATWOOT_ALLOWED_IPS is empty: production rejects all Chatwoot webhooks.
                </p>
              )}
            </Card>
            <Card title="Email (Resend)" ok={data.email.configured}>
              <p>From: {data.email.from}</p>
              <p>
                Admin report to:{' '}
                {data.email.adminReportRecipients.join(', ') || '— (set ADMIN_REPORT_EMAILS)'}
              </p>
              {!data.email.configured && (
                <p className="text-amber-700">Set RESEND_API_KEY and a verified MAIL_FROM domain.</p>
              )}
            </Card>
            <Card title="Mobile app (PWA)" ok>
              <p className="break-all">App: {data.appUrl}</p>
              <p className="break-all">API: {data.apiUrl}</p>
              <p>Install: open the app URL on the phone → Share / ⋮ → Add to Home Screen.</p>
            </Card>
            <Card title="Stripe" ok={data.stripe.configured}>
              <p>Billing checkout and webhooks.</p>
            </Card>
            <Card title="Storage (R2)" ok={data.storage.r2}>
              <p>{data.storage.r2 ? 'Cloudflare R2' : 'Local disk fallback'}</p>
            </Card>
            <Card title="AI providers" ok={data.ai.vision !== 'mock' && data.ai.llm !== 'mock'}>
              <p>
                Vision: {data.ai.vision} · Speech: {data.ai.stt} · LLM: {data.ai.llm}
              </p>
            </Card>
          </div>

          {isSuper && (
            <div className="mb-6 rounded-xl border border-line bg-card p-4">
              <h2 className="mb-2 font-semibold">Test email</h2>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-60 flex-1">
                  <Field label="Send a test email to">
                    <Input
                      type="email"
                      value={testTo}
                      onChange={(e) => setTestTo(e.target.value)}
                      placeholder="you@company.com"
                    />
                  </Field>
                </div>
                <Button
                  disabled={!testTo}
                  onClick={() =>
                    void run(
                      async () =>
                        `Sent (id ${(await adminApi.post<{ id: string }>('/admin/v1/integrations/email/test', { to: testTo })).id})`,
                    )
                  }
                >
                  Send test
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void run(async () => {
                      await adminApi.post('/admin/v1/integrations/admin-report/send');
                      return 'Platform report sent';
                    })
                  }
                >
                  Send platform report now
                </Button>
              </div>
              <Result r={mailRes} />
            </div>
          )}

          <h2 className="mb-2 font-semibold">Tenants</h2>
          <div className="space-y-2">
            {data.tenants.map((t) => (
              <TenantPanel key={t.id} t={t} canConnect={isSuper} onSaved={() => void reload()} />
            ))}
            {data.tenants.length === 0 && (
              <p className="text-sm text-muted">No tenants yet — create one under Provision.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
