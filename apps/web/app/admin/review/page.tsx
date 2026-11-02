'use client';

import Link from 'next/link';
import { H1, Table } from '@/components/admin/table';
import { Badge } from '@/components/ui/card';
import { adminApi } from '@/lib/api';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { TYPE_LABEL, type DraftDto } from '@/lib/drafts';

type Item = DraftDto & { tenantId: string; tenant: { name: string; currency: string } };

export default function ReviewQueue() {
  const { data } = useApi<{ items: Item[] }>('/admin/v1/review-queue', adminApi);
  return (
    <div>
      <H1>Review queue</H1>
      <Table
        rows={data?.items}
        empty="Queue is empty 🎉"
        cols={[
          { h: 'Tenant', c: (d) => d.tenant.name },
          { h: 'Type', c: (d) => <Link className="font-medium text-brand" href={`/admin/review/${d.id}`}>{TYPE_LABEL[d.type]}</Link> },
          { h: 'Party', c: (d) => d.payload.partyName ?? '—' },
          { h: 'Total', c: (d) => money(d.payload.total, d.payload.currency), className: 'text-end tabular-nums' },
          { h: 'Confidence', c: (d) => (d.confidence != null ? `${Math.round(d.confidence * 100)}%` : '—') },
          { h: 'Status', c: (d) => <Badge tone="red">{d.status}</Badge> },
          { h: 'Issues', c: (d) => <span className="text-xs">{[...d.payload.validationIssues, d.error].filter(Boolean).join('; ')}</span> },
          { h: 'Age', c: (d) => `${Math.round((Date.now() - Date.parse(d.createdAt)) / 60000)} min` },
        ]}
      />
    </div>
  );
}
