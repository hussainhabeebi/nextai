'use client';

import { useState } from 'react';
import { H1, Table } from '@/components/admin/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';

type F = { id: string; key: string; tenantId: string | null; enabled: boolean };

export default function Flags() {
  const { data, reload } = useApi<{ items: F[] }>('/admin/v1/flags', adminApi);
  const [f, setF] = useState({ key: 'feature:tax_centre', tenantId: '' });
  const set = async (key: string, tenantId: string | null, enabled: boolean) => {
    await adminApi.request('/admin/v1/flags', { method: 'PUT', json: { key, tenantId, enabled } });
    await reload();
  };
  return (
    <div>
      <H1>Feature flags</H1>
      <form className="mb-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => (e.preventDefault(), void set(f.key, f.tenantId || null, true))}>
        <Input value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} placeholder="feature:payroll" />
        <Input value={f.tenantId} onChange={(e) => setF({ ...f, tenantId: e.target.value })} placeholder="Tenant ID (empty = global)" />
        <Button>Enable</Button>
      </form>
      <Table
        rows={data?.items}
        cols={[
          { h: 'Key', c: (x) => <code>{x.key}</code> },
          { h: 'Scope', c: (x) => x.tenantId ?? 'global' },
          { h: 'Enabled', c: (x) => <input type="checkbox" className="h-5 w-5" checked={x.enabled} onChange={(e) => void set(x.key, x.tenantId, e.target.checked)} /> },
        ]}
      />
    </div>
  );
}
