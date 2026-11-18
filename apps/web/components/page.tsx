'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { usePullToRefresh } from '@/lib/hooks';
import { cn } from '@/lib/cn';

/**
 * Page frame. Phones get a single 640px column; on desktop (lg+) the sidebar takes the left edge,
 * `size="wide"` pages use the full content width and the default stays a comfortable reading width.
 */
export function Page({
  title,
  back,
  action,
  onRefresh,
  size = 'narrow',
  children,
}: {
  title: string;
  back?: string;
  action?: ReactNode;
  onRefresh?: () => Promise<unknown> | void;
  size?: 'narrow' | 'wide';
  children: ReactNode;
}) {
  const pull = usePullToRefresh(onRefresh ?? (() => {}));
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-[640px] px-4 pb-28 pt-3 lg:px-8 lg:pb-12 lg:pt-6',
        size === 'wide' ? 'lg:max-w-6xl' : 'lg:max-w-3xl',
      )}
    >
      {onRefresh && pull > 0 && (
        <div className="flex justify-center text-xs text-muted" style={{ height: pull / 2 }}>
          {pull > 70 ? 'Release to refresh' : 'Pull to refresh'}
        </div>
      )}
      <header className="mb-4 flex min-h-11 items-center gap-2 lg:mb-6">
        {back && (
          <Link
            href={back}
            className="-ms-2 inline-flex h-11 w-11 items-center justify-center rounded-xl hover:bg-card lg:hidden"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
          </Link>
        )}
        <h1 className="flex-1 truncate text-xl font-bold lg:text-2xl">{title}</h1>
        {action}
      </header>
      {children}
    </div>
  );
}
