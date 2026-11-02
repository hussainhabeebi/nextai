'use client';

import { FileText, Plus, Send } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Badge, Card, Empty, Skeleton } from '@/components/ui/card';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';

interface Inv {
  name: string;
  customer?: string;
  party_name?: string;
  posting_date?: string;
  transaction_date?: string;
  grand_total: number;
  outstanding_amount?: number;
  status?: string;
  currency: string;
}
const TABS = [
  { key: 'invoice', label: 'Invoices' },
  { key: 'quotation', label: 'Quotations' },
  { key: 'credit_note', label: 'Credit notes' },
] as const;

export default function Sales() {
  const { t } = useI18n();
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('invoice');
  const { data, loading, reload } = useApi<{ items: Inv[] }>(`/v1/invoices?type=${tab}`);
  const [toast, setToast] = useState('');

  const openPdf = async (name: string) => {
    const res = await api.request<Response>(`/v1/invoices/${encodeURIComponent(name)}/pdf`, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
  };
  const share = async (name: string) => {
    await api.post(`/v1/invoices/${encodeURIComponent(name)}/send`);
    setToast(`Invoice ${name} is being sent on WhatsApp`);
  };

  return (
    <Page
      title={t('nav.sales')}
      onRefresh={reload}
      action={
        <Link href="/sales/new">
          <Button size="md">
            <Plus className="h-4 w-4" /> New
          </Button>
        </Link>
      }
    >
      <div className="mb-4 grid grid-cols-3 gap-1 rounded-xl bg-card p-1" role="tablist">
        {TABS.map((x) => (
          <button key={x.key} role="tab" aria-selected={tab === x.key} onClick={() => setTab(x.key)} className={cn('min-h-11 rounded-lg text-sm font-medium', tab === x.key ? 'bg-brand text-white' : 'text-muted')}>
            {x.label}
          </button>
        ))}
      </div>
      {toast && <p className="mb-3 rounded-xl bg-brand-light p-3 text-sm text-brand-dark">{toast}</p>}
      {loading && !data && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="mb-3 h-20" />)}
      {data?.items.length === 0 && <Empty>No documents yet.</Empty>}
      <ul className="space-y-3">
        {data?.items.map((inv) => (
          <li key={inv.name}>
            <Card>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">{inv.customer ?? inv.party_name}</p>
                  <p className="text-xs text-muted">{inv.name} · {inv.posting_date ?? inv.transaction_date}</p>
                </div>
                <div className="text-end">
                  <p className="font-bold tabular-nums">{money(inv.grand_total, inv.currency)}</p>
                  {inv.status && <Badge tone={inv.status === 'Paid' ? 'green' : inv.status === 'Overdue' ? 'red' : 'amber'}>{inv.status}</Badge>}
                </div>
              </div>
              {tab === 'invoice' && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button variant="secondary" onClick={() => void openPdf(inv.name)}>
                    <FileText className="h-4 w-4" /> PDF
                  </Button>
                  <Button variant="secondary" onClick={() => void share(inv.name)}>
                    <Send className="h-4 w-4" /> WhatsApp
                  </Button>
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </Page>
  );
}
