'use client';

import { Eye } from 'lucide-react';
import { useParams } from 'next/navigation';
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
  settings: Record<string, unknown> & { provisioning?: Record<string, { status: string; note?: string; at: string }> };
  users: Array<{ id: string; name: string; phone: string; role: string; status: string; lastLoginAt: string | null }>;
  usageCounters: Array<{ period: string; messages: number; ocrPages: number; invoicesSent: number; aiCostMicros: number }>;
  connections: { erpnext: { configured: boolean; siteUrl: string | null; health: { ok: boolean; latencyMs: number; at: string } | null }; chatwoot: { configured: boolean; inboxId: number | null }; erpWebhook: { configured: boolean } };
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
        <Stat label="OCR pages" value={`${usage?.ocrPages ?? 0} / ${t.limits.ocrPagesPerMonth}`} sub={usage?.period} />
        <Stat label="Invoices sent" value={`${usage?.invoicesSent ?? 0} / ${t.limits.invoicesSentPerMonth}`} />
        <Stat label="AI cost" value={`$${((usage?.aiCostMicros ?? 0) / 1e6).toFixed(2)}`} sub={`${usage?.messages ?? 0} messages`} />
      </div>
      <section className="grid gap-3 md:grid-cols-3">
        <Conn name="ERPNext" ok={t.connections.erpnext.configured && (t.connections.erpnext.health?.ok ?? null)} detail={`${t.connections.erpnext.siteUrl ?? 'not set'}${t.connections.erpnext.health ? ` · ${t.connections.erpnext.health.latencyMs} ms` : ''}`} />
        <Conn name="Chatwoot" ok={t.connections.chatwoot.configured} detail={t.connections.chatwoot.inboxId ? `Inbox ${t.connections.chatwoot.inboxId}` : 'not mapped'} />
        <Conn name="ERPNext webhooks" ok={t.connections.erpWebhook.configured} detail={t.connections.erpWebhook.configured ? 'Secret set' : 'Not configured'} />
      </section>
      {t.settings.provisioning && (
        <section>
          <h2 className="mb-2 font-semibold">Provisioning</h2>
          <Table rows={Object.entries(t.settings.provisioning)} cols={[{ h: 'Step', c: ([k]) => k }, { h: 'Status', c: ([, v]) => <Badge tone={v.status === 'done' ? 'green' : v.status === 'manual' ? 'amber' : 'red'}>{v.status}</Badge> }, { h: 'Note', c: ([, v]) => <span className="text-xs">{v.note}</span> }]} />
        </section>
      )}
      <section>
        <h2 className="mb-2 font-semibold">Users</h2>
        <Table rows={t.users} cols={[{ h: 'Name', c: (u) => u.name }, { h: 'Phone', c: (u) => u.phone }, { h: 'Role', c: (u) => u.role }, { h: 'Status', c: (u) => u.status }, { h: 'Last login', c: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—') }]} />
      </section>
      <section>
        <h2 className="mb-2 font-semibold">Settings</h2>
        <pre className="overflow-x-auto rounded-xl border border-line bg-card p-3 text-xs">{JSON.stringify({ ...t.settings, provisioning: undefined }, null, 2)}</pre>
      </section>
    </div>
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
