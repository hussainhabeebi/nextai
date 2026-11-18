'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Page } from '@/components/page';
import { Card, Empty, Skeleton } from '@/components/ui/card';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

type Entry = { posting_date: string; account: string; voucher_type: string; voucher_no: string; party?: string | null; amount: number; remarks?: string };

function Entries() {
  const q = useSearchParams();
  const title = q.get('title') ?? 'Entries';
  const params = new URLSearchParams();
  for (const k of ['account', 'party', 'from', 'to']) {
    const v = q.get(k);
    if (v) params.set(k, v);
  }
  const { data, loading, error } = useApi<{ items: Entry[] }>(`/v1/analytics/entries?${params.toString()}`);
  const cur = q.get('cur') ?? undefined;
  const items = data?.items ?? [];
  const net = items.reduce((s, e) => s + e.amount, 0);
  return (
    <Page title={title} back="/insights">
      <p className="mb-3 text-xs text-muted">
        {q.get('from')} → {q.get('to')} · every line in your ERPNext books{q.get('party') ? ` for ${q.get('party')}` : ''}, newest first
      </p>
      {loading && <Skeleton className="h-64" />}
      {error && <Card className="text-sm text-red-600">Couldn't load entries: {error.message}</Card>}
      {!loading && !error && items.length === 0 && <Empty>No entries in this period.</Empty>}
      {items.length > 0 && (
        <Card className="divide-y divide-line p-0">
          <div className="flex justify-between px-4 py-3 text-sm font-medium">
            <span>{items.length} entr{items.length === 1 ? 'y' : 'ies'}</span>
            <span className="tabular-nums">Net {money(Math.abs(net), cur)} {net >= 0 ? 'Dr' : 'Cr'}</span>
          </div>
          {items.map((e, i) => (
            <div key={`${e.voucher_no}-${i}`} className="flex gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{e.party || e.remarks?.split('\n')[0] || e.voucher_type}</p>
                <p className="truncate text-xs text-muted">
                  {e.posting_date} · {e.voucher_type} {e.voucher_no}
                  {q.get('party') ? ` · ${e.account}` : ''}
                </p>
              </div>
              <span className="shrink-0 text-sm tabular-nums">
                {money(Math.abs(e.amount), cur)} <span className="text-xs text-muted">{e.amount >= 0 ? 'Dr' : 'Cr'}</span>
              </span>
            </div>
          ))}
        </Card>
      )}
    </Page>
  );
}

export default function EntriesPage() {
  return (
    <Suspense fallback={<Skeleton className="m-4 h-64" />}>
      <Entries />
    </Suspense>
  );
}
