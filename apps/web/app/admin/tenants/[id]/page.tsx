'use client';

import { Eye } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { H1, Stat, Table } from '@/components/admin/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { adminApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useAdmin } from '@/lib/admin-auth';

interface Detail {
  id: string;
  name: string;
  slug: string;
  country: string;
  currency: string;
  status: string;
  plan: { code: string; name: string } | null;
  settings: Record<string, unknown> & { provisioning?: Record<string, { status: string; note?: string; at: string }>; erpSetup?: { mode: string; status: string; step?: string; site?: string; attempts?: number; error?: string } };
  users: Array<{ id: string; name: string; phone: string; role: string; status: string; lastLoginAt: string | null }>;
  usageCounters: Array<{ period: string; messages: number; ocrPages: number; invoicesSent: number; aiCostMicros: number }>;
  connections: { erpnext: { configured: boolean; siteUrl: string | null; health: { ok: boolean; latencyMs: number; at: string } | null }; chatwoot: { configured: boolean; inboxId: number | null; staffInboxId: number | null }; erpWebhook: { configured: boolean } };
  limits: { users: number; ocrPagesPerMonth: number; invoicesSentPerMonth: number };
}

export default function TenantDetail() {
  const { id } = useParams<{ id: string }>();
  const { role } = useAdmin();
  const { data: t, reload } = useApi<Detail>(`/admin/v1/tenants/${id}`, adminApi);
  if (!t) return <div className="h-64 animate-pulse rounded-xl bg-line/60" />;
  const usage = t.usageCounters[0];
  const act = async (a: 'suspend' | 'resume') => {
    if (!confirm(`${a} ${t.name}?`)) return;
    await adminApi.post(`/admin/v1/tenants/${id}/${a}`);
    await reload();
  };
  const retrySetup = async () => {
    await adminApi.post(`/admin/v1/tenants/${id}/retry-setup`);
    await reload();
  };
  const viewAs = async () => {
    const r = await adminApi.post<{ url: string }>(`/admin/v1/tenants/${id}/impersonate`);
    window.open(r.url, '_blank', 'noopener');
  };
  const canOps = role === 'super_admin' || role === 'support';
  return (
    <div className="space-y-6">
      <H1
        action={
          canOps && (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => void viewAs()}><Eye className="h-4 w-4" /> View as tenant</Button>
              {t.status === 'suspended' ? <Button onClick={() => void act('resume')}>Resume</Button> : <Button variant="danger" onClick={() => void act('suspend')}>Suspend</Button>}
            </div>
          )
        }
      >
        {t.name} <Badge tone={t.status === 'active' ? 'green' : t.status === 'trial' ? 'amber' : 'red'}>{t.status}</Badge>
      </H1>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Plan" value={t.plan?.name ?? '—'} sub={`${t.country} · ${t.currency}`} />
        <Stat label="Bill entries" value={`${usage?.ocrPages ?? 0} / ${t.limits.ocrPagesPerMonth}`} sub={usage?.period} />
        <Stat label="Invoices sent" value={`${usage?.invoicesSent ?? 0} / ${t.limits.invoicesSentPerMonth}`} />
        <Stat label="AI cost" value={`$${((usage?.aiCostMicros ?? 0) / 1e6).toFixed(2)}`} sub={`${usage?.messages ?? 0} messages`} />
      </div>
      <section className="grid gap-3 md:grid-cols-3">
        <Conn name="ERPNext" ok={t.connections.erpnext.configured && (t.connections.erpnext.health?.ok ?? null)} detail={`${t.connections.erpnext.siteUrl ?? 'not set'}${t.connections.erpnext.health ? ` · ${t.connections.erpnext.health.latencyMs} ms` : ''}`} />
        <Conn name="Chatwoot" ok={t.connections.chatwoot.configured} detail={t.connections.chatwoot.inboxId ? `Inbox ${t.connections.chatwoot.inboxId}` : 'not mapped'} />
        <Conn name="ERPNext webhooks" ok={t.connections.erpWebhook.configured} detail={t.connections.erpWebhook.configured ? 'Secret set' : 'Not configured'} />
      </section>
      <StaffInbox tenantId={t.id} current={t.connections.chatwoot.staffInboxId} customerInbox={t.connections.chatwoot.inboxId} canEdit={canOps} onSaved={() => void reload()} />
      {t.settings.provisioning && (
        <section>
          <h2 className="mb-2 font-semibold">Provisioning</h2>
          {t.settings.erpSetup?.mode === 'site' && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card p-3 text-sm">
              <span>
                Own ERPNext site <strong>{t.settings.erpSetup.site}</strong>
              </span>
              <Badge tone={t.settings.erpSetup.status === 'ready' ? 'green' : t.settings.erpSetup.status === 'failed' ? 'red' : 'amber'}>{t.settings.erpSetup.status}</Badge>
              {t.settings.erpSetup.step && <span className="text-muted">step: {t.settings.erpSetup.step}</span>}
              {!!t.settings.erpSetup.attempts && <span className="text-muted">attempts: {t.settings.erpSetup.attempts}</span>}
              {t.settings.erpSetup.error && <span className="text-xs text-red-600">{t.settings.erpSetup.error}</span>}
              {canOps && t.settings.erpSetup.status !== 'ready' && (
                <Button variant="secondary" onClick={() => void retrySetup()}>
                  Retry setup
                </Button>
              )}
            </div>
          )}
          <Table rows={Object.entries(t.settings.provisioning)} cols={[{ h: 'Step', c: ([k]) => k }, { h: 'Status', c: ([, v]) => <Badge tone={v.status === 'done' ? 'green' : v.status === 'manual' ? 'amber' : 'red'}>{v.status}</Badge> }, { h: 'Note', c: ([, v]) => <span className="text-xs">{v.note}</span> }]} />
        </section>
      )}
      <section>
        <h2 className="mb-2 font-semibold">Users</h2>
        <Table rows={t.users} cols={[{ h: 'Name', c: (u) => u.name }, { h: 'Phone', c: (u) => u.phone }, { h: 'Role', c: (u) => u.role }, { h: 'Status', c: (u) => u.status }, { h: 'Last login', c: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—') }]} />
      </section>
      {t.connections.erpnext.configured && (
        <MoneyAccounts tenantId={t.id} settings={t.settings} canEdit={role === 'super_admin'} onSaved={() => void reload()} />
      )}
      <section>
        <h2 className="mb-2 font-semibold">Settings</h2>
        <pre className="overflow-x-auto rounded-xl border border-line bg-card p-3 text-xs">{JSON.stringify({ ...t.settings, provisioning: undefined }, null, 2)}</pre>
      </section>
    </div>
  );
}

/** The team's separate WhatsApp number (second Chatwoot inbox) for the business's Office. The owner manages everything else in the app. */
function StaffInbox({ tenantId, current, customerInbox, canEdit, onSaved }: { tenantId: string; current: number | null; customerInbox: number | null; canEdit: boolean; onSaved: () => void }) {
  const [v, setV] = useState(current ? String(current) : '');
  const [msg, setMsg] = useState('');
  const save = async () => {
    setMsg('');
    try {
      await adminApi.request(`/admin/v1/tenants/${tenantId}/staff-inbox`, { method: 'PUT', json: { inboxId: v ? Number(v) : null } });
      setMsg('Saved.');
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <section className="rounded-xl border border-line bg-card p-4 text-sm">
      <h2 className="mb-1 font-semibold">Staff WhatsApp number (Office)</h2>
      <p className="mb-2 text-muted">Chatwoot inbox id of the team's own number. Customer number: inbox {customerInbox ?? '—'}. Leave empty to send staff messages from the customer number.</p>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => (e.preventDefault(), void save())}>
        <input className="min-h-10 w-36 rounded-lg border border-line bg-bg px-3" inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ''))} placeholder="e.g. 12" aria-label="Staff inbox id" disabled={!canEdit} />
        {canEdit && <Button>Save</Button>}
        {msg && <span className="text-muted">{msg}</span>}
      </form>
    </section>
  );
}

