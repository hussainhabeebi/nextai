'use client';

import { AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, ChevronRight, Info, Minus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Page } from '@/components/page';
import { Card, Empty, Skeleton } from '@/components/ui/card';
import { PERIOD_LABELS, change, entriesHref, monthLabel, type Analytics, type PeriodKey } from '@/lib/analytics';
import { compact, money } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { cn } from '@/lib/cn';

export default function Insights() {
  const [period, setPeriod] = useState<PeriodKey>('this_month');
  const { data: a, loading, error, reload } = useApi<Analytics>(`/v1/analytics?period=${period}`);
  const cur = a?.currency ?? 'INR';
  const range = a ? { from: a.period.from, to: a.period.to } : { from: '', to: '' };

  return (
    <Page title="Insights" back="/" onRefresh={reload}>
      {/* filters: one row, above everything they control */}
      <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Period">
        {PERIOD_LABELS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={period === key}
            onClick={() => setPeriod(key)}
            className={cn('min-h-10 shrink-0 rounded-full border px-4 text-sm', period === key ? 'border-brand bg-brand text-white' : 'border-line bg-card text-fg')}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <Card className="mb-3 text-sm text-red-600">Couldn't load your books: {error.message}</Card>}
      {loading && !a && <Skeleton className="h-96" />}
      {a && (
        <div className="space-y-4">
          <p className="text-xs text-muted">
            {a.period.label}: {a.period.from} → {a.period.to}, compared with {a.previous.label.toLowerCase()}. From your ERPNext books, so entries made directly in
            ERPNext are included.
          </p>
          {a.errors.length > 0 && (
            <Card className="border-amber-300 text-sm text-amber-900 dark:border-amber-800 dark:text-amber-100">
              <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" /> Some figures couldn't be read</p>
              <ul className="mt-1 list-disc ps-5 text-xs">{a.errors.map((e) => <li key={e}>{e}</li>)}</ul>
            </Card>
          )}

          {a.insights.length > 0 && (
            <Card className="space-y-3">
              <h2 className="font-semibold">What stands out</h2>
              {a.insights.map((i) => (
                <p key={i.text} className="flex gap-2 text-sm">
                  {i.tone === 'warn' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-label="Attention" /> : i.tone === 'good' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-label="Good" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-label="Note" />}
                  <span>{i.text}</span>
                </p>
              ))}
            </Card>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Kpi label="Income" value={a.kpis.income} prev={a.kpis.prev.income} cur={cur} goodWhenUp />
            <Kpi label="Expenses" value={a.kpis.expenses} prev={a.kpis.prev.expenses} cur={cur} />
            <Kpi label={a.kpis.profit >= 0 ? 'Profit' : 'Loss'} value={a.kpis.profit} prev={a.kpis.prev.profit} cur={cur} goodWhenUp />
            <Card>
              <p className="text-xs text-muted">Margin</p>
              <p className="mt-2 text-lg font-bold tabular-nums">{a.kpis.margin === null ? '—' : `${a.kpis.margin.toFixed(1)}%`}</p>
              <p className="mt-1 text-xs text-muted">Tax payable {compact(a.kpis.taxPayable, cur)}</p>
            </Card>
          </div>

          <TrendChart trend={a.trend} cur={cur} />

          {a.balances && (
            <Section title="Cash & bank" total={money(a.balances.cash + a.balances.bank, cur)}>
              {a.balances.accounts.map((b) => (
                <Row key={b.ledger} href={entriesHref({ account: b.ledger, from: a.trend[0] ? `${a.trend[0].month}-01` : range.from, to: range.to, title: b.account, cur })} label={b.account} sub={b.type} value={money(b.balance, cur)} />
              ))}
            </Section>
          )}

          <Section title="Where the money goes" total={money(a.kpis.expenses, cur)}>
            {a.expenseByAccount.length === 0 ? <Empty>No expenses in this period.</Empty> : (
              <Bars items={a.expenseByAccount.map((x) => ({ key: x.ledger, label: x.account, value: x.amount, sub: `was ${compact(x.prev, cur)}`, href: entriesHref({ account: x.ledger, ...range, title: x.account, cur }) }))} color="var(--viz-expense)" cur={cur} />
            )}
          </Section>

          <Section title="Who pays you" total={money(a.topCustomers.reduce((s, x) => s + x.amount, 0), cur)}>
            {a.topCustomers.length === 0 ? <Empty>No sales invoices in this period.</Empty> : (
              <Bars items={a.topCustomers.map((x) => ({ key: x.party, label: x.party, value: x.amount, sub: `${x.count} invoice${x.count === 1 ? '' : 's'}`, href: entriesHref({ party: x.party, ...range, title: x.party, cur }) }))} color="var(--viz-income)" cur={cur} />
            )}
          </Section>

          <AgeingCard title="Customers owe you" ageing={a.receivables} cur={cur} kind="customer" from={a.trend[0] ? `${a.trend[0].month}-01` : range.from} to={range.to} />
          <AgeingCard title="You owe suppliers" ageing={a.payables} cur={cur} kind="supplier" from={a.trend[0] ? `${a.trend[0].month}-01` : range.from} to={range.to} />

          {a.topSuppliers.length > 0 && (
            <Section title="Biggest suppliers" total={money(a.topSuppliers.reduce((s, x) => s + x.amount, 0), cur)}>
              {a.topSuppliers.map((x) => (
                <Row key={x.party} href={entriesHref({ party: x.party, ...range, title: x.party, cur })} label={x.party} sub={`${x.count} bill${x.count === 1 ? '' : 's'}`} value={money(x.amount, cur)} />
              ))}
            </Section>
          )}
        </div>
      )}
    </Page>
  );
}

function Kpi({ label, value, prev, cur, goodWhenUp = false }: { label: string; value: number; prev: number; cur: string; goodWhenUp?: boolean }) {
  const pc = change(value, prev);
  const up = pc !== null && pc > 0.5;
  const down = pc !== null && pc < -0.5;
  const good = (up && goodWhenUp) || (down && !goodWhenUp);
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;
  return (
    <Card>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-2 text-lg font-bold tabular-nums">{money(Math.abs(value), cur)}</p>
      <p className={cn('mt-1 flex items-center gap-1 text-xs', pc === null ? 'text-muted' : good ? 'text-emerald-700 dark:text-emerald-300' : up || down ? 'text-red-700 dark:text-red-300' : 'text-muted')}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {pc === null ? 'no earlier data' : `${Math.abs(pc).toFixed(0)}% ${up ? 'up' : down ? 'down' : 'same'}`}
      </p>
      <p className="text-xs text-muted">was {compact(Math.abs(prev), cur)}</p>
    </Card>
  );
}

function Section({ title, total, children }: { title: string; total?: string; children: React.ReactNode }) {
  return (
    <Card className="p-0">
      <div className="flex items-baseline justify-between px-4 pb-2 pt-4">
        <h2 className="font-semibold">{title}</h2>
        {total && <span className="text-sm font-medium tabular-nums text-muted">{total}</span>}
      </div>
      <div className="divide-y divide-line">{children}</div>
    </Card>
  );
}

function Row({ href, label, sub, value }: { href: string; label: string; sub?: string; value: string }) {
  return (
    <Link href={href} className="flex min-h-14 items-center gap-3 px-4 py-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {sub && <span className="block text-xs text-muted">{sub}</span>}
      </span>
      <span className="tabular-nums">{value}</span>
      <ChevronRight className="h-4 w-4 text-muted rtl:rotate-180" />
    </Link>
  );
}

/** Horizontal bars, one hue (magnitude), each row labelled and tappable to its ledger lines. */
function Bars({ items, color, cur }: { items: Array<{ key: string; label: string; value: number; sub?: string; href: string }>; color: string; cur: string }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <>
      {items.map((i) => (
        <Link key={i.key} href={i.href} className="block px-4 py-2.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate">{i.label}</span>
            <span className="shrink-0 tabular-nums">{money(i.value, cur)}</span>
          </div>
          <div className="mt-1.5 h-2 w-full rounded-full bg-line/60" aria-hidden="true">
            <div className="h-2 rounded-full" style={{ width: `${Math.max(2, (Math.max(0, i.value) / max) * 100)}%`, background: color }} />
          </div>
          {i.sub && <p className="mt-1 text-xs text-muted">{i.sub}</p>}
        </Link>
      ))}
    </>
  );
}

/** Income vs expenses per month: grouped bars on one axis, legend + tap-for-details (no hover on phones). */
function TrendChart({ trend, cur }: { trend: Analytics['trend']; cur: string }) {
  const [sel, setSel] = useState<number | null>(trend.length ? trend.length - 1 : null);
  if (trend.length === 0) return <Card><h2 className="font-semibold">Income vs expenses</h2><Empty>No entries in the last 6 months.</Empty></Card>;
  const W = 320;
  const H = 160;
  const top = 14;
  const bottom = 20;
  const left = 40; // gutter for the value axis labels
  const max = Math.max(...trend.flatMap((t) => [t.income, t.expenses]), 1);
  const step = (W - left) / trend.length;
  const bw = Math.min(16, step / 3);
  const y = (v: number) => top + (H - top - bottom) * (1 - Math.max(0, v) / max);
  const s = sel === null ? null : trend[sel];
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">Income vs expenses</h2>
        <div className="flex gap-3 text-xs text-muted">
          <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: 'var(--viz-income)' }} />Income</span>
          <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: 'var(--viz-expense)' }} />Expenses</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Monthly income and expenses">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={left} x2={W} y1={y(max * f)} y2={y(max * f)} stroke="rgb(var(--line))" strokeWidth="1" />
            <text x={left - 6} y={y(max * f) + 3} fontSize="9" textAnchor="end" fill="rgb(var(--muted))">{compact(max * f, cur)}</text>
          </g>
        ))}
        {trend.map((t, i) => {
          const cx = left + step * i + step / 2;
          return (
            <g key={t.month} onClick={() => setSel(i)} className="cursor-pointer">
              <rect x={left + step * i} y={0} width={step} height={H} fill={sel === i ? 'rgb(var(--line))' : 'transparent'} opacity={0.35} />
              <rect x={cx - bw - 1} y={y(t.income)} width={bw} height={Math.max(0, H - bottom - y(t.income))} rx={3} fill="var(--viz-income)">
                <title>{`${monthLabel(t.month)} income ${money(t.income, cur)}`}</title>
              </rect>
              <rect x={cx + 1} y={y(t.expenses)} width={bw} height={Math.max(0, H - bottom - y(t.expenses))} rx={3} fill="var(--viz-expense)">
                <title>{`${monthLabel(t.month)} expenses ${money(t.expenses, cur)}`}</title>
              </rect>
              <text x={cx} y={H - 6} fontSize="10" textAnchor="middle" fill="rgb(var(--muted))">{monthLabel(t.month)}</text>
            </g>
          );
        })}
      </svg>
      {s && (
        <div className="mt-2 grid grid-cols-3 gap-2 rounded-xl bg-bg p-2 text-center text-xs">
          <div><p className="text-muted">Income · {monthLabel(s.month)}{sel === trend.length - 1 && s.month === new Date().toISOString().slice(0, 7) ? ' so far' : ''}</p><p className="font-semibold tabular-nums">{compact(s.income, cur)}</p></div>
          <div><p className="text-muted">Expenses</p><p className="font-semibold tabular-nums">{compact(s.expenses, cur)}</p></div>
          <div><p className="text-muted">{s.profit >= 0 ? 'Profit' : 'Loss'}</p><p className="font-semibold tabular-nums">{compact(Math.abs(s.profit), cur)}</p></div>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">Tap a month for its numbers.</p>
    </Card>
  );
}

