'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Page } from '@/components/page';
import { Badge, Card, Empty, Skeleton } from '@/components/ui/card';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { TYPE_LABEL, statusTone, type DraftDto } from '@/lib/drafts';

export default function Approvals() {
  const { t } = useI18n();
  const { data, loading, reload } = useApi<{ items: DraftDto[] }>('/v1/drafts');
  return (
    <Page title={t('approvals.title')} onRefresh={reload}>
      {loading && !data && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="mb-3 h-20 w-full" />)}
      {data?.items.length === 0 && <Empty>{t('approvals.empty')}</Empty>}
      <ul className="space-y-3">
        {data?.items.map((d) => (
          <li key={d.id}>
            <Link href={`/approvals/${d.id}`}>
              <Card className="flex items-center gap-3 active:scale-[0.99]">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{TYPE_LABEL[d.type]}</span>
                    <Badge tone={statusTone(d.status)}>{d.status.replace('_', ' ')}</Badge>
                  </div>
                  <p className="truncate text-sm text-muted">{d.payload.partyName ?? d.payload.remarks ?? '—'} · {d.payload.date}</p>
                </div>
                <span className="font-bold tabular-nums">{money(d.payload.total, d.payload.currency)}</span>
                <ChevronRight className="h-5 w-5 text-muted rtl:rotate-180" />
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
