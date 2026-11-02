'use client';

import { useState } from 'react';
import { H1, Table } from '@/components/admin/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { adminApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useAdmin } from '@/lib/admin-auth';

type Plan = { id: string; code: string; name: string; priceMonthly: Record<string, number>; limits: Record<string, unknown>; providerPriceIds: Record<string, Record<string, string>> };
type Sub = { id: string; provider: string; providerSubscriptionId: string | null; providerCustomerId: string; status: string; planCode: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; tenant: { name: string; status: string } };

export default function Plans() {
  const { role } = useAdmin();
  const plans = useApi<{ items: Plan[] }>('/admin/v1/plans', adminApi);
  const subs = useApi<{ items: Sub[] }>('/admin/v1/subscriptions', adminApi);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const save = async (p: Plan) => {
    await adminApi.patch(`/admin/v1/plans/${p.code}`, JSON.parse(edit[p.code]!));
    setEdit({ ...edit, [p.code]: '' });
    await plans.reload();
  };
  return (
    <div className="space-y-8">
      <section>
        <H1>Plans</H1>
        <div className="grid gap-3 lg:grid-cols-3">
          {plans.data?.items.map((p) => (
            <div key={p.code} className="space-y-2 rounded-xl border border-line bg-card p-4 text-sm">
              <p className="text-lg font-semibold">{p.name}</p>
              {edit[p.code] ? (
                <>
                  <textarea className="h-48 w-full rounded-lg border border-line bg-bg p-2 font-mono text-xs" value={edit[p.code]} onChange={(e) => setEdit({ ...edit, [p.code]: e.target.value })} />
                  <Button onClick={() => void save(p)}>Save</Button>
                </>
              ) : (
                <>
                  <pre className="overflow-x-auto text-xs">{JSON.stringify({ priceMonthly: p.priceMonthly, limits: p.limits, providerPriceIds: p.providerPriceIds }, null, 2)}</pre>
                  {role === 'super_admin' && <Button variant="secondary" onClick={() => setEdit({ ...edit, [p.code]: JSON.stringify({ priceMonthly: p.priceMonthly, limits: p.limits, providerPriceIds: p.providerPriceIds }, null, 2) })}>Edit</Button>}
                </>
              )}
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-xl font-bold">Subscriptions</h2>
        <Table
          rows={subs.data?.items}
          cols={[
            { h: 'Tenant', c: (s) => s.tenant.name },
            { h: 'Plan', c: (s) => s.planCode ?? '—' },
            { h: 'Status', c: (s) => <Badge tone={s.status === 'active' ? 'green' : s.status === 'trialing' ? 'amber' : 'red'}>{s.status}</Badge> },
            { h: 'Period end', c: (s) => (s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : '—') },
            { h: 'Cancels', c: (s) => (s.cancelAtPeriodEnd ? 'yes' : '') },
            { h: 'Stripe', c: (s) => (s.providerSubscriptionId ? <a className="text-brand underline" target="_blank" rel="noreferrer" href={`https://dashboard.stripe.com/subscriptions/${s.providerSubscriptionId}`}>open</a> : '—') },
          ]}
        />
      </section>
    </div>
  );
}
