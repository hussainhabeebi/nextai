'use client';

import { Camera, CheckCircle2, Home, Menu, Receipt } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { LogoPrimary } from '@/components/brand';
import { AuthProvider, useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useOnline } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';

function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { t } = useI18n();
  const { me, session, switchTenant } = useAuth();
  const online = useOnline();
  const tabs = [
    { href: '/', label: t('nav.home'), icon: Home },
    { href: '/capture', label: t('nav.capture'), icon: Camera },
    { href: '/approvals', label: t('nav.approvals'), icon: CheckCircle2 },
    { href: '/sales', label: t('nav.sales'), icon: Receipt },
    { href: '/more', label: t('nav.more'), icon: Menu },
  ];
  return (
    <div className="min-h-dvh">
      <div className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[640px] items-center justify-between gap-2 px-4">
          <LogoPrimary className="text-lg" />
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
        {!online && <div className="bg-line px-4 py-1 text-center text-xs">Offline — captures will sync later</div>}
      </div>
      <main>{children}</main>
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card/95 backdrop-blur" aria-label="Main">
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
