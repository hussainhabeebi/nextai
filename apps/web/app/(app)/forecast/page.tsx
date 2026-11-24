'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CashChart, type CashPoint } from '@/components/charts/cash-chart';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Badge, Card, Skeleton } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { api, type ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { compact, money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Forecast {
  openingBalance: number;
  horizonWeeks: number;
  weeks: Array<CashPoint & { inflows: { total: number }; outflows: { total: number } }>;
  totals: { inflows: number; outflows: number; closing: number };
  lowest: { amount: number; weekStart: string };
  cashOutWeek: string | null;
  belowBufferWeek: string | null;
  shortfallProbability: number;
  drivers: { collectionCycleDays: number; avgCustomerDelayDays: number; macro: { inflationPct: number; demandGrowthPct: number }; historyMonths: number };
  expectedCollections: Array<{ party: string; doc: string; amount: number; expectedDate: string; delayDays: number; probability: number }>;
  latePayers: Array<{ party: string; avgDelayDays: number; invoices: number; outstanding: number }>;
}
interface Sim {
  scenario: Forecast;
  delta: { closing: number; lowest: number; shortfallProbability: number };
}

const blank = { collectionDelayDays: 0, payablesDelayDays: 0, salesChangePct: 0, expenseChangePct: 0, defaulting: '', oneOffDate: '', oneOffAmount: '', oneOffLabel: '', monthly: '' };
const n = (v: string) => Number(v.replace(/[^\d.-]/g, '')) || 0;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

