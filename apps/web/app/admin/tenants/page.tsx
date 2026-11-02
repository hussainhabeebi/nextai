'use client';

import Link from 'next/link';
import { useState } from 'react';
import { H1, Table } from '@/components/admin/table';
import { Badge } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { adminApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';

type T = { id: string; name: string; slug: string; country: string; status: string; plan: string | null; users: number; createdAt: string };
const tone = (s: string) => (s === 'active' ? 'green' : s === 'trial' ? 'amber' : 'red') as 'green' | 'amber' | 'red';

export default function Tenants() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const { data } = useApi<{ items: T[] }>(`/admin/v1/tenants?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) })}`, adminApi);
  return (
    <div>
      <H1 action={<Link href="/admin/provision" className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white">New tenant</Link>}>Tenants</H1>
      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_200px]">
        <Input placeholder="Search name or slug" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['trial', 'active', 'past_due', 'suspended'].map((s) => <option key={s}>{s}</option>)}
        </Select>
      </div>
      <Table
        rows={data?.items}
        cols={[
          { h: 'Name', c: (t) => <Link className="font-medium text-brand" href={`/admin/tenants/${t.id}`}>{t.name}</Link> },
          { h: 'Slug', c: (t) => t.slug },
          { h: 'Country', c: (t) => t.country },
          { h: 'Plan', c: (t) => t.plan ?? '—' },
          { h: 'Users', c: (t) => t.users },
          { h: 'Status', c: (t) => <Badge tone={tone(t.status)}>{t.status}</Badge> },
          { h: 'Created', c: (t) => new Date(t.createdAt).toLocaleDateString() },
        ]}
      />
    </div>
  );
}
