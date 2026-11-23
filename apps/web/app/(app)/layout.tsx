'use client';

import { BarChart3, Banknote, Bot, Briefcase, Building2, Camera, CheckCircle2, CreditCard, Home, Landmark, Menu, Receipt, Settings, Sparkles, TrendingUp, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { LogoPrimary } from '@/components/brand';
import { AuthProvider, useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { STYLES, useView, viewOf } from '@/lib/views';
import { useOnline } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';

const isImpersonating = (token: string) => {
  try {
    return !!(JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { imp?: string }).imp;
  } catch {
    return false;
  }
};

function Sidebar({ path, approvals }: { path: string; approvals?: number }) {
  const { t } = useI18n();
  const { actions, labels } = useView();
  const { me, session } = useAuth();
  const portal = (session?.memberships.length ?? 0) > 1 || me?.user?.role === 'tenant_accountant';
  const isActive = (href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));
  const groups: Array<{ title?: string; items: Array<{ href: string; label: string; icon: typeof Home; badge?: number }> }> = [
    {
      items: [
        { href: '/', label: t('nav.home'), icon: Home },
        { href: '/capture', label: t('nav.capture'), icon: Camera },
        { href: '/approvals', label: t('nav.approvals'), icon: CheckCircle2, badge: approvals },
      ],
    },
    { title: 'New entry', items: actions.filter((a) => a.kind !== 'daily').map((a) => ({ href: a.href, label: a.label, icon: a.icon })) },
    {
      title: 'Books',
      items: [
        { href: '/sales', label: labels.salesList, icon: Receipt },
        { href: '/purchases', label: 'Purchases & expenses', icon: Receipt },
        { href: '/bank', label: 'Bank matching', icon: Banknote },
        { href: '/parties', label: labels.parties, icon: Users },
      ],
    },
    {
      title: 'Reports',
      items: [
        { href: '/reports/daily', label: labels.dailyReport, icon: actions.find((a) => a.kind === 'daily')!.icon },
        { href: '/insights', label: 'Insights & analysis', icon: Sparkles },
        { href: '/reports', label: 'Financial reports', icon: BarChart3 },
        { href: '/tax', label: 'Tax centre', icon: Landmark },
        { href: '/ask', label: 'Ask your books', icon: Bot },
      ],
    },
    ...(me?.user?.role === 'owner' || me?.user?.role === 'tenant_accountant'
      ? [
          {
            title: 'Team',
            items: [
              { href: '/office', label: 'Office', icon: Building2 },
              { href: '/pipeline', label: 'Sales pipeline', icon: TrendingUp },
            ],
          },
        ]
      : []),
    {
      title: 'Account',
      items: [
        { href: '/settings', label: 'Settings & team', icon: Settings },
        { href: '/billing', label: 'Billing', icon: CreditCard },
        ...(portal ? [{ href: '/portal', label: 'All my businesses', icon: Briefcase }] : []),
      ],
    },
  ];
  // "/reports" should not light up while on "/reports/daily"
  const active = (href: string) => (href === '/reports' ? isActive(href) && !path.startsWith('/reports/daily') : href === '/sales' ? isActive(href) && path !== '/sales/new' : isActive(href));
  return (
    <aside className="fixed inset-y-0 start-0 z-30 hidden w-64 flex-col border-e border-line bg-card lg:flex print:hidden">
      <div className="flex h-16 items-center border-b border-line px-5">
        <LogoPrimary className="text-lg" />
      </div>
      <nav aria-label="Sidebar" className="flex-1 overflow-y-auto px-3 py-4">
        {groups.map((g, i) => (
          <div key={i} className="mb-4">
            {g.title && <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.title}</p>}
            <ul className="space-y-0.5">
              {g.items.map(({ href, label, icon: Icon, badge }) => {
                const on = active(href);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      aria-current={on ? 'page' : undefined}
                      className={cn('flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition', on ? 'bg-brand-light text-brand dark:bg-brand/20' : 'text-fg/80 hover:bg-bg hover:text-fg')}
                    >
                      <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={on ? 2.4 : 1.9} />
                      <span className="flex-1 truncate">{label}</span>
                      {!!badge && <span className="rounded-full bg-brand-amber px-1.5 text-[11px] font-bold text-black">{badge}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { t } = useI18n();
  const { me, session, switchTenant, reloadMe } = useAuth();
  const online = useOnline();
  const setup = me?.tenant.setup;
  const building = setup?.status === 'queued' || setup?.status === 'running';
  // New signup: refresh until the client's own ERPNext site is ready.
  useEffect(() => {
    if (!building) return;
    const id = setInterval(() => void reloadMe().catch(() => undefined), 20_000);
    return () => clearInterval(id);
  }, [building, reloadMe]);
  const { labels } = useView();
  // Tenant colour theme (Settings → App view & style). Teal = the original defaults in globals.css.
  const style = me?.tenant.appStyle ?? 'teal';
  useEffect(() => {
    const s = STYLES[style] ?? STYLES.teal;
    const root = document.documentElement.style;
    root.setProperty('--brand', s.brand);
    root.setProperty('--brand-dark', s.dark);
    root.setProperty('--brand-light', s.light);
    document.documentElement.dataset.view = viewOf(me?.tenant.appView);
  }, [style, me?.tenant.appView]);
  const tabs = [
    { href: '/', label: t('nav.home'), icon: Home },
    { href: '/capture', label: t('nav.capture'), icon: Camera },
    { href: '/approvals', label: t('nav.approvals'), icon: CheckCircle2 },
    labels.salesTab ? { ...labels.salesTab, icon: Receipt } : { href: '/sales', label: t('nav.sales'), icon: Receipt },
    { href: '/more', label: t('nav.more'), icon: Menu },
  ];
  return (
    <div className="min-h-dvh lg:ps-64">
      <Sidebar path={path} />
      <div className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur print:hidden">
        <div className="mx-auto flex h-14 max-w-[640px] items-center justify-between gap-2 px-4 lg:h-16 lg:max-w-none lg:px-8">
          <LogoPrimary className="text-lg lg:invisible" />
          {session && session.memberships.length > 1 ? (
            <select
              aria-label="Switch business"
              className="max-w-[55%] truncate rounded-lg border border-line bg-card px-2 py-2 text-sm"
              value={session.tenantId}
              onChange={(e) => void switchTenant(e.target.value)}
            >
              {session.memberships.map((m) => (
                <option key={m.tenantId} value={m.tenantId}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="truncate text-sm text-muted">{me?.tenant.name}</span>
          )}
        </div>
        {me?.tenant.status === 'past_due' && (
          <Link href="/billing" className="block bg-brand-amber px-4 py-2 text-center text-sm font-medium text-black">
            {t('billing.pastDue')}
          </Link>
        )}
        {me?.tenant.status === 'suspended' && (
          <Link href="/billing" className="block bg-red-600 px-4 py-2 text-center text-sm font-medium text-white">
            Account suspended — read-only. Tap to pay.
          </Link>
        )}
        {session && isImpersonating(session.accessToken) && <div className="bg-black px-4 py-1 text-center text-xs text-white">Admin view-only session (audited)</div>}
        {building && (
          <div role="status" className="flex items-center justify-center gap-2 bg-brand-light px-4 py-2 text-center text-xs text-brand-dark dark:bg-brand/20 dark:text-white">
            <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
            <span>
              Setting up your own ERPNext books{setup?.site ? ` at ${setup.site}` : ''} — usually a few minutes. You can add entries now; they&apos;ll post as soon as it&apos;s ready.
            </span>
          </div>
        )}
        {setup?.status === 'failed' && (
          <div role="alert" className="bg-amber-100 px-4 py-2 text-center text-xs text-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
            Your books setup needs a little help — our team has been notified and will finish it shortly. Your entries are saved.
          </div>
        )}
        {!online && <div className="bg-line px-4 py-1 text-center text-xs">Offline — captures will sync later</div>}
      </div>
      <main>{children}</main>
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card/95 backdrop-blur lg:hidden print:hidden" aria-label="Main">
        <ul className="mx-auto grid max-w-[640px] grid-cols-5">
          {tabs.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? path === '/' : path.startsWith(href);
            return (
              <li key={href}>
                <Link href={href} className={cn('flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium', active ? 'text-brand' : 'text-muted')} aria-current={active ? 'page' : undefined}>
                  <Icon className={cn('h-6 w-6', href === '/capture' && 'h-7 w-7')} strokeWidth={active ? 2.4 : 1.8} />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <Shell>{children}</Shell>
    </AuthProvider>
  );
}
