'use client';

import { H1, Table } from '@/components/admin/table';
import { Button } from '@/components/ui/button';
import { adminApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';

type C = { ok: boolean | null; latencyMs?: number; error?: string };
type H = { postgres: C; redis: C; r2: C; chatwoot: C; erpnext: Array<C & { tenantId: string; name: string; siteUrl: string | null; at?: string }> };

const Dot = ({ ok }: { ok: boolean | null }) => <span className={`inline-block h-2.5 w-2.5 rounded-full ${ok === null ? 'bg-line' : ok ? 'bg-emerald-500' : 'bg-red-500'}`} />;

export default function Health() {
  const { data, reload } = useApi<H>('/admin/v1/health', adminApi);
  return (
    <div>
      <H1 action={<Button variant="secondary" onClick={() => void reload()}>Refresh</Button>}>System health</H1>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data &&
          (['postgres', 'redis', 'r2', 'chatwoot'] as const).map((k) => (
            <div key={k} className="rounded-xl border border-line bg-card p-4">
              <div className="flex items-center justify-between"><span className="font-medium capitalize">{k}</span><Dot ok={data[k].ok} /></div>
              <p className="mt-1 text-xs text-muted">{data[k].ok ? `${data[k].latencyMs} ms` : data[k].error}</p>
            </div>
          ))}
      </div>
      <h2 className="mb-2 font-semibold">ERPNext sites (health.erpnext every 5 min)</h2>
      <Table
        rows={data?.erpnext}
        cols={[
          { h: '', c: (r) => <Dot ok={r.ok} /> },
          { h: 'Tenant', c: (r) => r.name },
          { h: 'Site', c: (r) => r.siteUrl ?? '—' },
          { h: 'Latency', c: (r) => (r.latencyMs != null ? `${r.latencyMs} ms` : '—') },
          { h: 'Checked', c: (r) => (r.at ? new Date(r.at).toLocaleTimeString() : 'never') },
        ]}
      />
    </div>
  );
}
