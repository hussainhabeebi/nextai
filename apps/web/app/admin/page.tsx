'use client';

import { H1, Stat } from '@/components/admin/table';
import { adminApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';

interface D {
  tenants: { active: number; trial: number; pastDue: number; suspended: number };
  mrr: Record<string, number>;
  messagesThisMonth: number;
  ocrPagesThisMonth: number;
  aiCostUsd: number;
  messagesPerDay: Array<{ day: string; cumulative: number }>;
  failedJobs: number;
  reviewQueue: number;
}

export default function AdminDashboard() {
  const { data: d } = useApi<D>('/admin/v1/dashboard', adminApi);
  const perDay = (d?.messagesPerDay ?? []).map((x, i, a) => ({ day: x.day, n: x.cumulative - (a[i - 1]?.cumulative ?? 0) }));
  const max = Math.max(1, ...perDay.map((x) => x.n));
  return (
    <div>
      <H1>Dashboard</H1>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active tenants" value={d?.tenants.active ?? '—'} sub={`${d?.tenants.suspended ?? 0} suspended`} />
        <Stat label="MRR" value={d ? Object.entries(d.mrr).map(([c, v]) => `${c} ${v.toLocaleString()}`).join(' · ') || '0' : '—'} />
        <Stat label="Trials" value={d?.tenants.trial ?? '—'} />
        <Stat label="Past due" value={d?.tenants.pastDue ?? '—'} />
        <Stat label="Messages (month)" value={d?.messagesThisMonth ?? '—'} />
        <Stat label="OCR pages (month)" value={d?.ocrPagesThisMonth ?? '—'} />
        <Stat label="AI cost (month)" value={d ? `$${d.aiCostUsd.toFixed(2)}` : '—'} />
        <Stat label="Failed jobs" value={d?.failedJobs ?? '—'} sub={`${d?.reviewQueue ?? 0} drafts awaiting review`} />
      </div>
      <section className="mt-6 rounded-xl border border-line bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">Messages per day</h2>
        {perDay.length === 0 ? (
          <p className="text-sm text-muted">No data yet (usage.rollup runs hourly).</p>
        ) : (
          <div className="flex h-40 items-end gap-1" role="img" aria-label="Messages per day">
            {perDay.map((x) => (
              <div key={x.day} className="flex-1 rounded-t bg-brand" style={{ height: `${(x.n / max) * 100}%` }} title={`${x.day}: ${x.n}`} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
