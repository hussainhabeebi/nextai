'use client';

import { AlertTriangle, CalendarClock, ChevronRight, Landmark } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Page } from '@/components/page';
import { Badge, Card, Empty, Skeleton } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { cn } from '@/lib/cn';

type Business = {
  tenantId: string;
  name: string;
  role: string | null;
  country: 'IN' | 'AE';
  status: string;
  needsReview: number;
  pending: number;
  failed: number;
  bankToCheck: number;
  overdue: { count: number; text: string } | null;
  nextDeadline: { what: string; due: string; daysLeft: number } | null;
  lastActivity: string | null;
  current: boolean;
};
type QueueItem = { tenantId: string; business: string; draftId: string; type: string; status: string; party: string | null; total: string; date: string; error: string | null };

const TYPE: Record<string, string> = { purchase_invoice: 'Purchase bill', journal_entry: 'Expense / journal', sales_invoice: 'Sales invoice', payment_in: 'Payment received', payment_out: 'Payment made' };
const when = (n: number) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);

/** Accountant portal: every client business, what needs attention, one review queue across all of them. */
export default function Portal() {
  const router = useRouter();
  const { switchTenant } = useAuth();
  const { data, loading, reload } = useApi<{ businesses: Business[]; queue: QueueItem[] }>('/v1/portal');
  const [tab, setTab] = useState<'businesses' | 'queue'>('businesses');
  const [busy, setBusy] = useState('');

  const open = async (tenantId: string, path: string) => {
    setBusy(tenantId);
    try {
      if (!data?.businesses.find((b) => b.tenantId === tenantId)?.current) await switchTenant(tenantId);
      router.push(path);
    } finally {
      setBusy('');
    }
  };

  return (
    <Page title="All my businesses" back="/more" onRefresh={reload}>
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-card p-1" role="tablist">
        {(['businesses', 'queue'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('min-h-11 rounded-lg text-sm font-medium', tab === k ? 'bg-brand text-white' : 'text-muted')}>
            {k === 'businesses' ? `Businesses${data ? ` (${data.businesses.length})` : ''}` : `To review${data ? ` (${data.queue.length})` : ''}`}
          </button>
        ))}
      </div>
      {loading && !data && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="mb-3 h-28" />)}

      {tab === 'businesses' && (
        <ul className="space-y-3">
          {data?.businesses.map((b) => {
            const todo = b.failed + b.needsReview + b.pending;
            return (
              <li key={b.tenantId}>
                <Card>
                  <button className="w-full text-start" onClick={() => void open(b.tenantId, todo ? '/approvals' : '/')} disabled={busy === b.tenantId} aria-label={`Open ${b.name}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{b.name}</p>
                        <p className="text-xs text-muted">
                          {b.role === 'tenant_accountant' ? 'Accountant' : b.role === 'owner' ? 'Owner' : 'Staff'} · {b.country === 'IN' ? 'India' : 'UAE'}
                          {b.current ? ' · open now' : ''}
                        </p>
                      </div>
                      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted rtl:rotate-180" />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {b.failed > 0 && <Badge tone="red">{b.failed} failed</Badge>}
                      {b.needsReview > 0 && <Badge tone="amber">{b.needsReview} to review</Badge>}
                      {b.pending > 0 && <Badge tone="amber">{b.pending} waiting approval</Badge>}
                      {todo === 0 && <Badge tone="green">Books up to date</Badge>}
                    </div>
                    <div className="mt-3 space-y-1 text-sm">
                      {b.nextDeadline && (
                        <p className={cn('flex items-center gap-2', b.nextDeadline.daysLeft <= 7 && 'font-medium text-red-600')}>
                          <CalendarClock className="h-4 w-4" /> {b.nextDeadline.what}: due {when(b.nextDeadline.daysLeft)}
                        </p>
                      )}
                      {b.bankToCheck > 0 && (
                        <p className="flex items-center gap-2"><Landmark className="h-4 w-4" /> {b.bankToCheck} bank line{b.bankToCheck === 1 ? '' : 's'} to match</p>
                      )}
                      {b.overdue && b.overdue.count > 0 && (
                        <p className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {b.overdue.text} overdue from customers ({b.overdue.count})</p>
                      )}
                    </div>
                  </button>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {tab === 'queue' && (
        <>
          {data?.queue.length === 0 && <Empty>Nothing to review across your businesses. 🎉</Empty>}
          <ul className="space-y-3">
            {data?.queue.map((q) => (
              <li key={q.draftId}>
                <Card>
                  <button className="w-full text-start" onClick={() => void open(q.tenantId, `/approvals/${q.draftId}`)} disabled={busy === q.tenantId}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-muted">{q.business}</p>
                        <p className="truncate font-medium">{TYPE[q.type] ?? q.type}{q.party ? ` · ${q.party}` : ''}</p>
                        <p className="text-xs text-muted">{q.date}</p>
                      </div>
                      <div className="text-end">
                        <p className="font-bold tabular-nums">{q.total}</p>
                        <Badge tone={q.status === 'failed' ? 'red' : 'amber'}>{q.status === 'needs_review' ? 'review' : q.status}</Badge>
                      </div>
                    </div>
                    {q.error && <p className="mt-2 text-xs text-red-600">{q.error}</p>}
                  </button>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </Page>
  );
}
