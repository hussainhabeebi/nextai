import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'amber';
const styles: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-dark active:bg-brand-dark',
  secondary: 'bg-card text-fg border border-line hover:bg-bg',
  ghost: 'text-fg hover:bg-bg',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  amber: 'bg-brand-amber text-black hover:brightness-95',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'md' | 'lg' | 'icon' }>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 rounded-xl font-semibold transition disabled:opacity-50',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        size === 'md' && 'min-h-11 px-4 text-sm',
        size === 'lg' && 'min-h-14 w-full px-5 text-base',
        size === 'icon' && 'h-11 w-11',
        styles[variant],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
