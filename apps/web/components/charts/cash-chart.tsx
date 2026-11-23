'use client';

import { useMemo, useState } from 'react';
import { compact, money } from '@/lib/format';

export interface CashPoint {
  weekStart: string;
  closing: number;
  p10: number;
  p90: number;
}

const W = 360;
const H = 200;
const PAD = { l: 50, r: 8, t: 10, b: 22 };

const label = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Projected closing cash per week. Base = solid line + p10–p90 band; an optional scenario is a
 * dashed second series (dash = secondary encoding so identity is not color-alone).
 */
export function CashChart({ base, scenario, currency, buffer = 0 }: { base: CashPoint[]; scenario?: CashPoint[]; currency?: string; buffer?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const { x, y, ticks } = useMemo(() => {
    const vals = [...base.flatMap((p) => [p.p10, p.p90, p.closing]), ...(scenario ?? []).map((p) => p.closing), 0, buffer];
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (min === max) max = min + 1;
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;
    const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / Math.max(1, base.length - 1);
    const y = (v: number) => PAD.t + ((max - v) * (H - PAD.t - PAD.b)) / (max - min);
    const step = (max - min) / 4;
    return { x, y, ticks: Array.from({ length: 5 }, (_, i) => min + step * i) };
  }, [base, scenario, buffer]);

  if (!base.length) return null;
  const path = (pts: CashPoint[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.closing).toFixed(1)}`).join(' ');
  const band = `${base.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.p90).toFixed(1)}`).join(' ')} ${[...base].reverse().map((p, j) => `L${x(base.length - 1 - j).toFixed(1)},${y(p.p10).toFixed(1)}`).join(' ')} Z`;
  const last = base.length - 1;
  const h = hover ?? null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke="var(--chart-1)" strokeWidth="2" /></svg>Base case
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width="14" height="10" aria-hidden="true"><rect width="14" height="10" rx="2" fill="var(--chart-1)" opacity="0.15" /></svg>Likely range (10–90%)
          </span>
          {scenario && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke="var(--chart-2)" strokeWidth="2" strokeDasharray="4 3" /></svg>What-if
            </span>
          )}
        </div>
        <button className="min-h-8 rounded-lg px-2 underline-offset-2 hover:underline" onClick={() => setTable((t) => !t)}>
          {table ? 'Chart' : 'Table'}
        </button>
      </div>
      {table ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1 text-start font-medium">Week of</th>
                <th className="py-1 text-end font-medium">Base</th>
                <th className="py-1 text-end font-medium">Range</th>
                {scenario && <th className="py-1 text-end font-medium">What-if</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {base.map((p, i) => (
                <tr key={p.weekStart}>
                  <td className="py-1">{label(p.weekStart)}</td>
                  <td className="py-1 text-end">{money(p.closing, currency)}</td>
                  <td className="py-1 text-end text-muted">{compact(p.p10, currency)} – {compact(p.p90, currency)}</td>
                  {scenario && <td className="py-1 text-end">{money(scenario[i]?.closing, currency)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div>
          {(() => {
            const i = h ?? last;
            return (
              <p className="mb-1 flex flex-wrap gap-x-3 text-xs tabular-nums" aria-live="polite">
                <span className="font-semibold">Week of {label(base[i]!.weekStart)}</span>
                <span>Base {compact(base[i]!.closing, currency)}</span>
                <span className="text-muted">Range {compact(base[i]!.p10, currency)} – {compact(base[i]!.p90, currency)}</span>
                {scenario?.[i] && <span>What-if {compact(scenario[i]!.closing, currency)}</span>}
              </p>
            );
          })()}
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Projected cash over ${base.length} weeks, ending at ${money(base[last]!.closing, currency)}`} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="rgb(var(--line))" strokeWidth="1" />
                <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="rgb(var(--muted))">{compact(t, currency)}</text>
              </g>
            ))}
            <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="rgb(var(--fg))" strokeOpacity="0.5" strokeWidth="1" />
            {buffer > 0 && (
              <g>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(buffer)} y2={y(buffer)} stroke="rgb(var(--muted))" strokeWidth="1" strokeDasharray="2 4" />
                <text x={W - PAD.r} y={y(buffer) - 4} textAnchor="end" fontSize="10" fill="rgb(var(--muted))">Buffer</text>
              </g>
            )}
            <path d={band} fill="var(--chart-1)" opacity="0.15" />
            <path d={path(base)} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {scenario && <path d={path(scenario)} fill="none" stroke="var(--chart-2)" strokeWidth="2" strokeDasharray="6 4" strokeLinejoin="round" strokeLinecap="round" />}
            {[0, Math.floor(last / 2), last].map((i) => (
              <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'} fontSize="10" fill="rgb(var(--muted))">{label(base[i]!.weekStart)}</text>
            ))}
            {h !== null && (
              <g pointerEvents="none">
                <line x1={x(h)} x2={x(h)} y1={PAD.t} y2={H - PAD.b} stroke="rgb(var(--muted))" strokeWidth="1" />
                <circle cx={x(h)} cy={y(base[h]!.closing)} r="4" fill="var(--chart-1)" stroke="rgb(var(--card))" strokeWidth="2" />
                {scenario?.[h] && <circle cx={x(h)} cy={y(scenario[h]!.closing)} r="4" fill="var(--chart-2)" stroke="rgb(var(--card))" strokeWidth="2" />}
              </g>
            )}
            {base.map((p, i) => (
              <rect key={p.weekStart} x={x(i) - (W - PAD.l - PAD.r) / base.length / 2} y={PAD.t} width={(W - PAD.l - PAD.r) / base.length} height={H - PAD.t - PAD.b} fill="transparent" onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />
            ))}
          </svg>
        </div>
      )}
    </div>
  );
}
