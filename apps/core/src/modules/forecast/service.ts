import { formatMoney, tenantSettingsSchema, type Currency, type ForecastScenario } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Container } from '../../container.js';
import { erpContext } from '../erpnext/mappers.js';
import { isoDay, listAll } from '../erpnext/fetch.js';
import { forecast, learnBehaviour, type Forecast, type ForecastInputs, type MonthFlows, type OpenItem } from './engine.js';

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
const day = (v: unknown) => String(v ?? '').slice(0, 10);
const CACHE_TTL = 3600;
const cacheKey = (tenantId: string) => `forecast:inputs:${tenantId}`;

/** Macro defaults (annual %): CPI inflation and nominal demand growth. Tenants override in settings.forecast. */
export const MACRO_DEFAULTS: Record<'IN' | 'AE', { inflationPct: number; demandGrowthPct: number }> = {
  IN: { inflationPct: 4.5, demandGrowthPct: 6 },
  AE: { inflationPct: 2.5, demandGrowthPct: 4 },
};

const monthsBack = (n: number) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  return isoDay(d);
};

/** Pull everything the forecast needs from ERPNext (one pass; cached for an hour). */
export async function loadForecastInputs(c: Container, tenant: Tenant): Promise<ForecastInputs> {
  const erp = c.erp(tenant);
  const { company } = erpContext(tenant);
  const settings = tenantSettingsSchema.parse(tenant.settings ?? {});
  const from = monthsBack(24);
  const co: [string, string, unknown] = ['company', '=', company];
  const sub: [string, string, unknown] = ['docstatus', '=', 1];
  const since: [string, string, unknown] = ['posting_date', '>=', from];
  const [bal, openSi, openPi, si, pi, pe, je] = await Promise.all([
    erp.getBalances(company),
    listAll<Row>(erp, 'Sales Invoice', { filters: [co, sub, ['outstanding_amount', '>', 0]], fields: ['name', 'customer', 'posting_date', 'due_date', 'outstanding_amount'] }),
    listAll<Row>(erp, 'Purchase Invoice', { filters: [co, sub, ['outstanding_amount', '>', 0]], fields: ['name', 'supplier', 'posting_date', 'due_date', 'outstanding_amount'] }),
    listAll<Row>(erp, 'Sales Invoice', { filters: [co, sub, since], fields: ['name', 'customer', 'posting_date', 'due_date', 'grand_total', 'is_return'] }),
    listAll<Row>(erp, 'Purchase Invoice', { filters: [co, sub, since], fields: ['name', 'supplier', 'posting_date', 'due_date', 'grand_total', 'is_paid', 'is_return'] }),
    listAll<Row>(erp, 'Payment Entry', { filters: [co, sub, since], fields: ['name', 'payment_type', 'party_type', 'party', 'posting_date', 'paid_amount', 'received_amount'] }),
    listAll<Row>(erp, 'Journal Entry', { filters: [co, sub, since, ['voucher_type', 'in', ['Cash Entry', 'Bank Entry']]], fields: ['name', 'posting_date', 'total_debit', 'accounts'] }),
  ]);
  const open = (rows: Row[], partyField: string): OpenItem[] =>
    rows.map((r) => ({ doc: String(r.name), party: String(r[partyField] ?? 'Unknown'), postingDate: day(r.posting_date), dueDate: day(r.due_date || r.posting_date), outstanding: num(r.outstanding_amount) })).filter((r) => r.outstanding > 0);

  const receipts = pe.rows.filter((p) => p.payment_type === 'Receive').map((p) => ({ party: String(p.party ?? ''), date: day(p.posting_date), amount: num(p.received_amount) || num(p.paid_amount) }));
  const payments = pe.rows.filter((p) => p.payment_type === 'Pay').map((p) => ({ party: String(p.party ?? ''), date: day(p.posting_date), amount: num(p.paid_amount) }));
  const inv = (rows: Row[], partyField: string) =>
    rows.filter((r) => !num(r.is_return) && !num(r.is_paid)).map((r) => ({ party: String(r[partyField] ?? ''), postingDate: day(r.posting_date), dueDate: day(r.due_date || r.posting_date), amount: num(r.grand_total) }));
  const cust = learnBehaviour(inv(si.rows, 'customer'), receipts);
  const supp = learnBehaviour(inv(pi.rows, 'supplier'), payments);

  // monthly cash history (last 24 complete-or-current months)
  const months = new Map<string, MonthFlows>();
  const at = (date: string) => {
    const m = date.slice(0, 7);
    let row = months.get(m);
    if (!row) months.set(m, (row = { month: m, inInvoiced: 0, inDirect: 0, outInvoiced: 0, outDirect: 0 }));
    return row;
  };
  for (const r of receipts) at(r.date).inInvoiced += r.amount;
  for (const p of payments) at(p.date).outInvoiced += p.amount;
  for (const p of pi.rows.filter((r) => num(r.is_paid))) at(day(p.posting_date)).outDirect += num(p.grand_total);
  for (const j of je.rows) {
    const debit = num(j.total_debit) || (Array.isArray(j.accounts) ? (j.accounts as Row[]).reduce((s, a) => s + num(a.debit_in_account_currency), 0) : 0);
    at(day(j.posting_date)).outDirect += debit;
  }
  const currentMonth = isoDay(new Date()).slice(0, 7);
  // drop the current partial month from run-rate history (it would understate the level)
  const history = [...months.values()].filter((m) => m.month < currentMonth).sort((a, b) => a.month.localeCompare(b.month)).slice(-24);

  const macro = { ...MACRO_DEFAULTS[tenant.country], ...(settings.forecast.inflationPct !== undefined ? { inflationPct: settings.forecast.inflationPct } : {}), ...(settings.forecast.demandGrowthPct !== undefined ? { demandGrowthPct: settings.forecast.demandGrowthPct } : {}) };
  const today = isoDay(new Date());
  return {
    today,
    currency: tenant.currency,
    openingBalance: bal.cash + bal.bank,
    receivables: open(openSi.rows, 'customer'),
    payables: open(openPi.rows, 'supplier'),
    customers: cust.byParty,
    supplierDelay: supp.overall,
    collectionCycleDays: cust.cycleDays,
    paymentCycleDays: supp.cycleDays,
    history,
    macro,
    minCashBuffer: settings.forecast.minCashBuffer,
    seed: Number.parseInt(createHash('sha256').update(`${tenant.id}:${today}`).digest('hex').slice(0, 8), 16),
  };
}

