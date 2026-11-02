'use client';

import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Camera, Landmark, TrendingUp, Wallet } from 'lucide-react';
import Link from 'next/link';
import { Page } from '@/components/page';
import { Card, Skeleton } from '@/components/ui/card';
import { compact, money } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';

interface Dashboard {
  currency: string;
  cash: number;
  bank: number;
  receivables: number;
  payables: number;
  todaySales: number;
  todayExpenses: number;
  profitMtd: number;
  taxDue: number;
  pendingApprovals: number;
  alerts: Array<{ kind: string; text: string }>;
}

export default function Home() {
  const { t } = useI18n();
  const { data: d, loading, reload } = useApi<Dashboard>('/v1/dashboard');
  const cur = d?.currency ?? 'INR';
  const tiles = d && [
    { label: t('home.receivables'), value: d.receivables, icon: ArrowDownLeft, href: '/parties?kind=customer' },
    { label: t('home.payables'), value: d.payables, icon: ArrowUpRight, href: '/parties?kind=supplier' },
    { label: t('home.todaySales'), value: d.todaySales, icon: TrendingUp, href: '/sales' },
    { label: t('home.todayExpenses'), value: d.todayExpenses, icon: Wallet, href: '/purchases' },
    { label: t('home.profitMtd'), value: d.profitMtd, icon: TrendingUp, href: '/reports/profit_and_loss' },
    { label: t('home.taxDue'), value: d.taxDue, icon: Landmark, href: '/tax' },
  ];
  return (
    <Page title={t('nav.home')} onRefresh={reload}>
      <Card className="mb-4 bg-brand text-white">
        <p className="text-sm opacity-90">{t('home.cash')}</p>
        {loading && !d ? <Skeleton className="mt-2 h-9 w-48 bg-white/30" /> : <p className="mt-1 text-3xl font-bold tabular-nums">{money((d?.cash ?? 0) + (d?.bank ?? 0), cur)}</p>}
        <div className="mt-2 flex gap-4 text-sm opacity-90">
          <span>Cash {compact(d?.cash, cur)}</span>
          <span>Bank {compact(d?.bank, cur)}</span>
        </div>
      </Card>

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
          : tiles.map(({ label, value, icon: Icon, href }) => (
              <Link key={label} href={href}>
                <Card className="h-full transition active:scale-[0.98]">
                  <div className="flex items-center justify-between text-xs text-muted">
                    {label}
                    <Icon className="h-4 w-4" />
                  </div>
                  <p className="mt-2 text-lg font-bold tabular-nums">{compact(value, cur)}</p>
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
