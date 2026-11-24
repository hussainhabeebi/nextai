'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { money } from '@/lib/format';

/** One medicine row. Sale: rate = MRP, disc = discount %. Purchase: rate = purchase rate, mrp + free qty. */
export interface MedLine {
  description: string;
  batch: string;
  expiry: string; // YYYY-MM
  qty: string;
  rate: string;
  disc: string;
  mrp: string;
  free: string;
}
export const emptyMed = (): MedLine => ({
  description: '',
  batch: '',
  expiry: '',
  qty: '1',
  rate: '',
  disc: '',
  mrp: '',
  free: '',
});
const n = (v: string) => Number(v || 0);
export const medAmount = (l: MedLine, mode: 'sale' | 'purchase') =>
  n(l.qty) * n(l.rate) * (mode === 'sale' ? 1 - Math.min(100, n(l.disc)) / 100 : 1);

/** Months until expiry (negative = expired), or null if unknown. */
export function monthsToExpiry(expiry: string, now = new Date()) {
  if (!/^\d{4}-\d{2}$/.test(expiry)) return null;
  const [y, m] = expiry.split('-').map(Number) as [number, number];
  return (y - now.getFullYear()) * 12 + (m - (now.getMonth() + 1));
}

function ExpiryNote({ expiry }: { expiry: string }) {
  const m = monthsToExpiry(expiry);
  if (m === null || m > 3) return null;
  return (
    <span className={cn('text-[11px] font-semibold', m < 0 ? 'text-red-600' : 'text-amber-600')}>
      {m < 0 ? 'Expired' : m === 0 ? 'Expires this month' : `Expires in ${m} mo`}
    </span>
  );
}

export function MedicineLines({
  lines,
  onChange,
  mode,
  currency,
}: {
  lines: MedLine[];
  onChange: (l: MedLine[]) => void;
  mode: 'sale' | 'purchase';
  currency?: string;
}) {
  const set = (i: number, patch: Partial<MedLine>) =>
    onChange(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  // One table row on desktop; on phones/tablets the medicine name takes a full row and the numbers wrap below.
  const cols =
    mode === 'sale'
      ? 'lg:grid-cols-[minmax(180px,1fr)_100px_140px_70px_100px_70px_110px_44px]'
      : 'lg:grid-cols-[minmax(180px,1fr)_100px_140px_70px_60px_100px_100px_110px_44px]';
  const heads =
    mode === 'sale'
      ? ['Medicine', 'Batch', 'Expiry', 'Qty', 'MRP', 'Disc %', 'Amount', '']
      : ['Medicine', 'Batch', 'Expiry', 'Qty', 'Free', 'Rate', 'MRP', 'Amount', ''];
  const cell = 'col-span-2 lg:col-span-1';
  return (
    <div>
      <div className={cn('mb-1 hidden gap-2 px-1 text-xs font-medium text-muted lg:grid', cols)}>
        {heads.map((h, i) => (
          <span key={i} className={i >= 3 ? 'text-end' : undefined}>
            {h}
          </span>
        ))}
      </div>
      <ul className="space-y-2">
        {lines.map((l, i) => (
          <li
            key={i}
            className={cn(
              'grid grid-cols-6 gap-2 rounded-xl border border-line p-2 lg:border-0 lg:p-0',
              cols,
            )}
          >
            <Input
              className="col-span-6 lg:col-span-1"
              placeholder="Medicine / item"
              aria-label={`Medicine ${i + 1}`}
              value={l.description}
              onChange={(e) => set(i, { description: e.target.value })}
              required
            />
            <Input
              className="col-span-3 lg:col-span-1"
              placeholder="Batch"
              aria-label={`Batch ${i + 1}`}
              value={l.batch}
              onChange={(e) => set(i, { batch: e.target.value.toUpperCase() })}
            />
            <div className="col-span-3 lg:col-span-1">
              <Input
                type="month"
                aria-label={`Expiry ${i + 1}`}
                value={l.expiry}
                onChange={(e) => set(i, { expiry: e.target.value })}
                className="px-2"
              />
              <ExpiryNote expiry={l.expiry} />
            </div>
            <Input
              className={cn(cell, 'text-end')}
              inputMode="decimal"
              aria-label={`Qty ${i + 1}`}
              placeholder="Qty"
              value={l.qty}
              onChange={(e) => set(i, { qty: e.target.value })}
            />
            {mode === 'purchase' && (
              <Input
                className={cn(cell, 'text-end')}
                inputMode="decimal"
                aria-label={`Free qty ${i + 1}`}
                placeholder="Free"
                value={l.free}
                onChange={(e) => set(i, { free: e.target.value })}
              />
            )}
            <Input
              className={cn(cell, 'text-end')}
              inputMode="decimal"
              aria-label={`${mode === 'sale' ? 'MRP' : 'Rate'} ${i + 1}`}
              placeholder={mode === 'sale' ? 'MRP' : 'Rate'}
              value={l.rate}
              onChange={(e) => set(i, { rate: e.target.value })}
              required
            />
            {mode === 'sale' ? (
              <Input
                className={cn(cell, 'text-end')}
                inputMode="decimal"
                aria-label={`Discount % ${i + 1}`}
                placeholder="Disc %"
                value={l.disc}
                onChange={(e) => set(i, { disc: e.target.value })}
              />
            ) : (
              <Input
                className={cn(cell, 'text-end')}
                inputMode="decimal"
                aria-label={`MRP ${i + 1}`}
                placeholder="MRP"
                value={l.mrp}
                onChange={(e) => set(i, { mrp: e.target.value })}
              />
            )}
            <span
              className={cn(
                'flex items-center justify-end pe-1 text-sm font-semibold tabular-nums lg:col-span-1',
                mode === 'sale' ? 'col-span-5' : 'col-span-3',
              )}
            >
              {money(medAmount(l, mode), currency)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="justify-self-end"
              aria-label={`Remove line ${i + 1}`}
              onClick={() => onChange(lines.filter((_, j) => j !== i))}
              disabled={lines.length === 1}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="secondary"
        className="mt-3"
        onClick={() => onChange([...lines, emptyMed()])}
      >
        <Plus className="h-4 w-4" /> Add medicine
      </Button>
    </div>
  );
}

/** Subtotal / discount / net box shown under a bill. */
export function BillSummary({
  rows,
  currency,
}: {
  rows: Array<[string, number, boolean?]>;
  currency?: string;
}) {
  return (
    <dl className="ms-auto w-full max-w-xs space-y-1 rounded-xl bg-bg p-3 text-sm">
      {rows.map(([k, v, strong]) => (
        <div
          key={k}
          className={cn('flex justify-between', strong && 'border-t border-line pt-1 text-base font-bold')}
        >
          <dt>{k}</dt>
          <dd className="tabular-nums">{money(v, currency)}</dd>
        </div>
      ))}
    </dl>
  );
}
