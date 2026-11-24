'use client';

import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Camera, Landmark, Sparkles, TrendingUp, Wallet } from 'lucide-react';
import Link from 'next/link';
import { Page } from '@/components/page';
import { Card, Skeleton } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { modeLabel, todayIso, type DailyReport } from '@/lib/entries';
import { useView } from '@/lib/views';
import { compact, money } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';

interface Dashboard {
  currency: string;
  cash: number | null;
  bank: number | null;
  receivables: number;
  receivablesOverdue: number;
  payables: number;
  todaySales: number | null;
  todayExpenses: number | null;
  salesMtd: number;
  expensesMtd: number;
  profitMtd: number;
  profitPrev: number;
  taxDue: number;
  insight: { tone: 'good' | 'warn' | 'info'; text: string } | null;
  pendingApprovals: number;
  alerts: Array<{ kind: string; text: string }>;
  errors: string[];
}

export default function Home() {
  const { t } = useI18n();
  const { data: d, loading, reload } = useApi<Dashboard>('/v1/dashboard');
  const { actions, kindLabel, labels } = useView();
  const day = useApi<DailyReport>(`/v1/daily-report?date=${todayIso()}`);
  const cur = d?.currency ?? 'INR';
  const show = (v: number | null | undefined) => (v === null || v === undefined ? '—' : compact(v, cur));
  const tiles = d && [
    { label: t('home.receivables'), value: show(d.receivables), sub: d.receivablesOverdue > 0 ? `${compact(d.receivablesOverdue, cur)} overdue` : undefined, icon: ArrowDownLeft, href: '/insights' },
    { label: t('home.payables'), value: show(d.payables), icon: ArrowUpRight, href: '/insights' },
    { label: t('home.todaySales'), value: show(d.todaySales), sub: `Month ${compact(d.salesMtd, cur)}`, icon: TrendingUp, href: '/insights' },
    { label: t('home.todayExpenses'), value: show(d.todayExpenses), sub: `Month ${compact(d.expensesMtd, cur)}`, icon: Wallet, href: '/insights' },
    {
      label: t('home.profitMtd'),
      value: show(d.profitMtd),
      sub: d.profitPrev ? `${d.profitMtd >= d.profitPrev ? '▲' : '▼'} vs ${compact(d.profitPrev, cur)} same days last month` : undefined,
      icon: TrendingUp,
      href: '/insights',
    },
    { label: t('home.taxDue'), value: show(d.taxDue), icon: Landmark, href: '/tax' },
  ];
  return (
    <Page title={t('nav.home')} onRefresh={() => Promise.all([reload(), day.reload()])} size="wide">
      <section aria-label="New entry" className="mb-4">
        <h2 className="mb-2 text-sm font-semibold text-muted">New entry</h2>
        <div className={cn('grid grid-cols-4 gap-2 lg:gap-3', actions.length > 7 ? 'sm:grid-cols-8' : 'sm:grid-cols-7')}>
          {actions.map((a) => (
            <Link key={a.href} href={a.href} className="group flex flex-col items-center gap-1.5 rounded-2xl border border-line bg-card px-1 py-3 text-center shadow-sm transition hover:border-brand active:scale-[0.98] lg:items-start lg:px-4 lg:text-start">
              <span className={cn('inline-flex h-10 w-10 items-center justify-center rounded-xl', a.tone)}>
                <a.icon className="h-5 w-5" />
              </span>
              <span className="text-xs font-semibold leading-tight lg:text-sm">{a.label}</span>
              <span className="hidden text-xs text-muted lg:block">{a.hint}</span>
            </Link>
          ))}
        </div>
      </section>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-6">
      <div>
      <Card className="mb-4 bg-brand text-white">
        <p className="text-sm opacity-90">{t('home.cash')}</p>
        {loading && !d ? (
          <Skeleton className="mt-2 h-9 w-48 bg-white/30" />
        ) : (
          <p className="mt-1 text-3xl font-bold tabular-nums">{d?.cash === null || d?.bank === null ? '—' : money((d?.cash ?? 0) + (d?.bank ?? 0), cur)}</p>
        )}
        <div className="mt-2 flex gap-4 text-sm opacity-90">
          <span>Cash {show(d?.cash)}</span>
          <span>Bank {show(d?.bank)}</span>
        </div>
      </Card>

      {d?.insight && (
        <Link href="/insights" className="mb-3 flex min-h-12 items-start gap-3 rounded-xl border border-line bg-card px-3 py-2.5 text-sm">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
          <span className="flex-1">{d.insight.text}</span>
          <span className="shrink-0 text-xs font-medium text-brand">Insights</span>
        </Link>
      )}
      {d && d.errors.length > 0 && (
        <p className="mb-3 rounded-xl border border-amber-300 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:text-amber-100">
          Some figures couldn't be read from ERPNext: {d.errors.join('; ')}
        </p>
      )}

      {d?.alerts.map((a) => (
        <Link key={a.kind} href={a.kind === 'billing' ? '/billing' : '/approvals'} className="mb-3 flex min-h-12 items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          {a.text}
        </Link>
      ))}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        {!tiles
          ? Array.from({ length: 6 }, (_, i) => (
              <Card key={i}>
                <Skeleton className="h-4 w-20" />
                <Skeleton className="mt-3 h-6 w-24" />
              </Card>
            ))
          : tiles.map(({ label, value, sub, icon: Icon, href }) => (
              <Link key={label} href={href}>
                <Card className="h-full transition active:scale-[0.98]">
                  <div className="flex items-center justify-between text-xs text-muted">
                    {label}
                    <Icon className="h-4 w-4" />
                  </div>
                  <p className="mt-2 text-lg font-bold tabular-nums">{value}</p>
                  {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
                </Card>
              </Link>
            ))}
      </div>

      </div>

      <aside className="mt-4 lg:mt-0">
        <Card className="p-0">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="font-semibold">Today</h2>
            <Link href="/reports/daily" className="text-sm font-medium text-brand">
              {labels.dailyReport} →
            </Link>
          </div>
          {day.data && (
            <dl className="grid grid-cols-3 border-b border-line text-center">
              {(
                [
                  ['In', day.data.totals.cashIn, 'text-emerald-700 dark:text-emerald-300'],
                  ['Out', day.data.totals.cashOut, 'text-rose-700 dark:text-rose-300'],
                  ['Net', day.data.netCashFlow, ''],
                ] as const
              ).map(([k, v, c]) => (
                <div key={k} className="px-2 py-3">
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className={cn('text-sm font-bold tabular-nums', c)}>{compact(v, cur)}</dd>
                </div>
              ))}
            </dl>
          )}
          {day.loading && !day.data ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : !day.data?.entries.length ? (
            <p className="px-4 py-8 text-center text-sm text-muted">No entries yet today. Use the buttons above to record one.</p>
          ) : (
            <ul className="max-h-[480px] divide-y divide-line overflow-y-auto">
              {day.data.entries
                .slice()
                .reverse()
                .slice(0, 12)
                .map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{e.party ?? e.description}</p>
                      <p className="text-xs text-muted">{kindLabel(e.kind)}{e.mode ? ` · ${modeLabel(e.mode)}` : ''}</p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{money(e.amount, cur)}</span>
                  </li>
                ))}
            </ul>
          )}
        </Card>
      </aside>
      </div>

      <Link href="/capture" className="fixed bottom-20 end-4 z-20 lg:hidden inline-flex h-14 items-center gap-2 rounded-full bg-brand-amber px-5 font-semibold text-black shadow-lg" aria-label={t('capture.title')}>
        <Camera className="h-5 w-5" /> {t('nav.capture')}
      </Link>
    </Page>
  );
}
