'use client';

import Link from 'next/link';
import { Page } from '@/components/page';
import { Badge, Card, Empty, Skeleton } from '@/components/ui/card';
import { TYPE_LABEL, statusTone, type DraftDto } from '@/lib/drafts';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

export default function Purchases() {
  const { data, loading, reload } = useApi<{ items: DraftDto[] }>('/v1/drafts?status=posted&limit=50');
  const items = data?.items.filter((d) => d.type === 'purchase_invoice' || d.type === 'journal_entry');
  return (
    <Page title="Purchases & expenses" back="/more" onRefresh={reload}>
      {loading && !data && <Skeleton className="h-40" />}
      {items?.length === 0 && <Empty>No purchases recorded yet. Send a bill on WhatsApp or use Capture.</Empty>}
      <ul className="space-y-3">
        {items?.map((d) => (
          <li key={d.id}>
            <Link href={`/approvals/${d.id}`}>
              <Card className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{d.payload.partyName ?? d.payload.remarks}</p>
                  <p className="text-xs text-muted">{TYPE_LABEL[d.type]} · {d.payload.date} · {d.erpName}</p>
                </div>
                <div className="text-end">
                  <p className="font-bold tabular-nums">{money(d.payload.total, d.payload.currency)}</p>
                  <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
