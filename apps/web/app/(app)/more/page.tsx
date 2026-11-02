'use client';

import { BarChart3, Bot, ChevronRight, CreditCard, Landmark, LogOut, Receipt, Settings, Users, Wallet } from 'lucide-react';
import Link from 'next/link';
import { Page } from '@/components/page';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

const LINKS = [
  { href: '/purchases', label: 'Purchases & expenses', icon: Receipt },
  { href: '/payments', label: 'Payments', icon: Wallet },
  { href: '/parties', label: 'Customers & suppliers', icon: Users },
  { href: '/reports', label: 'Reports', icon: BarChart3 },
  { href: '/tax', label: 'Tax centre', icon: Landmark },
  { href: '/ask', label: 'Ask your books', icon: Bot },
  { href: '/settings', label: 'Settings & team', icon: Settings },
  { href: '/billing', label: 'Billing', icon: CreditCard },
];

export default function More() {
  const { t } = useI18n();
  const { logout, me } = useAuth();
  return (
    <Page title={t('nav.more')}>
      <Card className="divide-y divide-line p-0">
        {LINKS.map(({ href, label, icon: Icon }) => (
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
