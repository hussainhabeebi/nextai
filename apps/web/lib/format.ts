import { formatCompact, formatMoney, type Currency } from '@nextai/shared';

export const money = (n: number | undefined, cur: string = 'INR') => formatMoney(n ?? 0, cur as Currency);
export const compact = (n: number | undefined, cur: string = 'INR') => formatCompact(n ?? 0, cur as Currency);