function AgeingCard({ title, ageing, cur, kind, from, to }: { title: string; ageing: Analytics['receivables']; cur: string; kind: 'customer' | 'supplier'; from: string; to: string }) {
  const max = Math.max(...ageing.buckets.map((b) => b.amount), 1);
  return (
    <Section title={title} total={money(ageing.total, cur)}>
      {ageing.total === 0 ? <Empty>Nothing outstanding.</Empty> : (
        <>
          <div className="px-4 pb-3">
            {ageing.overdue > 0 && <p className="mb-2 text-sm text-red-700 dark:text-red-300">{money(ageing.overdue, cur)} is past its due date</p>}
            <div className="space-y-1.5">
              {ageing.buckets.map((b) => (
                <div key={b.label} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-2 text-xs">
                  <span className="text-muted">{b.label}</span>
                  <div className="h-2 rounded-full bg-line/60" aria-hidden="true">
                    {b.amount > 0 && <div className="h-2 rounded-full" style={{ width: `${Math.max(3, (b.amount / max) * 100)}%`, background: kind === 'customer' ? 'var(--viz-income)' : 'var(--viz-expense)' }} />}
                  </div>
                  <span className="tabular-nums">{compact(b.amount, cur)}</span>
                </div>
              ))}
            </div>
          </div>
          {ageing.parties.map((p) => (
            <Row key={p.party} href={entriesHref({ party: p.party, from, to, title: p.party, cur })} label={p.party} sub={p.overdue > 0 ? `${compact(p.overdue, cur)} overdue · oldest ${p.oldestDays} days` : 'not due yet'} value={money(p.outstanding, cur)} />
          ))}
        </>
      )}
    </Section>
  );
}
