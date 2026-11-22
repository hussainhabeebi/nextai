'use client';

import { LIFECYCLE_ROLES, REMINDER_AUDIENCES } from '@nextai/shared';
import { useEffect, useState } from 'react';
import { H1, Stat, Table } from '@/components/admin/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { adminApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';

type Level = { id: string; level: number; offsetMinutes: number; audience: string; templateKey: string; message: string; enabled: boolean };
type Rule = { id: string; key: string; stage: number; name: string; description: string | null; ownerRole: string; escalationRole: string; enabled: boolean; openTimers: number; levels: Level[] };
type Staff = { id: string; name: string; phone: string; erpUser: string | null; roles: string[]; active: boolean };
type Settings = { digestEnabled: boolean; digestHourLocal: number; healthThreshold: number; dataChecklist: string[]; autoIssueFromWhatsApp: boolean };
type Data = { rules: Rule[]; staff: Staff[]; leadWebhook: { configured: boolean; url: string }; erpWebhookUrl: string; settings: Settings };
type Report = {
  days: number;
  funnel: Array<{ key: string; label: string; count: number; conversion: number | null }>;
  sources: Record<string, number>;
  stages: Array<{ key: string; stage: number; name: string; enabled: boolean; started: number; done: number; cancelled: number; open: number; escalated: number }>;
  owners: Array<{ name: string; open: number; escalated: number; done: number }>;
  overdue: Array<{ id: string; rule: string; doctype: string; docName: string; customerName: string | null; owner: string | null; anchorAt: string }>;
};
type Timer = { id: string; doctype: string; docName: string; anchorAt: string; sentLevels: number[]; customerName: string | null; rule: { key: string; name: string; stage: number }; owner: { name: string } | null };

const AUDIENCE_LABEL: Record<string, string> = { owner: 'Owner', escalation: 'Escalation', customer: 'Customer', management: 'Management' };
const UNITS = [
  { label: 'minutes', m: 1 },
  { label: 'hours', m: 60 },
  { label: 'days', m: 1440 },
];

/** -2880 → { n: 2, unit: 1440, dir: -1 } */
function splitOffset(min: number) {
  const abs = Math.abs(min);
  const unit = [...UNITS].reverse().find((u) => abs % u.m === 0 && abs >= u.m) ?? UNITS[0]!;
  return { n: abs / unit.m, unit: unit.m, dir: min < 0 ? -1 : 1 };
}
function formatOffset(min: number) {
  if (min === 0) return 'immediately';
  const { n, unit, dir } = splitOffset(min);
  const label = UNITS.find((u) => u.m === unit)!.label;
  return `${n} ${n === 1 ? label.slice(0, -1) : label} ${dir < 0 ? 'before' : 'after'}`;
}

function OffsetInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const s = splitOffset(value);
  const set = (p: Partial<typeof s>) => {
    const x = { ...s, ...p };
    onChange(x.dir * x.n * x.unit);
  };
  return (
    <div className="flex gap-1">
      <Input type="number" min={0} className="w-20" value={s.n} onChange={(e) => set({ n: Math.max(0, Number(e.target.value) || 0) })} aria-label="Amount" />
      <Select className="w-36" value={s.unit} onChange={(e) => set({ unit: Number(e.target.value) })} aria-label="Unit">
        {UNITS.map((u) => <option key={u.m} value={u.m}>{u.label}</option>)}
      </Select>
      <Select className="w-32" value={s.dir} onChange={(e) => set({ dir: Number(e.target.value) })} aria-label="Before or after">
        <option value={-1}>before</option>
        <option value={1}>after</option>
      </Select>
    </div>
  );
}