export async function forecastInputs(c: Container, tenant: Tenant, refresh = false): Promise<ForecastInputs> {
  if (!refresh) {
    const hit = await c.redis.get(cacheKey(tenant.id));
    if (hit) {
      const parsed = JSON.parse(hit) as ForecastInputs;
      if (parsed.today === isoDay(new Date())) return parsed;
    }
  }
  const inputs = await loadForecastInputs(c, tenant);
  await c.redis.set(cacheKey(tenant.id), JSON.stringify(inputs), 'EX', CACHE_TTL);
  return inputs;
}

/** Cached-only base forecast for cheap callers (dashboard alerts); never calls ERPNext. */
export async function cachedForecast(c: Container, tenant: Tenant): Promise<Forecast | undefined> {
  const hit = await c.redis.get(cacheKey(tenant.id));
  return hit ? forecast(JSON.parse(hit) as ForecastInputs, undefined, 0) : undefined;
}

export async function baseForecast(c: Container, tenant: Tenant, refresh = false): Promise<Forecast> {
  return forecast(await forecastInputs(c, tenant, refresh));
}

/** Base vs scenario on identical inputs, with the deltas that matter. */
export async function simulate(c: Container, tenant: Tenant, scenario: ForecastScenario) {
  const inputs = await forecastInputs(c, tenant);
  const base = forecast(inputs);
  const what = forecast(inputs, scenario);
  return {
    base,
    scenario: what,
    delta: {
      closing: Math.round((what.totals.closing - base.totals.closing) * 100) / 100,
      lowest: Math.round((what.lowest.amount - base.lowest.amount) * 100) / 100,
      shortfallProbability: Math.round((what.shortfallProbability - base.shortfallProbability) * 100) / 100,
      cashOutWeek: { base: base.cashOutWeek, scenario: what.cashOutWeek },
    },
  };
}

/** WhatsApp-length summary. */
export async function forecastSummary(c: Container, tenant: Tenant): Promise<string> {
  const cur = tenant.currency as Currency;
  try {
    const f = await baseForecast(c, tenant);
    const lines = [
      `💰 Cash forecast (next ${f.horizonWeeks} weeks)`,
      `Now: ${formatMoney(f.openingBalance, cur)} → ${formatMoney(f.totals.closing, cur)}`,
      `Lowest: ${formatMoney(f.lowest.amount, cur)} (week of ${f.lowest.weekStart})`,
    ];
    if (f.cashOutWeek) lines.push(`⚠️ Cash may run out the week of ${f.cashOutWeek} (${Math.round(f.shortfallProbability * 100)}% risk).`);
    else if (f.shortfallProbability >= 0.1) lines.push(`⚠️ ${Math.round(f.shortfallProbability * 100)}% chance of a shortfall.`);
    if (f.latePayers[0]) lines.push(`Slowest payer: ${f.latePayers[0].party} (~${f.latePayers[0].avgDelayDays} days late).`);
    lines.push('Try what-ifs in the NextAi app → Cash forecast.');
    return lines.join('\n');
  } catch {
    return 'Your books are busy right now. Please try again in a few minutes.';
  }
}
