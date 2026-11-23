'use client';

import { BarChart3, Banknote, Bot, Briefcase, Building2, ChevronRight, CreditCard, Landmark, LogOut, Receipt, Settings, Sparkles, TrendingUp, Users, Wallet } from 'lucide-react';
import { useView } from '@/lib/views';
import Link from 'next/link';
import { Page } from '@/components/page';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

/** Team tools for the business owner (the accountant can view). */
const TEAM = [
  { href: '/office', label: 'Office', icon: Building2 },
  { href: '/pipeline', label: 'Sales pipeline', icon: TrendingUp },
];
const LINKS = [
  { href: '/insights', label: 'Insights & analysis', icon: Sparkles },
  { href: '/purchases', label: 'Purchases & expenses', icon: Receipt },
  { href: '/payments', label: 'Payments', icon: Wallet },
  { href: '/bank', label: 'Bank matching', icon: Banknote },
  { href: '/parties', label: 'Customers & suppliers', icon: Users },
  { href: '/reports', label: 'Reports', icon: BarChart3 },
  { href: '/tax', label: 'Tax centre', icon: Landmark },
  { href: '/ask', label: 'Ask your books', icon: Bot },
  { href: '/settings', label: 'Settings & team', icon: Settings },
  { href: '/billing', label: 'Billing', icon: CreditCard },
];

export default function More() {
  const { t } = useI18n();
  const { logout, me, session } = useAuth();
  const { actions, labels } = useView();
  const portal = (session?.memberships.length ?? 0) > 1 || me?.user?.role === 'tenant_accountant';
  return (
    <Page title={t('nav.more')}>
      {portal && (
        <Link href="/portal" className="mb-4 flex min-h-14 items-center gap-3 rounded-2xl bg-brand px-4 text-white">
          <Briefcase className="h-5 w-5" />
          <span className="flex-1 font-medium">All my businesses ({session?.memberships.length ?? 1})</span>
          <ChevronRight className="h-4 w-4 rtl:rotate-180" />
        </Link>
      )}
      <h2 className="mb-2 text-sm font-semibold text-muted">New entry</h2>
      <Card className="mb-4 divide-y divide-line p-0">
        {actions.map(({ href, label, hint, icon: Icon }) => (
          <Link key={href} href={href} className="flex min-h-14 items-center gap-3 px-4">
            <Icon className="h-5 w-5 text-brand" />
            <span className="flex-1">
              {label} <span className="text-xs text-muted">· {hint}</span>
            </span>
            <ChevronRight className="h-4 w-4 text-muted rtl:rotate-180" />
          </Link>
        ))}
      </Card>
      <Card className="divide-y divide-line p-0">
        {[...(me?.user?.role === 'owner' || me?.user?.role === 'tenant_accountant' ? TEAM : []), ...LINKS].map(({ href, label: l, icon: Icon }) => ({ href, label: href === '/parties' ? labels.parties : l, icon: Icon })).map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className="flex min-h-14 items-center gap-3 px-4">
            <Icon className="h-5 w-5 text-brand" />
            <span className="flex-1">{label}</span>
            <ChevronRight className="h-4 w-4 text-muted rtl:rotate-180" />
          </Link>
        ))}
      </Card>
      <p className="mt-6 text-center text-xs text-muted">{me?.user?.name} · {me?.tenant.name}</p>
      <button onClick={() => void logout()} className="mx-auto mt-2 flex min-h-11 items-center gap-2 px-4 text-sm text-red-600">
        <LogOut className="h-4 w-4" /> Log out
      </button>
    </Page>
  );
}
