'use client';

import Link from 'next/link';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card, Empty, Skeleton } from '@/components/ui/card';
import type { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

export default function Tax() {
  const { me } = useAuth();
  const { data, error, loading } = useApi<{ regime: string; periods: Array<{ period: string; output: number; input: number; net: number }>; dueDates: Array<{ name: string; day: number }> }>('/v1/tax');
  const cur = me?.tenant.currency;
  const isIn = me?.tenant.country === 'IN';
  if ((error as ApiError | undefined)?.status === 402)
    return (
      <Page title="Tax centre" back="/more">
        <Card className="space-y-3 text-center">
          <p>The tax centre is part of the Business and Pro plans.</p>
          <Link href="/billing"><Button>Upgrade</Button></Link>
        </Card>
      </Page>
    );
  return (
    <Page title="Tax centre" back="/more">
      <Card className="mb-4">
        <p className="text-sm text-muted">{isIn ? 'GST' : 'VAT & Corporate Tax'} · upcoming due dates</p>
        <ul className="mt-2 space-y-1 text-sm">
          {data?.dueDates.map((d) => (
            <li key={d.name} className="flex justify-between">
              <span>{d.name}</span>
              <span className="text-muted">{d.day ? `${d.day}th of next ${d.name.includes('quarter') ? 'quarter-month' : 'month'}` : '9 months after FY end'}</span>
            </li>
          ))}
        </ul>
      </Card>
      {loading && <Skeleton className="h-40" />}
      {data?.periods.length === 0 && <Empty>No taxable transactions yet.</Empty>}
      <ul className="space-y-3">
        {data?.periods.map((p) => (
          <li key={p.period}>
            <Card>
              <div className="flex justify-between font-semibold">
                <span>{p.period}</span>
                <span className={p.net > 0 ? 'text-red-600' : 'text-emerald-600'}>{p.net > 0 ? 'Payable' : 'Credit'} {money(Math.abs(p.net), cur)}</span>
              </div>
              <div className="mt-1 flex justify-between text-sm text-muted">
                <span>Output {money(p.output, cur)}</span>
                <span>Input {money(p.input, cur)}</span>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-muted">Filing status and returns are prepared by your NextAi accountant{isIn ? ' via India Compliance' : ''}.</p>
    </Page>
  );
}
