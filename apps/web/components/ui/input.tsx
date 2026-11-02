import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cn('min-h-12 w-full rounded-xl border border-line bg-card px-3 text-base text-fg placeholder:text-muted focus:border-brand focus:outline-none', className)} {...p} />
));
Input.displayName = 'Input';

export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={cn('min-h-12 w-full rounded-xl border border-line bg-card px-3 text-base text-fg focus:border-brand focus:outline-none', className)} {...p} />
);

export const Field = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
  <label className="block space-y-1">
    <span className="text-sm font-medium text-fg">{label}</span>
    {children}
    {hint && <span className="block text-xs text-muted">{hint}</span>}
  </label>
);
