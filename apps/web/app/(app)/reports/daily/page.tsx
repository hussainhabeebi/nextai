'use client';

import { ChevronLeft, ChevronRight, Download, Printer } from 'lucide-react';
import { useState } from 'react';
import { StatusBadge } from '@/components/entry';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card, Empty, Skeleton } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { ENTRY_ACTIONS, KIND_LABEL, modeLabel, shiftDay, todayIso, type DailyReport, type EntryKind } from '@/lib/entries';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

const SUMMARY: Array<{ key: keyof DailyReport['totals']; label: string; kind: EntryKind }> = [
  { key: 'sales', label: 'Sales', kind: 'sale' },
  { key: 'purchases', label: 'Purchases', kind: 'purchase' },
  { key: 'expenses', label: 'Expenses', kind: 'expense' },
  { key: 'receipts', label: 'Receipts', kind: 'receipt' },
  { key: 'payments', label: 'Payments', kind: 'payment' },
  { key: 'bank', label: 'Bank entries', kind: 'bank' },
];
const toneOf = (k: EntryKind) => ENTRY_ACTIONS.find((a) => a.kind === k)!.tone;

export default function DailyReportPage() {
  const [date, setDate] = useState(todayIso());
  const [filter, setFilter] = useState<EntryKind | 'all'>('all');
  const { data, loading, error, reload } = useApi<DailyReport>(`/v1/daily-report?date=${date}`);
  const cur = data?.currency;
  const rows = data?.entries.filter((e) => filter === 'all' || e.kind === filter) ?? [];
  const isToday = date === todayIso();
  const pretty = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const exportCsv = () => {
    if (!data) return;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      ['Date', 'Type', 'Party', 'Description', 'Mode', 'Reference', 'ERP voucher', 'Status', 'Amount'],
      ...data.entries.map((e) => [data.date, KIND_LABEL[e.kind], e.party, e.description, e.mode, e.reference, e.erpName, e.status, e.amount]),
    ]
      .map((r) => r.map(esc).join(','))
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `daily-report-${data.date}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Page
      title="Daily report"
      back="/reports"
      size="wide"
      onRefresh={reload}
      action={
        <div className="flex gap-2 print:hidden">
          <Button variant="secondary" onClick={exportCsv} disabled={!data?.entries.length} aria-label="Export CSV">
            <Download className="h-4 w-4" /> <span className="hidden sm:inline">CSV</span>
          </Button>
          <Button variant="secondary" onClick={() => window.print()} aria-label="Print">
            <Printer className="h-4 w-4" /> <span className="hidden sm:inline">Print</span>
          </Button>
        </div>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
        <Button variant="secondary" size="icon" aria-label="Previous day" onClick={() => setDate(shiftDay(date, -1))}>
          <ChevronLeft className="h-5 w-5 rtl:rotate-180" />
        </Button>
        <Input type="date" aria-label="Report date" className="w-auto" value={date} max={todayIso()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <Button variant="secondary" size="icon" aria-label="Next day" disabled={isToday} onClick={() => setDate(shiftDay(date, 1))}>
          <ChevronRight className="h-5 w-5 rtl:rotate-180" />
        </Button>
        {!isToday && (
          <Button variant="ghost" onClick={() => setDate(todayIso())}>
            Today
          </Button>
        )}
      </div>
      <p className="mb-4 text-sm text-muted">{pretty}</p>

      {error && <p className="mb-4 text-sm text-red-600">{error.message}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {SUMMARY.map((s) => (
          <button key={s.key} type="button" onClick={() => setFilter(filter === s.kind ? 'all' : s.kind)} className="text-start" aria-pressed={filter === s.kind}>
            <Card className={cn('h-full p-3 transition', filter === s.kind && 'ring-2 ring-brand')}>
              <span className={cn('inline-block rounded-md px-1.5 py-0.5 text-[11px] font-semibold', toneOf(s.kind))}>{s.label}</span>
              {loading && !data ? <Skeleton className="mt-2 h-6 w-20" /> : <p className="mt-2 text-lg font-bold tabular-nums">{money(data?.totals[s.key], cur)}</p>}
            </Card>
          </button>
        ))}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Card className="p-3">
          <p className="text-xs text-muted">Money in</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-300">{money(data?.totals.cashIn, cur)}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted">Money out</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-rose-700 dark:text-rose-300">{money(data?.totals.cashOut, cur)}</p>
        </Card>
        <Card className="bg-brand p-3 text-white">
          <p className="text-xs opacity-90">Net cash flow</p>
          <p className="mt-1 text-lg font-bold tabular-nums">{money(data?.netCashFlow, cur)}</p>
          <p className="text-xs opacity-90">Sales − purchases − expenses: {money(data?.grossProfit, cur)}</p>
        </Card>
      </div>

      <Card className="mt-4 overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-semibold">
            Day book {filter !== 'all' && <span className="text-muted">· {KIND_LABEL[filter]}s</span>}
          </h2>
          {filter !== 'all' && (
            <button className="text-sm font-medium text-brand print:hidden" onClick={() => setFilter('all')}>
              Show all
            </button>
          )}
        </div>
        {loading && !data ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : rows.length === 0 ? (
          <Empty>No entries {filter === 'all' ? '' : `of this type `}on this day.</Empty>
        ) : (
          <>
            {/* Desktop table */}
            <table className="hidden w-full text-sm md:table print:table">
              <thead className="bg-bg text-start text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 text-start font-medium">Type</th>
                  <th className="px-4 py-2 text-start font-medium">Party / details</th>
                  <th className="px-4 py-2 text-start font-medium">Mode</th>
                  <th className="px-4 py-2 text-start font-medium">Reference</th>
                  <th className="px-4 py-2 text-start font-medium">Voucher</th>
                  <th className="px-4 py-2 text-end font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-2.5">
                      <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-semibold', toneOf(e.kind))}>{KIND_LABEL[e.kind]}</span>
                    </td>
                    <td className="max-w-[320px] px-4 py-2.5">
                      <p className="truncate font-medium">{e.party ?? e.description}</p>
                      {e.party && <p className="truncate text-xs text-muted">{e.description}</p>}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{modeLabel(e.mode) || '—'}</td>
                    <td className="px-4 py-2.5 text-muted">{e.reference ?? '—'}</td>
                    <td className="px-4 py-2.5">{e.erpName ? <span className="text-muted">{e.erpName}</span> : <StatusBadge status={e.status} />}</td>
                    <td className="px-4 py-2.5 text-end font-semibold tabular-nums">{money(e.amount, cur)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line bg-bg">
                  <td colSpan={5} className="px-4 py-2.5 font-semibold">
                    {rows.length} entr{rows.length === 1 ? 'y' : 'ies'}
                  </td>
                  <td className="px-4 py-2.5 text-end font-bold tabular-nums">{money(rows.reduce((s, e) => s + e.amount, 0), cur)}</td>
                </tr>
              </tfoot>
            </table>
            {/* Phone list */}
            <ul className="divide-y divide-line md:hidden print:hidden">
              {rows.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-semibold', toneOf(e.kind))}>{KIND_LABEL[e.kind]}</span>
                    <p className="mt-1 truncate text-sm font-medium">{e.party ?? e.description}</p>
                    <p className="truncate text-xs text-muted">{[modeLabel(e.mode), e.reference, e.erpName].filter(Boolean).join(' · ')}</p>
                  </div>
                  <span className="shrink-0 font-semibold tabular-nums">{money(e.amount, cur)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </Page>
  );
}
