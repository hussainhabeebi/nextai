'use client';

import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { H1 } from '@/components/admin/table';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { adminApi, ApiError } from '@/lib/api';

const STEPS: Array<{ key: string; label: string }> = [
  { key: 'erp_site', label: 'Create ERPNext site (bench new-site + apps + scheduler)' },
  { key: 'erp_api_user', label: 'Create nextai-bot user + API keys' },
  { key: 'erp_company', label: 'Company, country, currency, chart of accounts, tax templates' },
  { key: 'tunnel_hostname', label: 'Cloudflare Tunnel hostname' },
  { key: 'chatwoot_inbox', label: 'Chatwoot inbox + Agent Bot mapping' },
  { key: 'erp_webhooks', label: 'ERPNext webhooks (signed)' },
  { key: 'test_connections', label: 'Test connections' },
  { key: 'invite_owner', label: 'Invite owner on WhatsApp' },
];
type StepState = { status: 'idle' | 'running' | 'done' | 'manual' | 'failed'; note?: string };

export default function Provision() {
  const [form, setForm] = useState({ name: '', slug: '', country: 'IN', currency: 'INR', language: 'en', planCode: 'starter', ownerName: '', ownerPhone: '', ownerEmail: '' });
  const [cw, setCw] = useState({ accountId: '', inboxId: '', botToken: '' });
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [err, setErr] = useState('');

  const create = async () => {
    setErr('');
    try {
      const r = await adminApi.post<{ tenantId: string }>('/admin/v1/provision', { ...form, ownerEmail: form.ownerEmail || undefined });
      setTenantId(r.tenantId);
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };
  const run = async (key: string) => {
    setSteps((s) => ({ ...s, [key]: { status: 'running' } }));
    try {
      const body = key === 'chatwoot_inbox' ? { chatwoot: { accountId: Number(cw.accountId), inboxId: Number(cw.inboxId), botToken: cw.botToken } } : {};
      const r = await adminApi.post<{ status: 'done' | 'manual'; note: string }>(`/admin/v1/provision/${tenantId}/steps/${key}`, body);
      setSteps((s) => ({ ...s, [key]: { status: r.status, note: r.note } }));
      return true;
    } catch (e) {
      setSteps((s) => ({ ...s, [key]: { status: 'failed', note: (e as ApiError).message } }));
      return false;
    }
  };
  const runAll = async () => {
    for (const s of STEPS) if (!['done', 'manual'].includes(steps[s.key]?.status ?? '') && !(await run(s.key))) break;
  };
  const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }) });

  return (
    <div className="max-w-3xl">
      <H1>Provision a tenant</H1>
      {!tenantId ? (
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => (e.preventDefault(), void create())}>
          <Field label="Business name"><Input {...f('name')} required /></Field>
          <Field label="Slug (subdomain)" hint={`${form.slug || 'slug'}.nextaierp.com`}><Input {...f('slug')} pattern="[a-z0-9-]{2,40}" required /></Field>
          <Field label="Country">
            <Select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value, currency: e.target.value === 'IN' ? 'INR' : 'AED' })}>
              <option value="IN">India (GST)</option>
              <option value="AE">UAE (VAT / CT)</option>
            </Select>
          </Field>
          <Field label="Currency"><Input {...f('currency')} /></Field>
          <Field label="Language"><Select {...f('language')}><option value="en">English</option><option value="ml">Malayalam</option><option value="ar">Arabic</option></Select></Field>
          <Field label="Plan"><Select {...f('planCode')}><option value="starter">Starter</option><option value="business">Business</option><option value="pro">Pro</option></Select></Field>
          <Field label="Owner name"><Input {...f('ownerName')} required /></Field>
          <Field label="Owner WhatsApp"><Input {...f('ownerPhone')} required /></Field>
          <Field label="Owner email (optional)"><Input type="email" {...f('ownerEmail')} /></Field>
          <div className="sm:col-span-2"><Button size="lg">Create tenant</Button></div>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 rounded-xl border border-line bg-card p-4 sm:grid-cols-3">
            <p className="text-sm font-medium sm:col-span-3">Chatwoot mapping (create the WhatsApp inbox + Agent Bot in Chatwoot first)</p>
            <Input placeholder="Account ID" value={cw.accountId} onChange={(e) => setCw({ ...cw, accountId: e.target.value })} />
            <Input placeholder="Inbox ID" value={cw.inboxId} onChange={(e) => setCw({ ...cw, inboxId: e.target.value })} />
            <Input placeholder="Agent Bot token" type="password" value={cw.botToken} onChange={(e) => setCw({ ...cw, botToken: e.target.value })} />
          </div>
          <ol className="divide-y divide-line rounded-xl border border-line bg-card">
            {STEPS.map((s) => {
              const st = steps[s.key]?.status ?? 'idle';
              const Icon = st === 'done' ? CheckCircle2 : st === 'failed' ? XCircle : st === 'running' ? Loader2 : Circle;
              return (
                <li key={s.key} className="flex items-start gap-3 p-3">
                  <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${st === 'done' ? 'text-emerald-600' : st === 'failed' ? 'text-red-600' : st === 'manual' ? 'text-amber-500' : 'text-muted'} ${st === 'running' ? 'animate-spin' : ''}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{s.label}</p>
                    {steps[s.key]?.note && <p className="break-all text-xs text-muted">{steps[s.key]!.note}</p>}
                  </div>
                  <Button variant="secondary" disabled={st === 'running'} onClick={() => void run(s.key)}>{st === 'idle' ? 'Run' : 'Retry'}</Button>
                </li>
              );
            })}
          </ol>
          <Button size="lg" onClick={() => void runAll()}>Run remaining steps</Button>
        </div>
      )}
      {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
    </div>
  );
}
