'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { usePullToRefresh } from '@/lib/hooks';

export function Page({ title, back, action, onRefresh, children }: { title: string; back?: string; action?: ReactNode; onRefresh?: () => Promise<unknown> | void; children: ReactNode }) {
  const pull = usePullToRefresh(onRefresh ?? (() => {}));
  return (
    <div className="mx-auto w-full max-w-[640px] px-4 pb-28 pt-3">
      {onRefresh && pull > 0 && (
        <div className="flex justify-center text-xs text-muted" style={{ height: pull / 2 }}>
          {pull > 70 ? 'Release to refresh' : 'Pull to refresh'}
        </div>
      )}
      <header className="mb-4 flex min-h-11 items-center gap-2">
        {back && (
          <Link href={back} className="-ms-2 inline-flex h-11 w-11 items-center justify-center rounded-xl hover:bg-card" aria-label="Back">
            <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
          </Link>
        )}
        <h1 className="flex-1 truncate text-xl font-bold">{title}</h1>
        {action}
      </header>
      {children}
    </div>
  );
}
