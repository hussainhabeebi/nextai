'use client';

import { Download, Printer } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card, Empty, Skeleton } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useApi } from '@/lib/hooks';

type Col = { fieldname?: string; label?: string; fieldtype?: string } | string;
const colKey = (c: Col) => (typeof c === 'string' ? c.split(':')[0]! : (c.fieldname ?? c.label ?? ''));
const colLabel = (c: Col) => (typeof c === 'string' ? c.split(':')[0]! : (c.label ?? c.fieldname ?? ''));

export default function ReportView() {
  const { name } = useParams<{ name: string }>();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const { data, loading } = useApi<{ name: string; columns: Col[]; result: Array<Record<string, unknown> | unknown[]> }>(`/v1/reports/${name}${qs ? `?${qs}` : ''}`);
  const cols = (data?.columns ?? []).slice(0, 8);
  const rows = (data?.result ?? []).filter((r) => r && typeof r === 'object' && !Array.isArray(r)) as Array<Record<string, unknown>>;

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.map((c) => esc(colLabel(c))).join(','), ...rows.map((r) => cols.map((c) => esc(r[colKey(c)])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `${name}.csv`;
    a.click();
  };

  return (
    <Page title={data?.name ?? 'Report'} back="/reports">
      <div className="mb-3 grid grid-cols-2 gap-2">
        <Input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2 print:hidden">
        <Button variant="secondary" onClick={exportCsv} disabled={!rows.length}>
          <Download className="h-4 w-4" /> Excel (CSV)
        </Button>
        <Button variant="secondary" onClick={() => window.print()} disabled={!rows.length}>
          <Printer className="h-4 w-4" /> PDF
        </Button>
      </div>
      {loading && <Skeleton className="h-64" />}
      {!loading && rows.length === 0 && <Empty>No data for this period.</Empty>}
      {rows.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-bg text-start text-xs text-muted">
              <tr>{cols.map((c) => <th key={colKey(c)} className="whitespace-nowrap px-3 py-2 text-start font-medium">{colLabel(c)}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => {
                    const v = r[colKey(c)];
                    return <td key={colKey(c)} className={`whitespace-nowrap px-3 py-2 ${typeof v === 'number' ? 'text-end tabular-nums' : ''}`}>{typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v ?? '')}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </Page>
  );
}
