'use client';

import { Activity, BarChart3, CheckSquare, CreditCard, Flag, Gauge, Layers, LogOut, MessageSquare, PlusCircle, ScrollText, Shield, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { LogoPrimary } from '@/components/brand';
import { AdminAuthProvider, useAdmin } from '@/lib/admin-auth';
import { cn } from '@/lib/cn';

const NAV = [
  { href: '/admin', label: 'Dashboard', icon: Gauge },
  { href: '/admin/tenants', label: 'Tenants', icon: Layers },
  { href: '/admin/provision', label: 'Provision', icon: PlusCircle, roles: ['super_admin'] },
  { href: '/admin/review', label: 'Review queue', icon: CheckSquare, roles: ['super_admin', 'reviewer'] },
  { href: '/admin/users', label: 'Admin users', icon: Shield, roles: ['super_admin'] },
  { href: '/admin/plans', label: 'Plans & subs', icon: CreditCard },
  { href: '/admin/usage', label: 'Usage & cost', icon: BarChart3 },
  { href: '/admin/templates', label: 'Templates', icon: MessageSquare },
  { href: '/admin/audit', label: 'Audit log', icon: ScrollText },
  { href: '/admin/jobs', label: 'Jobs', icon: Users, roles: ['super_admin'] },
  { href: '/admin/flags', label: 'Feature flags', icon: Flag },
  { href: '/admin/health', label: 'System health', icon: Activity },
];

function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { role, logout } = useAdmin();
  if (path === '/admin/login') return <>{children}</>;
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[240px_1fr]">
      <aside className="border-b border-line bg-card md:sticky md:top-0 md:h-dvh md:border-b-0 md:border-e">
        <div className="flex h-14 items-center justify-between px-4">
          <LogoPrimary className="text-lg" />
          <span className="rounded bg-brand-amber px-1.5 text-[10px] font-bold uppercase text-black">Admin</span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
          {NAV.filter((n) => !n.roles || (role && n.roles.includes(role))).map(({ href, label, icon: Icon }) => {
            const active = href === '/admin' ? path === href : path.startsWith(href);
            return (
              <Link key={href} href={href} className={cn('flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-sm', active ? 'bg-brand text-white' : 'text-fg hover:bg-bg')}>
                <Icon className="h-4 w-4" /> {label}
              </Link>
            );
          })}
          <button onClick={() => void logout()} className="flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-sm text-red-600 hover:bg-bg md:mt-4">
            <LogOut className="h-4 w-4" /> Log out
          </button>
        </nav>
      </aside>
      <main className="min-w-0 p-4 md:p-8">{children}</main>
    </div>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AdminAuthProvider>
      <Shell>{children}</Shell>
    </AdminAuthProvider>
  );
}
