'use client';

import { ChevronRight, Search } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Page } from '@/components/page';
import { Card, Empty, Skeleton } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

function Parties() {
  const sp = useSearchParams();
  const { me } = useAuth();
  const [kind, setKind] = useState<'customer' | 'supplier'>((sp.get('kind') as 'customer' | 'supplier') ?? 'customer');
  const [q, setQ] = useState('');
  const { data, loading, reload } = useApi<{ items: Array<{ id: string; name: string; phone: string | null; balance: number }> }>(`/v1/parties?kind=${kind}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  return (
    <Page title="Customers & suppliers" back="/more" onRefresh={reload}>
      <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-card p-1">
        {(['customer', 'supplier'] as const).map((k) => (
          <button key={k} onClick={() => setKind(k)} className={cn('min-h-11 rounded-lg text-sm font-medium capitalize', kind === k ? 'bg-brand text-white' : 'text-muted')}>
            {k}s
          </button>
        ))}
      </div>
      <div className="relative mb-4">
        <Search className="absolute start-3 top-3.5 h-5 w-5 text-muted" />
        <Input className="ps-10" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {loading && !data && <Skeleton className="h-40" />}
      {data?.items.length === 0 && <Empty>No {kind}s yet.</Empty>}
      <Card className="divide-y divide-line p-0">
        {data?.items.map((p) => (
          <Link key={p.id} href={`/parties/${encodeURIComponent(p.id)}?kind=${kind}`} className="flex min-h-14 items-center gap-3 px-4">
            <span className="flex-1 truncate">{p.name}</span>
            <span className={cn('tabular-nums', p.balance > 0 && 'font-semibold')}>{money(p.balance, me?.tenant.currency)}</span>
            <ChevronRight className="h-4 w-4 text-muted rtl:rotate-180" />
          </Link>
        ))}
      </Card>
    </Page>
  );
}

export default function PartiesPage() {
  return (
    <Suspense>
      <Parties />
    </Suspense>
  );
}