type AccountLists = { company: string; cash: string[]; bank: string[]; card: string[]; current: { cash: string; bank: string | null; card: string | null } };

/** Which ledgers WhatsApp/app payments use: cash by default, bank only when a bank-type mode is mentioned, card when set. */
function MoneyAccounts({ tenantId, settings, canEdit, onSaved }: { tenantId: string; settings: Record<string, unknown>; canEdit: boolean; onSaved: () => void }) {
  const { data, error } = useApi<AccountLists>(`/admin/v1/tenants/${tenantId}/erpnext/accounts`, adminApi);
  const [pick, setPick] = useState<{ cash?: string; bank?: string; card?: string }>({});
  const [msg, setMsg] = useState('');
  if (error) return <p className="text-sm text-red-600">Money accounts: {error.message}</p>;
  if (!data) return null;
  const val = { cash: pick.cash ?? data.current.cash, bank: pick.bank ?? data.current.bank ?? '', card: pick.card ?? data.current.card ?? '' };
  const save = async () => {
    const accounts: Record<string, string> = { ...((settings.accounts as Record<string, string>) ?? {}), cash: val.cash };
    if (val.card) accounts.card = val.card;
    else delete accounts.card;
    await adminApi.patch(`/admin/v1/tenants/${tenantId}/settings`, { settings: { accounts, defaultBankAccount: val.bank || undefined } });
    setMsg('Saved. New entries use these accounts.');
    onSaved();
  };
  const Select = ({ k, label, hint, options, none }: { k: 'cash' | 'bank' | 'card'; label: string; hint: string; options: string[]; none?: string }) => (
    <label className="block text-sm">
      <span className="font-medium">{label}</span>
      <select
        disabled={!canEdit}
        className="mt-1 min-h-11 w-full rounded-xl border border-line bg-card px-3 text-base text-fg"
        value={val[k]}
        onChange={(e) => setPick({ ...pick, [k]: e.target.value })}
      >
        {none !== undefined && <option value="">{none}</option>}
        {[...new Set([...(val[k] ? [val[k]] : []), ...options])].map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
      <span className="text-xs text-muted">{hint}</span>
    </label>
  );
  return (
    <section>
      <h2 className="mb-2 font-semibold">Money accounts ({data.company})</h2>
      <div className="grid gap-3 rounded-xl border border-line bg-card p-4 md:grid-cols-3">
        <Select k="cash" label="Cash (default)" hint="Used when no payment mode is mentioned." options={data.cash} />
        <Select k="bank" label="Bank" hint="“by bank”, UPI, transfer, cheque." options={data.bank} none="First bank account in ERPNext" />
        <Select k="card" label="Credit card" hint="“by card”. Not set = cash." options={data.card} none="Not set (use cash)" />
      </div>
      {canEdit && (
        <div className="mt-2 flex items-center gap-3">
          <Button onClick={() => void save()}>Save accounts</Button>
          {msg && <span className="text-sm text-emerald-600">{msg}</span>}
        </div>
      )}
    </section>
  );
}

function Conn({ name, ok, detail }: { name: string; ok: boolean | null; detail: string }) {
  return (
    <div className="rounded-xl border border-line bg-card p-4">
      <div className="flex items-center justify-between"><span className="font-medium">{name}</span><span className={`h-2.5 w-2.5 rounded-full ${ok === null ? 'bg-line' : ok ? 'bg-emerald-500' : 'bg-red-500'}`} /></div>
      <p className="mt-1 truncate text-xs text-muted">{detail}</p>
    </div>
  );
}
