'use client';

import { Check, ExternalLink } from 'lucide-react';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Badge, Card, Skeleton } from '@/components/ui/card';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Billing {
  status: string;
  plan: { code: string; name: string } | null;
  currency: string;
  trialEndsAt: string | null;
  subscription: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  usage: { users: number; ocrPages: number; invoicesSent: number; messages: number };
  limits: { users: number; ocrPagesPerMonth: number; invoicesSentPerMonth: number; messagesPerMonth: number };
  plans: Array<{ code: string; name: string; price: number; features: string[]; limits: Billing['limits'] }>;
}

export default function BillingPage() {
  const { data: b } = useApi<Billing>('/v1/billing');
  const go = async (path: string, body?: unknown) => {
    const r = await api.post<{ url: string }>(path, body);
    window.location.href = r.url;
  };
  if (!b) return <Page title="Billing" back="/more"><Skeleton className="h-96" /></Page>;
  const bars: Array<[string, number, number]> = [
    ['Bills read (OCR pages)', b.usage.ocrPages, b.limits.ocrPagesPerMonth],
    ['Invoices sent', b.usage.invoicesSent, b.limits.invoicesSentPerMonth],
    ['Team members', b.usage.users, b.limits.users],
  ];
  return (
    <Page title="Billing" back="/more">
      <Card className="mb-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-lg font-semibold">{b.plan?.name ?? 'No plan'}</span>
          <Badge tone={b.status === 'active' ? 'green' : b.status === 'trial' ? 'amber' : 'red'}>{b.status.replace('_', ' ')}</Badge>
        </div>
        {b.status === 'trial' && b.trialEndsAt && <p className="text-sm text-muted">Trial ends {new Date(b.trialEndsAt).toLocaleDateString()}</p>}
        {b.subscription?.currentPeriodEnd && <p className="text-sm text-muted">{b.subscription.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {new Date(b.subscription.currentPeriodEnd).toLocaleDateString()}</p>}
        {bars.map(([label, used, limit]) => (
          <div key={label}>
            <div className="flex justify-between text-xs"><span>{label}</span><span className="tabular-nums">{used} / {limit}</span></div>
            <div className="mt-1 h-2 rounded-full bg-line"><div className={`h-2 rounded-full ${used / limit > 0.9 ? 'bg-red-500' : 'bg-brand'}`} style={{ width: `${Math.min(100, (used / Math.max(1, limit)) * 100)}%` }} /></div>
          </div>
        ))}
        {b.subscription && (
          <Button variant="secondary" className="w-full" onClick={() => void go('/v1/billing/portal')}>
            <ExternalLink className="h-4 w-4" /> Manage card & invoices
          </Button>
        )}
      </Card>
      <div className="space-y-3">
        {b.plans.map((p) => (
          <Card key={p.code} className={p.code === b.plan?.code ? 'border-brand' : ''}>
            <div className="flex items-baseline justify-between">
              <h3 className="font-semibold">{p.name}</h3>
              <span className="text-lg font-bold">{money(p.price, b.currency)}<span className="text-xs font-normal text-muted">/mo</span></span>
            </div>
            <ul className="mt-2 space-y-1 text-sm text-muted">
              <li><Check className="me-1 inline h-4 w-4 text-brand" />{p.limits.ocrPagesPerMonth} bills/month · {p.limits.users} users</li>
              <li><Check className="me-1 inline h-4 w-4 text-brand" />{p.limits.invoicesSentPerMonth} WhatsApp invoices/month</li>
              {p.features.map((f) => <li key={f}><Check className="me-1 inline h-4 w-4 text-brand" />{f.replace('_', ' ')}</li>)}
            </ul>
            {p.code !== b.plan?.code || !b.subscription ? (
              <Button className="mt-3 w-full" variant={p.code === 'growth' ? 'amber' : 'primary'} onClick={() => void go('/v1/billing/checkout', { plan: p.code })}>
                {b.subscription ? 'Switch' : 'Choose'} {p.name}
              </Button>
            ) : null}
          </Card>
        ))}
      </div>
    </Page>
  );
}
