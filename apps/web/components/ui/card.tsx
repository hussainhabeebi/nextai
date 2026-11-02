import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Card = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('rounded-2xl border border-line bg-card p-4 shadow-sm', className)} {...p} />
);
export const Skeleton = ({ className }: { className?: string }) => <div className={cn('animate-pulse rounded-lg bg-line/70', className)} aria-hidden="true" />;
export const Badge = ({ className, tone = 'neutral', ...p }: HTMLAttributes<HTMLSpanElement> & { tone?: 'neutral' | 'green' | 'amber' | 'red' }) => (
  <span
    className={cn(
      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
      tone === 'neutral' && 'bg-line/60 text-fg',
      tone === 'green' && 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
      tone === 'amber' && 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
      tone === 'red' && 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
      className,
    )}
    {...p}
  />
);
export const Empty = ({ children }: { children: React.ReactNode }) => <p className="py-12 text-center text-sm text-muted">{children}</p>;