function LevelEditor({ initial, onSave, onCancel }: { initial: Omit<Level, 'id' | 'level'>; onSave: (l: Omit<Level, 'id' | 'level'>) => Promise<void>; onCancel: () => void }) {
  const [l, setL] = useState(initial);
  return (
    <form className="grid gap-2 rounded-lg border border-line bg-bg p-3" onSubmit={(e) => (e.preventDefault(), void onSave(l))}>
      <div className="flex flex-wrap items-center gap-2">
        <OffsetInput value={l.offsetMinutes} onChange={(offsetMinutes) => setL({ ...l, offsetMinutes })} />
        <Select className="w-44" value={l.audience} onChange={(e) => setL({ ...l, audience: e.target.value })} aria-label="Send to">
          {REMINDER_AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
        </Select>
        <Input className="w-48" value={l.templateKey} onChange={(e) => setL({ ...l, templateKey: e.target.value })} placeholder="template key" aria-label="WhatsApp template key" />
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" className="h-4 w-4" checked={l.enabled} onChange={(e) => setL({ ...l, enabled: e.target.checked })} /> On</label>
      </div>
      <textarea className="min-h-16 rounded-lg border border-line bg-card p-2 text-sm" value={l.message} onChange={(e) => setL({ ...l, message: e.target.value })} required aria-label="Message" />
      <p className="text-xs text-muted">Placeholders: {'{{customer_name}} {{owner_name}} {{name}} {{lead_name}} {{phone}} {{start_time}} {{amount}} {{due_date}} {{project}} {{subject}} {{end_date}} {{health_score}} {{health_reasons}} {{month}}'}</p>
      <div className="flex gap-2">
        <Button>Save</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function RuleCard({ tenantId, rule, reload }: { tenantId: string; rule: Rule; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const base = `/admin/v1/tenants/${tenantId}/lifecycle`;
  const patchRule = async (json: Partial<Rule>) => (await adminApi.request(`${base}/rules/${rule.id}`, { method: 'PATCH', json }), reload());
  const patchLevel = async (id: string, json: Partial<Level>) => (await adminApi.request(`${base}/levels/${id}`, { method: 'PATCH', json }), reload());
  const del = async (id: string) => {
    if (!confirm('Delete this reminder level?')) return;
    await adminApi.request(`${base}/levels/${id}`, { method: 'DELETE' });
    await reload();
  };
  return (
    <section className={`rounded-xl border border-line bg-card p-4 ${rule.enabled ? '' : 'opacity-60'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted">Stage {rule.stage} · <code>{rule.key}</code> · {rule.openTimers} open</p>
          <h2 className="font-semibold">{rule.name}</h2>
          {rule.description && <p className="text-sm text-muted">{rule.description}</p>}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1">Owner
            <Select value={rule.ownerRole} onChange={(e) => void patchRule({ ownerRole: e.target.value })}>{LIFECYCLE_ROLES.map((r) => <option key={r}>{r}</option>)}</Select>
          </label>
          <label className="flex items-center gap-1">Escalate to
            <Select value={rule.escalationRole} onChange={(e) => void patchRule({ escalationRole: e.target.value })}>{LIFECYCLE_ROLES.map((r) => <option key={r}>{r}</option>)}</Select>
          </label>
          <label className="flex items-center gap-1"><input type="checkbox" className="h-5 w-5" checked={rule.enabled} onChange={(e) => void patchRule({ enabled: e.target.checked })} /> Rule on</label>
        </div>
      </div>
      <ol className="mt-3 divide-y divide-line">
        {rule.levels.map((l) => (
          <li key={l.id} className="py-2">
            {editing === l.id ? (
              <LevelEditor initial={l} onCancel={() => setEditing(null)} onSave={async (v) => (await patchLevel(l.id, v), setEditing(null))} />
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-6 text-muted">L{l.level}</span>
                <Badge tone={l.enabled ? 'green' : 'neutral'}>{l.enabled ? 'On' : 'Off'}</Badge>
                <span className="font-medium">{formatOffset(l.offsetMinutes)}</span>
                <span>→ {AUDIENCE_LABEL[l.audience]}</span>
                <span className="order-last min-w-0 basis-full text-muted sm:order-none sm:basis-0 sm:flex-1 sm:truncate" title={l.message}>{l.message}</span>
                <span className="ms-auto flex items-center gap-1">
                  <input type="checkbox" className="h-5 w-5" checked={l.enabled} onChange={(e) => void patchLevel(l.id, { enabled: e.target.checked })} aria-label={`Level ${l.level} on`} />
                  <Button variant="ghost" onClick={() => setEditing(l.id)}>Edit</Button>
                  <Button variant="ghost" onClick={() => void del(l.id)}>Delete</Button>
                </span>
              </div>
            )}
          </li>
        ))}
      </ol>
      {editing === 'new' ? (
        <LevelEditor
          initial={{ offsetMinutes: 60, audience: 'owner', templateKey: 'lifecycle_notice', message: '', enabled: true }}
          onCancel={() => setEditing(null)}
          onSave={async (v) => (await adminApi.request(`${base}/rules/${rule.id}/levels`, { method: 'POST', json: v }), await reload(), setEditing(null))}
        />
      ) : (
        <Button variant="secondary" className="mt-2" onClick={() => setEditing('new')}>Add reminder level</Button>
      )}
    </section>
  );
}

function StaffPanel({ tenantId, staff, reload }: { tenantId: string; staff: Staff[]; reload: () => Promise<void> }) {
  const [f, setF] = useState({ name: '', phone: '', erpUser: '', roles: ['sales'] as string[] });
  const [err, setErr] = useState('');
  const add = async () => {
    setErr('');
    try {
      await adminApi.request(`/admin/v1/tenants/${tenantId}/staff`, { method: 'POST', json: { ...f, erpUser: f.erpUser || null } });
      setF({ name: '', phone: '', erpUser: '', roles: ['sales'] });
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const patch = async (id: string, json: Partial<Staff>) => (await adminApi.request(`/admin/v1/tenants/${tenantId}/staff/${id}`, { method: 'PATCH', json }), reload());
  return (
    <div>
      <form className="mb-3 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]" onSubmit={(e) => (e.preventDefault(), void add())}>
        <Input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <Input placeholder="WhatsApp number" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required />
        <Input placeholder="ERPNext user (email)" value={f.erpUser} onChange={(e) => setF({ ...f, erpUser: e.target.value })} />
        <Select multiple value={f.roles} onChange={(e) => setF({ ...f, roles: [...e.target.selectedOptions].map((o) => o.value) })} aria-label="Roles" className="h-24">
          {LIFECYCLE_ROLES.map((r) => <option key={r}>{r}</option>)}
        </Select>
        <Button>Add</Button>
      </form>
      {err && <p className="mb-2 text-sm text-red-600">{err}</p>}
      <Table
        rows={staff}
        empty="No staff yet. Add the people who receive reminders."
        cols={[
          { h: 'Name', c: (s) => s.name },
          { h: 'WhatsApp', c: (s) => s.phone },
          { h: 'ERPNext user', c: (s) => s.erpUser ?? '—' },
          { h: 'Roles', c: (s) => s.roles.join(', ') },
          { h: 'Active', c: (s) => <input type="checkbox" className="h-5 w-5" checked={s.active} onChange={(e) => void patch(s.id, { active: e.target.checked })} /> },
        ]}
      />
    </div>
  );
}

function SettingsPanel({ tenantId, settings, reload }: { tenantId: string; settings: Settings; reload: () => Promise<void> }) {
  const [f, setF] = useState({ ...settings, checklist: settings.dataChecklist.join(', ') });
  const [saved, setSaved] = useState(false);
  const save = async () => {
    const { checklist, ...rest } = f;
    await adminApi.request(`/admin/v1/tenants/${tenantId}/lifecycle/settings`, { method: 'PATCH', json: { ...rest, dataChecklist: checklist.split(',').map((x) => x.trim()).filter(Boolean) } });
    setSaved(true);
    await reload();
  };
  return (
    <form className="grid gap-3 rounded-xl border border-line bg-card p-4" onSubmit={(e) => (e.preventDefault(), void save())}>
      <h2 className="font-semibold">Automation settings</h2>
      <label className="flex flex-wrap items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={f.digestEnabled} onChange={(e) => setF({ ...f, digestEnabled: e.target.checked })} /> Morning WhatsApp digest to each staff member at
        <Input type="number" min={0} max={23} className="w-20" value={f.digestHourLocal} onChange={(e) => setF({ ...f, digestHourLocal: Number(e.target.value) })} aria-label="Digest hour" />:00
      </label>
      <label className="flex flex-wrap items-center gap-2">Alert management when the health score at day 7 / day 30 is below
        <Input type="number" min={0} max={100} className="w-20" value={f.healthThreshold} onChange={(e) => setF({ ...f, healthThreshold: Number(e.target.value) })} aria-label="Health threshold" />
      </label>
      <label className="grid gap-1">Onboarding data the AI chases the customer for (comma separated)
        <Input value={f.checklist} onChange={(e) => setF({ ...f, checklist: e.target.value })} />
      </label>
      <label className="flex flex-wrap items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={f.autoIssueFromWhatsApp} onChange={(e) => setF({ ...f, autoIssueFromWhatsApp: e.target.checked })} /> Turn WhatsApp messages from known customers (with no open step) into ERPNext Issues</label>
      <div className="flex items-center gap-3"><Button>Save settings</Button>{saved && <span className="text-muted">Saved.</span>}</div>
    </form>
  );
}

function ReportPanel({ tenantId }: { tenantId: string }) {
  const [days, setDays] = useState(30);
  const { data: r } = useApi<Report>(`/admin/v1/tenants/${tenantId}/lifecycle/report?days=${days}`, adminApi);
  if (!r) return <div className="h-32 animate-pulse rounded-xl bg-line/60" />;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 [&>*]:min-w-0">
      <div className="flex items-center gap-2 text-sm">Last
        <Select className="w-36" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">{[7, 30, 90, 365].map((d) => <option key={d} value={d}>{d} days</option>)}</Select>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {r.funnel.map((f) => <Stat key={f.key} label={f.label} value={f.count} sub={f.conversion === null ? undefined : `${f.conversion}% of previous`} />)}
      </div>
      <section>
        <h2 className="mb-2 font-semibold">Lead sources</h2>
        <Table rows={Object.entries(r.sources).sort((a, b) => b[1] - a[1])} empty="No leads in this period." cols={[{ h: 'Source', c: (x) => x[0] }, { h: 'Leads', c: (x) => x[1] }]} />
      </section>
      <section>
        <h2 className="mb-2 font-semibold">🔴 Escalated and still open ({r.overdue.length})</h2>
        <Table
          rows={r.overdue}
          empty="Nothing escalated. 🎉"
          cols={[
            { h: 'Step', c: (x) => x.rule },
            { h: 'Document', c: (x) => `${x.doctype} ${x.docName}` },
            { h: 'Customer', c: (x) => x.customerName ?? '—' },
            { h: 'Owner', c: (x) => x.owner ?? '—' },
            { h: 'Since', c: (x) => new Date(x.anchorAt).toLocaleString() },
          ]}
        />
      </section>
      <section>
        <h2 className="mb-2 font-semibold">People</h2>
        <Table rows={r.owners} cols={[{ h: 'Owner', c: (x) => x.name }, { h: 'Open', c: (x) => x.open }, { h: 'Escalated', c: (x) => x.escalated }, { h: 'Done', c: (x) => x.done }]} />
      </section>
      <section>
        <h2 className="mb-2 font-semibold">Stages</h2>
        <Table
          rows={r.stages}
          cols={[
            { h: 'Stage', c: (x) => `${x.stage} · ${x.name}${x.enabled ? '' : ' (off)'}` },
            { h: 'Started', c: (x) => x.started },
            { h: 'Done', c: (x) => x.done },
            { h: 'Cancelled', c: (x) => x.cancelled },
            { h: 'Open now', c: (x) => x.open },
            { h: 'Escalated', c: (x) => (x.started ? `${x.escalated} (${Math.round((x.escalated / x.started) * 100)}%)` : '0') },
          ]}
        />
      </section>
    </div>
  );
}

export default function Lifecycle() {
  const { data: tenants } = useApi<{ items: Array<{ id: string; name: string; slug: string }> }>('/admin/v1/tenants', adminApi);
  const [tenantId, setTenantId] = useState('');
  const [tab, setTab] = useState<'report' | 'rules' | 'staff' | 'timers' | 'setup'>('report');
  const [secret, setSecret] = useState('');
  useEffect(() => {
    if (!tenantId && tenants?.items[0]) setTenantId(tenants.items[0].id);
  }, [tenants, tenantId]);
  const { data, reload } = useApi<Data>(tenantId ? `/admin/v1/tenants/${tenantId}/lifecycle` : null, adminApi);
  const { data: timers } = useApi<{ items: Timer[] }>(tenantId && tab === 'timers' ? `/admin/v1/tenants/${tenantId}/lifecycle/timers` : null, adminApi);
  const install = async () => (await adminApi.request(`/admin/v1/tenants/${tenantId}/lifecycle/install`, { method: 'POST' }), reload());
  const rotate = async () => {
    if (data?.leadWebhook.configured && !confirm('Rotate the secret? Leadvyne must be updated with the new one.')) return;
    const r = await adminApi.request<{ secret: string }>(`/admin/v1/tenants/${tenantId}/lifecycle/lead-webhook-secret`, { method: 'POST' });
    setSecret(r.secret);
    await reload();
  };

  return (
    <div>
      <H1
        action={
          <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)} aria-label="Tenant">
            {tenants?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        }
      >
        Lifecycle & reminders
      </H1>
      <p className="mb-4 text-sm text-muted">Lead → customer → support playbook. Every reminder level can be re-timed, re-targeted, reworded or switched off.</p>
      <div className="mb-4 flex gap-1 overflow-x-auto">
        {(['report', 'rules', 'staff', 'timers', 'setup'] as const).map((t) => (
          <Button key={t} variant={tab === t ? 'primary' : 'ghost'} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</Button>
        ))}
      </div>

      {tab === 'rules' && data && (
        data.rules.length === 0 ? (
          <div className="rounded-xl border border-line bg-card p-6 text-center">
            <p className="mb-3 text-sm">No playbook installed for this tenant.</p>
            <Button onClick={() => void install()}>Install default 19-stage playbook</Button>
          </div>
        ) : (
          <div className="grid gap-3">
            {data.rules.map((r) => <RuleCard key={r.id} tenantId={tenantId} rule={r} reload={reload} />)}
            <Button variant="ghost" onClick={() => void install()}>Add missing default rules</Button>
          </div>
        )
      )}

      {tab === 'report' && tenantId && <ReportPanel tenantId={tenantId} />}

      {tab === 'staff' && data && <StaffPanel tenantId={tenantId} staff={data.staff} reload={reload} />}

      {tab === 'timers' && (
        <Table
          rows={timers?.items}
          empty="No open timers."
          cols={[
            { h: 'Stage', c: (t) => `${t.rule.stage} · ${t.rule.name}` },
            { h: 'Document', c: (t) => `${t.doctype} ${t.docName}` },
            { h: 'Customer', c: (t) => t.customerName ?? '—' },
            { h: 'Owner', c: (t) => t.owner?.name ?? '—' },
            { h: 'Anchor', c: (t) => new Date(t.anchorAt).toLocaleString() },
            { h: 'Sent', c: (t) => (t.sentLevels.length ? t.sentLevels.map((n) => `L${n}`).join(' ') : '—') },
          ]}
        />
      )}

      {tab === 'setup' && data && (
        <div className="grid min-w-0 grid-cols-1 gap-4 text-sm [&_code]:break-all [&>*]:min-w-0">
          <SettingsPanel key={tenantId} tenantId={tenantId} settings={data.settings} reload={reload} />
          <section className="rounded-xl border border-line bg-card p-4">
            <h2 className="mb-1 font-semibold">Leadvyne lead webhook</h2>
            <p className="mb-2 text-muted">
              POST URL: <code>{data.leadWebhook.url}</code>. Signed with header <code>X-Leadvyne-Signature: sha256=&lt;hmac hex of body&gt;</code>, or add{' '}
              <code>?token=&lt;secret&gt;</code> if Leadvyne cannot sign.
            </p>
            <Button variant="secondary" onClick={() => void rotate()}>{data.leadWebhook.configured ? 'Rotate secret' : 'Generate secret'}</Button>
            {secret && <p className="mt-2">Copy now — it is shown once: <code className="break-all">{secret}</code></p>}
          </section>
          <section className="rounded-xl border border-line bg-card p-4">
            <h2 className="mb-1 font-semibold">ERPNext webhooks</h2>
            <p className="text-muted">
              URL <code>{data.erpWebhookUrl}</code> for Lead, Opportunity, Event, Quotation, Sales Order, Sales Invoice, Payment Entry, Project, Task, Issue and Subscription
              (after_insert, on_update, on_submit, on_cancel) with body <code>{'{"doctype":"{{ doc.doctype }}","name":"{{ doc.name }}","event":"<event>","modified":"{{ doc.modified }}"}'}</code>.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
