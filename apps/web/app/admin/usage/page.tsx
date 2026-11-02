'use client';

import { useState } from 'react';
import { H1, Table } from '@/components/admin/table';
import { Input } from '@/components/ui/input';
import { adminApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';

type Row = { tenant: string; slug: string; messages: number; ocrPages: number; aiTokens: number; aiCostUsd: number; invoicesSent: number };

export default function Usage() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const { data } = useApi<{ items: Row[] }>(`/admin/v1/usage?period=${period}`, adminApi);
  const total = (data?.items ?? []).reduce((s, r) => s + r.aiCostUsd, 0);
  return (
    <div>
      <H1 action={<Input type="month" className="w-44" value={period} onChange={(e) => setPeriod(e.target.value)} />}>Usage & cost</H1>
      <p className="mb-3 text-sm text-muted">Total AI cost: ${total.toFixed(2)}</p>
      <Table
        rows={data?.items}
        cols={[
          { h: 'Tenant', c: (r) => r.tenant },
          { h: 'Messages', c: (r) => r.messages, className: 'text-end tabular-nums' },
          { h: 'OCR pages', c: (r) => r.ocrPages, className: 'text-end tabular-nums' },
          { h: 'AI tokens', c: (r) => r.aiTokens.toLocaleString(), className: 'text-end tabular-nums' },
          { h: 'AI cost', c: (r) => `$${r.aiCostUsd.toFixed(2)}`, className: 'text-end tabular-nums' },
          { h: 'Invoices sent', c: (r) => r.invoicesSent, className: 'text-end tabular-nums' },
        ]}
      />
    </div>
  );
}
