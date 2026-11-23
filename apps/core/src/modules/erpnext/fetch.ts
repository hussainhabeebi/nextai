import type { ErpClient, ListOptions } from '@nextai/erpnext-client';

/**
 * Page through an ERPNext list until exhausted. Used where the whole population matters
 * (audit testing, forecasting), not a first page. `cap` guards against runaway reads.
 */
export async function listAll<T>(erp: ErpClient, doctype: string, opts: Omit<ListOptions, 'limit' | 'start'>, cap = 50_000, pageSize = 500): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let start = 0; start < cap; start += pageSize) {
    const page = await erp.list<T>(doctype, { ...opts, limit: pageSize, start });
    rows.push(...page);
    if (page.length < pageSize) return { rows, truncated: false };
  }
  return { rows: rows.slice(0, cap), truncated: true };
}

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
};
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
