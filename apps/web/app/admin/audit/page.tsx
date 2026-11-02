'use client';

import { useState } from 'react';
import { H1, Table } from '@/components/admin/table';
import { Input } from '@/components/ui/input';
import { adminApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';

type A = { id: string; createdAt: string; tenantId: string | null; actorType: string; actorId: string | null; channel: string; action: string; entity: string; entityId: string | null; before: unknown; after: unknown; ip: string | null };

export default function Audit() {
  const [f, setF] = useState({ tenantId: '', action: '', actorId: '', from: '', to: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data } = useApi<{ items: A[] }>(`/admin/v1/audit${qs ? `?${qs}` : ''}`, adminApi);
  return (
    <div>
      <H1>Audit log</H1>
      <div className="mb-4 grid gap-2 sm:grid-cols-5">
        <Input placeholder="Tenant ID" value={f.tenantId} onChange={(e) => setF({ ...f, tenantId: e.target.value })} />
        <Input placeholder="Action prefix (e.g. draft.)" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} />
        <Input placeholder="Actor ID" value={f.actorId} onChange={(e) => setF({ ...f, actorId: e.target.value })} />
        <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
      </div>
      <Table
        rows={data?.items}
        cols={[
          { h: 'When', c: (a) => new Date(a.createdAt).toLocaleString(), className: 'whitespace-nowrap' },
          { h: 'Action', c: (a) => <code className="text-xs">{a.action}</code> },
          { h: 'Actor', c: (a) => `${a.actorType}${a.actorId ? ` ${a.actorId.slice(0, 8)}` : ''}` },
          { h: 'Channel', c: (a) => a.channel },
          { h: 'Entity', c: (a) => `${a.entity}${a.entityId ? ` ${a.entityId.slice(0, 12)}` : ''}` },
          { h: 'Tenant', c: (a) => a.tenantId?.slice(0, 8) ?? '—' },
          {
            h: 'Change',
            c: (a) =>
              a.before || a.after ? (
                <details className="max-w-md text-xs">
                  <summary className="cursor-pointer text-brand">diff</summary>
                  <pre className="overflow-x-auto">{JSON.stringify({ before: a.before, after: a.after }, null, 2)}</pre>
                </details>
              ) : null,
          },
        ]}
      />
    </div>
  );
}
