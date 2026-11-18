'use client';

import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Page } from '@/components/page';
import { Badge, Card, Skeleton } from '@/components/ui/card';
import { ENTRY_ACTIONS, modeLabel, todayIso, type DailyReport, type EntryKind } from '@/lib/entries';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { cn } from '@/lib/cn';

const PLURAL: Record<EntryKind, string> = {
  sale: 'sales',
  purchase: 'purchases',
  expense: 'expenses',
  bank: 'bank entries',
  receipt: 'receipts',
  payment: 'payments',
};

/** Hook for the "today so far" panel next to every entry form; reload after saving. */
export function useToday() {
  return useApi<DailyReport>(`/v1/daily-report?date=${todayIso()}`);
}

/**
 * Two-column voucher screen on desktop: the form on the left, today's entries of the same kind
 * on the right, plus a strip to jump between voucher types. Single column on phones.
 */
export function EntryLayout({
  title,
  kind,
  today,
  children,
}: {
  title: string;
  kind: EntryKind;
  today: ReturnType<typeof useToday>;
  children: ReactNode;
}) {
  const rows = today.data?.entries.filter((e) => e.kind === kind) ?? [];
  const total = rows.reduce((s, e) => s + e.amount, 0);
  return (
    <Page title={title} back="/" size="wide">
      <nav
        aria-label="Voucher type"
        className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0"
      >
        {ENTRY_ACTIONS.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            aria-current={a.kind === kind ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium',
              a.kind === kind
                ? 'border-brand bg-brand text-white'
                : 'border-line bg-card text-muted hover:text-fg',
            )}
          >
            <a.icon className="h-4 w-4" /> {a.label}
          </Link>
        ))}
      </nav>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="lg:p-6">{children}</Card>
        <aside>
          <Card className="p-0">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-sm font-semibold">Today&apos;s {PLURAL[kind]}</h2>
              <span className="text-sm font-bold tabular-nums">{money(total, today.data?.currency)}</span>
            </div>
            {today.loading && !today.data ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : rows.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted">Nothing recorded yet today.</p>
            ) : (
              <ul className="max-h-[420px] divide-y divide-line overflow-y-auto">
                {rows
                  .slice()
                  .reverse()
                  .map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{e.party ?? e.description}</p>
                        <p className="truncate text-xs text-muted">
                          {[modeLabel(e.mode), e.reference, e.erpName].filter(Boolean).join(' · ') ||
                            e.status}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {money(e.amount, today.data?.currency)}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
            <Link
              href="/reports/daily"
              className="block border-t border-line px-4 py-3 text-center text-sm font-medium text-brand"
            >
              Open daily report →
            </Link>
          </Card>
        </aside>
      </div>
    </Page>
  );
}

export function Saved({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="mb-4 flex items-center gap-3 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100"
    >
      <CheckCircle2 className="h-5 w-5 shrink-0" />
      <span className="flex-1">{text}</span>
      <button type="button" onClick={onDismiss} className="text-xs font-medium underline">
        Dismiss
      </button>
    </div>
  );
}

export const StatusBadge = ({ status }: { status: string }) => (
  <Badge tone={status === 'posted' ? 'green' : status === 'failed' ? 'red' : 'amber'}>
    {status === 'posted' ? 'posted' : status === 'failed' ? 'failed' : 'posting'}
  </Badge>
);

/** Two fields per row on desktop. */
export const FieldGrid = ({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) => (
  <div className={cn('grid gap-4', cols === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}>{children}</div>
);
