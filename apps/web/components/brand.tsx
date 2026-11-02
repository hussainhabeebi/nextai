import { cn } from '@/lib/cn';

/**
 * NextAi logo system (from the brand sheet): mark (chat bubble + rising trend line),
 * primary (mark + wordmark), stacked, app icon, black and white variants.
 */
export function LogoMark({ className, mono }: { className?: string; mono?: 'black' | 'white' }) {
  const stroke = mono === 'black' ? '#0B0B0B' : mono === 'white' ? '#FFFFFF' : '#0E7A6B';
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" fill="none" stroke={stroke} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M40 8H18A12 12 0 0 0 6 20v12a12 12 0 0 0 8 11.3V56l14-12h10a12 12 0 0 0 12-12v-8" />
      <path d="M15 35l10-9 6 6 21-21" />
    </svg>
  );
}

export function Wordmark({ className, mono }: { className?: string; mono?: 'black' | 'white' }) {
  const next = mono === 'black' ? 'text-black' : mono === 'white' ? 'text-white' : 'text-brand';
  const ai = mono === 'black' ? 'text-black' : mono === 'white' ? 'text-white' : 'text-brand-amber';
  return (
    <span className={cn('font-brand font-extrabold tracking-tight', className)}>
      <span className={next}>Next</span>
      <span className={ai}>Ai</span>
    </span>
  );
}

export function LogoPrimary({ className, mono }: { className?: string; mono?: 'black' | 'white' }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)} aria-label="NextAi">
      <LogoMark className="h-[1.6em] w-[1.6em]" mono={mono} />
      <Wordmark mono={mono} />
    </span>
  );
}

export function LogoStacked({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex flex-col items-center gap-1', className)} aria-label="NextAi">
      <LogoMark className="h-16 w-16" />
      <Wordmark className="text-3xl" />
    </span>
  );
}

export function AppIcon({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center justify-center rounded-[22%] bg-brand', className)} aria-hidden="true">
      <LogoMark className="h-3/4 w-3/4" mono="white" />
    </span>
  );
}
