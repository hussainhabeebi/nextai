'use client';

import { BellRing } from 'lucide-react';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card, Empty, Skeleton } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

type Row = { posting_date?: string; voucher_no?: string; voucher_type?: string; debit?: number; credit?: number; balance?: number };

function Party() {
  const { id } = useParams<{ id: string }>();
  const name = decodeURIComponent(id);
  const kind = useSearchParams().get('kind') ?? 'customer';
  const { me } = useAuth();
  const { data, loading } = useApi<{ result: Row[] }>(`/v1/parties/${encodeURIComponent(name)}/statement?kind=${kind}`);
  const [sent, setSent] = useState(false);
  const rows = (data?.result ?? []).filter((r) => r && r.voucher_no);
  return (
    <Page title={name} back={`/parties?kind=${kind}`}>
      {kind === 'customer' && (
        <Button size="lg" variant="amber" className="mb-4" disabled={sent} onClick={() => void api.post(`/v1/parties/${encodeURIComponent(name)}/remind`).then(() => setSent(true))}>
          <BellRing className="h-5 w-5" /> {sent ? 'Reminder queued' : 'Send payment reminder'}
        </Button>
      )}
      <h2 className="mb-2 text-sm font-semibold text-muted">Statement</h2>
      {loading && <Skeleton className="h-48" />}
      {!loading && rows.length === 0 && <Empty>No transactions.</Empty>}
      <Card className="divide-y divide-line p-0 text-sm">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-2 px-4 py-3">
            <div>
              <p>{r.voucher_type} {r.voucher_no}</p>
              <p className="text-xs text-muted">{r.posting_date}</p>
            </div>
            <div className="text-end tabular-nums">
              <p>{r.debit ? `+${money(r.debit, me?.tenant.currency)}` : `−${money(r.credit, me?.tenant.currency)}`}</p>
              <p className="text-xs text-muted">{money(r.balance, me?.tenant.currency)}</p>
            </div>
          </div>
        ))}
      </Card>
    </Page>
  );
}

export default function PartyPage() {
  return (
    <Suspense>
      <Party />
    </Suspense>
  );
}
