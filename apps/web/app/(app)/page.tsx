'use client';

import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Camera, Landmark, Sparkles, TrendingUp, Wallet } from 'lucide-react';
import Link from 'next/link';
import { Page } from '@/components/page';
import { Card, Skeleton } from '@/components/ui/card';
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
    <Page title={t('nav.home')} onRefresh={reload}>
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

      <div className="grid grid-cols-2 gap-3">
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

      <Link href="/capture" className="fixed bottom-20 end-4 z-20 inline-flex h-14 items-center gap-2 rounded-full bg-brand-amber px-5 font-semibold text-black shadow-lg" aria-label={t('capture.title')}>
        <Camera className="h-5 w-5" /> {t('nav.capture')}
      </Link>
    </Page>
  );
}