export default function ForecastPage() {
  const { me } = useAuth();
  const cur = me?.tenant.currency;
  const [refresh, setRefresh] = useState(0);
  const { data: f, error, loading } = useApi<Forecast>(`/v1/forecast${refresh ? `?refresh=true&r=${refresh}` : ''}`);
  const [w, setW] = useState(blank);
  const [sim, setSim] = useState<Sim | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  if ((error as ApiError | undefined)?.status === 402)
    return (
      <Page title="Cash forecast" back="/more">
        <Card className="space-y-3 text-center">
          <p>Cash forecasting is part of the Growth and Pro plans.</p>
          <Link href="/billing"><Button>Upgrade</Button></Link>
        </Card>
      </Page>
    );

  const run = async () => {
    setBusy(true);
    setMsg('');
    try {
      setSim(
        await api.post<Sim>('/v1/forecast/simulate', {
          collectionDelayDays: w.collectionDelayDays,
          payablesDelayDays: w.payablesDelayDays,
          salesChangePct: w.salesChangePct,
          expenseChangePct: w.expenseChangePct,
          defaultingCustomers: w.defaulting ? [w.defaulting] : [],
          oneOffs: w.oneOffDate && n(w.oneOffAmount) ? [{ date: w.oneOffDate, amount: n(w.oneOffAmount), label: w.oneOffLabel || 'One-off' }] : [],
          monthlyRecurring: n(w.monthly) ? [{ amount: n(w.monthly), label: 'Monthly change' }] : [],
        }),
      );
    } catch (e) {
      setMsg((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const parties = [...new Set([...(f?.latePayers.map((p) => p.party) ?? []), ...(f?.expectedCollections.map((c) => c.party) ?? [])])];
  const risk = f ? Math.round(f.shortfallProbability * 100) : 0;
  return (
    <Page title="Cash forecast" back="/more">
      {loading && !f && <Skeleton className="h-72" />}
      {f && (
        <>
          {f.cashOutWeek ? (
            <Card className="mb-3 flex gap-3 border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
              <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
              <p className="text-sm"><b>Cash may run out the week of {day(f.cashOutWeek)}.</b> Chase the collections below or try a what-if.</p>
            </Card>
          ) : f.belowBufferWeek ? (
            <Card className="mb-3 flex gap-3 border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
              <p className="text-sm">Cash dips below your buffer the week of {day(f.belowBufferWeek)}.</p>
            </Card>
          ) : null}

          <div className="mb-3 grid grid-cols-3 gap-2">
            <Card className="p-3"><p className="text-xs text-muted">Cash now</p><p className="font-semibold tabular-nums">{compact(f.openingBalance, cur)}</p></Card>
            <Card className="p-3"><p className="text-xs text-muted">In {f.horizonWeeks} weeks</p><p className="font-semibold tabular-nums">{compact(f.totals.closing, cur)}</p></Card>
            <Card className="p-3"><p className="text-xs text-muted">Shortfall risk</p><p className="flex items-center gap-1 font-semibold">{risk}% <Badge tone={risk >= 30 ? 'red' : risk >= 10 ? 'amber' : 'green'}>{risk >= 30 ? 'High' : risk >= 10 ? 'Watch' : 'Low'}</Badge></p></Card>
          </div>

          <Card className="mb-4">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-semibold">Projected cash balance</h2>
              <Button variant="ghost" size="icon" aria-label="Refresh from books" onClick={() => setRefresh(Date.now())}><RefreshCw className="h-4 w-4" /></Button>
            </div>
            <CashChart base={f.weeks} scenario={sim?.scenario.weeks} currency={cur} />
            <p className="mt-2 text-xs text-muted">
              Lowest {money(f.lowest.amount, cur)} (week of {day(f.lowest.weekStart)}). Learned from {f.drivers.historyMonths} months of history · customers pay ~{Math.round(f.drivers.avgCustomerDelayDays)} days after due · inflation {f.drivers.macro.inflationPct}% · demand growth {f.drivers.macro.demandGrowthPct}%.
            </p>
          </Card>

          <Card className="mb-4 space-y-3">
            <h2 className="font-semibold">What if…</h2>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Customers pay later (days)"><Input inputMode="numeric" value={String(w.collectionDelayDays)} onChange={(e) => setW({ ...w, collectionDelayDays: Math.round(n(e.target.value)) })} /></Field>
              <Field label="We pay suppliers later (days)"><Input inputMode="numeric" value={String(w.payablesDelayDays)} onChange={(e) => setW({ ...w, payablesDelayDays: Math.round(n(e.target.value)) })} /></Field>
              <Field label="Sales change (%)"><Input inputMode="numeric" value={String(w.salesChangePct)} onChange={(e) => setW({ ...w, salesChangePct: n(e.target.value) })} /></Field>
              <Field label="Expenses change (%)"><Input inputMode="numeric" value={String(w.expenseChangePct)} onChange={(e) => setW({ ...w, expenseChangePct: n(e.target.value) })} /></Field>
            </div>
            <Field label="A customer never pays">
              <Select value={w.defaulting} onChange={(e) => setW({ ...w, defaulting: e.target.value })}>
                <option value="">— nobody —</option>
                {parties.map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </Field>
            <Field label="One-off (+ loan / − purchase)">
              <div className="grid grid-cols-3 gap-2">
                <Input type="date" value={w.oneOffDate} onChange={(e) => setW({ ...w, oneOffDate: e.target.value })} />
                <Input inputMode="decimal" placeholder="-50000" value={w.oneOffAmount} onChange={(e) => setW({ ...w, oneOffAmount: e.target.value })} />
                <Input placeholder="Label" value={w.oneOffLabel} onChange={(e) => setW({ ...w, oneOffLabel: e.target.value })} />
              </div>
            </Field>
            <Field label="Every month (+ / −)" hint="e.g. −15000 for a new hire"><Input inputMode="decimal" value={w.monthly} onChange={(e) => setW({ ...w, monthly: e.target.value })} /></Field>
            <div className="flex gap-2">
              <Button onClick={() => void run()} disabled={busy}>{busy ? 'Running…' : 'Run scenario'}</Button>
              {sim && <Button variant="secondary" onClick={() => { setSim(null); setW(blank); }}>Reset</Button>}
            </div>
            {msg && <p role="status" className="text-sm text-red-600">{msg}</p>}
            {sim && (
              <p role="status" className="text-sm">
                Change vs base: end balance {sim.delta.closing >= 0 ? '+' : '−'}{money(Math.abs(sim.delta.closing), cur)} · lowest point {sim.delta.lowest >= 0 ? '+' : '−'}{money(Math.abs(sim.delta.lowest), cur)} · shortfall risk {Math.round(sim.scenario.shortfallProbability * 100)}%
                {sim.scenario.cashOutWeek ? ` · runs out week of ${day(sim.scenario.cashOutWeek)}` : ''}
              </p>
            )}
          </Card>

          {f.expectedCollections.length > 0 && (
            <Card className="mb-4">
              <h2 className="mb-2 font-semibold">Expected collections</h2>
              <ul className="divide-y divide-line text-sm">
                {f.expectedCollections.map((c) => (
                  <li key={c.doc} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="block truncate">{c.party}</span>
                      <span className="text-xs text-muted">{c.doc} · expected {day(c.expectedDate)}{c.delayDays > 0 ? ` (~${c.delayDays}d late)` : ''}</span>
                    </span>
                    <span className="text-end tabular-nums">{money(c.amount, cur)}{c.probability < 0.9 && <span className="block text-xs text-muted">{Math.round(c.probability * 100)}% likely</span>}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {f.latePayers.length > 0 && (
            <Card>
              <h2 className="mb-2 font-semibold">Slow payers</h2>
              <ul className="divide-y divide-line text-sm">
                {f.latePayers.map((p) => (
                  <li key={p.party} className="flex justify-between py-2">
                    <span>{p.party} <span className="text-muted">~{p.avgDelayDays} days late</span></span>
                    <span className="tabular-nums">{money(p.outstanding, cur)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </Page>
  );
}
