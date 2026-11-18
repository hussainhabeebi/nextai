'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { money } from '@/lib/format';

export interface Line {
  description: string;
  qty: string;
  rate: string;
}
export const emptyLine = (): Line => ({ description: '', qty: '1', rate: '' });
export const lineTotal = (lines: Line[]) =>
  lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.rate || 0), 0);
export const cleanLines = (lines: Line[]) =>
  lines
    .filter((l) => l.description && Number(l.rate) >= 0)
    .map((l) => ({ description: l.description, qty: Number(l.qty), rate: Number(l.rate) }));

/** Item grid: a real table on desktop (item · qty · rate · amount), stacked rows on phones. */
export function LineItems({
  lines,
  onChange,
  currency,
  itemLabel = 'Item / service',
}: {
  lines: Line[];
  onChange: (l: Line[]) => void;
  currency?: string;
  itemLabel?: string;
}) {
  const set = (i: number, patch: Partial<Line>) =>
    onChange(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div>
      <div className="mb-1 hidden grid-cols-[minmax(0,1fr)_90px_130px_130px_44px] gap-2 px-1 text-xs font-medium text-muted sm:grid">
        <span>{itemLabel}</span>
        <span className="text-end">Qty</span>
        <span className="text-end">Rate</span>
        <span className="text-end">Amount</span>
        <span />
      </div>
      <ul className="space-y-2">
        {lines.map((l, i) => (
          <li
            key={i}
            className="grid grid-cols-[1fr_1fr_auto] gap-2 rounded-xl border border-line p-2 sm:grid-cols-[minmax(0,1fr)_90px_130px_130px_44px] sm:border-0 sm:p-0"
          >
            <Input
              className="col-span-3 sm:col-span-1"
              placeholder={itemLabel}
              aria-label={`${itemLabel} ${i + 1}`}
              value={l.description}
              onChange={(e) => set(i, { description: e.target.value })}
              required
            />
            <Input
              className="text-end"
              inputMode="decimal"
              aria-label={`Qty ${i + 1}`}
              value={l.qty}
              onChange={(e) => set(i, { qty: e.target.value })}
            />
            <Input
              className="text-end"
              inputMode="decimal"
              aria-label={`Rate ${i + 1}`}
              placeholder="Rate"
              value={l.rate}
              onChange={(e) => set(i, { rate: e.target.value })}
              required
            />
            <span className="hidden items-center justify-end pe-1 text-sm font-semibold tabular-nums sm:flex">
              {money(Number(l.qty || 0) * Number(l.rate || 0), currency)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove line ${i + 1}`}
              onClick={() => onChange(lines.filter((_, j) => j !== i))}
              disabled={lines.length === 1}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
        <Button type="button" variant="secondary" onClick={() => onChange([...lines, emptyLine()])}>
          <Plus className="h-4 w-4" /> Add line
        </Button>
        <p className="text-lg font-bold tabular-nums">Total {money(lineTotal(lines), currency)}</p>
      </div>
    </div>
  );
}
