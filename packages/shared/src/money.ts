import type { Currency } from './constants.js';

/** Format amounts per tenant currency. INR uses Indian grouping (lakh/crore). */
export function formatMoney(amount: number, currency: Currency, locale?: string): string {
  const loc = locale ?? (currency === 'INR' ? 'en-IN' : currency === 'AED' ? 'en-AE' : 'en-US');
  return new Intl.NumberFormat(loc, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Compact INR: 1.5 L, 2.3 Cr; AED: 1.5K, 2.3M */
export function formatCompact(amount: number, currency: Currency): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  const sym = currency === 'INR' ? '₹' : currency === 'AED' ? 'AED ' : '$';
  if (currency === 'INR') {
    if (abs >= 1e7) return `${sign}${sym}${trim(abs / 1e7)} Cr`;
    if (abs >= 1e5) return `${sign}${sym}${trim(abs / 1e5)} L`;
    if (abs >= 1e3) return `${sign}${sym}${trim(abs / 1e3)}K`;
    return `${sign}${sym}${trim(abs)}`;
  }
  if (abs >= 1e6) return `${sign}${sym}${trim(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}${sym}${trim(abs / 1e3)}K`;
  return `${sign}${sym}${trim(abs)}`;
}

function trim(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** True if a and b differ by at most tolerance (default 1 currency unit). */
export const approxEqual = (a: number, b: number, tolerance = 1): boolean => Math.abs(a - b) <= tolerance;
