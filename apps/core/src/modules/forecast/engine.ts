import { round2, type ForecastScenario } from '@nextai/shared';
import { addDays, daysBetween } from '../erpnext/fetch.js';

/**
 * 13-week cash-flow forecast. Pure and deterministic (seeded Monte Carlo) so a forecast can be
 * reproduced from its inputs, and what-if scenarios are compared against the same baseline.
 *
 * Cash = opening balance
 *      + open receivables, each at due date + that customer's learned payment delay, weighted by
 *        an ageing-based probability of collection
 *      − open payables at due date + our own typical payment delay
 *      + run-rate flows for business not yet invoiced (history × seasonality × macro), ramped in
 *        after the typical collection/payment cycle so they do not double count open AR/AP.
 */

export interface OpenItem {
  doc: string;
  party: string;
  postingDate: string;
  dueDate: string;
  outstanding: number;
}

export interface PaymentBehaviour {
  avgDelay: number; // days after due date (negative = early)
  sdDelay: number;
  samples: number;
  /** Share of historical collections from this party (0..1); used when a customer defaults. */
  share: number;
}

export interface MonthFlows {
  month: string; // YYYY-MM
  inInvoiced: number; // customer receipts
  inDirect: number; // cash sales / other receipts
  outInvoiced: number; // supplier payments
  outDirect: number; // expenses paid directly (journal entries, paid bills)
}

export interface ForecastInputs {
  today: string;
  currency: string;
  openingBalance: number;
  receivables: OpenItem[];
  payables: OpenItem[];
  customers: Record<string, PaymentBehaviour>;
  supplierDelay: { avgDelay: number; sdDelay: number; samples: number };
  /** Typical days from invoice to cash (DSO-like) and bill to payment (DPO-like). */
  collectionCycleDays: number;
  paymentCycleDays: number;
  history: MonthFlows[];
  macro: { inflationPct: number; demandGrowthPct: number };
  minCashBuffer: number;
  horizonWeeks?: number;
  seed?: number;
}

export interface WeekRow {
  weekStart: string;
  weekEnd: string;
  inflows: { receivables: number; runRate: number; oneOff: number; total: number };
  outflows: { payables: number; runRate: number; oneOff: number; total: number };
  net: number;
  closing: number;
  p10: number;
  p90: number;
}

export interface Forecast {
  today: string;
  currency: string;
  openingBalance: number;
  horizonWeeks: number;
  weeks: WeekRow[];
  totals: { inflows: number; outflows: number; net: number; closing: number };
  lowest: { amount: number; weekStart: string };
  /** First week the base case goes below zero, null if never within the horizon. */
  cashOutWeek: string | null;
  belowBufferWeek: string | null;
  /** Probability (0..1) that cash goes negative at some point in the horizon (Monte Carlo). */
  shortfallProbability: number;
  drivers: {
    collectionCycleDays: number;
    paymentCycleDays: number;
    avgCustomerDelayDays: number;
    seasonality: number[];
    macro: { inflationPct: number; demandGrowthPct: number };
    historyMonths: number;
    weeklyRunRate: { inflow: number; outflow: number };
  };
  expectedCollections: Array<{ party: string; doc: string; amount: number; expectedDate: string; delayDays: number; probability: number }>;
  latePayers: Array<{ party: string; avgDelayDays: number; invoices: number; outstanding: number }>;
  scenario?: ForecastScenario;
}

/** Probability of collecting an invoice given how overdue it is today. */
export function collectionProbability(daysOverdue: number): number {
  if (daysOverdue <= 90) return 0.97;
  if (daysOverdue <= 180) return 0.8;
  if (daysOverdue <= 365) return 0.5;
  return 0.15;
}

/** Monthly seasonal index (Jan..Dec), only when a full year of history exists; clamped to [0.5, 2]. */
export function seasonality(history: MonthFlows[], pick: (m: MonthFlows) => number): number[] {
  const flat = Array(12).fill(1) as number[];
  if (history.length < 12) return flat;
  const vals = history.map(pick);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (mean <= 0) return flat;
  const byMonth: number[][] = Array.from({ length: 12 }, () => []);
  history.forEach((h, i) => byMonth[Number(h.month.slice(5, 7)) - 1]!.push(vals[i]!));
  return byMonth.map((xs) => (xs.length ? Math.min(2, Math.max(0.5, xs.reduce((a, b) => a + b, 0) / xs.length / mean)) : 1));
}

/**
 * Learn payment behaviour by matching payments to invoices first-in-first-out per party:
 * the date each invoice is fully covered vs its due date is that invoice's delay.
 */
export function learnBehaviour(
  invoices: Array<{ party: string; postingDate: string; dueDate: string; amount: number }>,
  payments: Array<{ party: string; date: string; amount: number }>,
): { byParty: Record<string, PaymentBehaviour>; overall: { avgDelay: number; sdDelay: number; samples: number }; cycleDays: number } {
  const delays: Record<string, number[]> = {};
  const cycles: number[] = [];
  const paidBy: Record<string, number> = {};
  const parties = new Set([...invoices.map((i) => i.party), ...payments.map((p) => p.party)]);
  for (const party of parties) {
    const inv = invoices.filter((i) => i.party === party).sort((a, b) => a.postingDate.localeCompare(b.postingDate));
    const pay = payments.filter((p) => p.party === party).sort((a, b) => a.date.localeCompare(b.date));
    paidBy[party] = pay.reduce((s, p) => s + p.amount, 0);
    let pi = 0;
    let left = pay[0]?.amount ?? 0;
    for (const i of inv) {
      let need = i.amount;
      while (need > 0.005 && pi < pay.length) {
        const take = Math.min(need, left);
        need -= take;
        left -= take;
        if (need <= 0.005) {
          (delays[party] ??= []).push(daysBetween(i.dueDate, pay[pi]!.date));
          cycles.push(daysBetween(i.postingDate, pay[pi]!.date));
        }
        if (left <= 0.005) {
          pi++;
          left = pay[pi]?.amount ?? 0;
        }
      }
      if (need > 0.005) break; // remaining invoices still open
    }
  }
  const stats = (xs: number[]) => {
    const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - avg) ** 2, 0) / Math.max(1, xs.length - 1));
    return { avgDelay: round2(avg), sdDelay: round2(Math.max(2, sd)), samples: xs.length };
  };
  const total = Object.values(paidBy).reduce((a, b) => a + b, 0) || 1;
  const byParty: Record<string, PaymentBehaviour> = {};
  for (const party of parties) {
    const d = delays[party];
    byParty[party] = { ...(d?.length ? stats(d) : { avgDelay: 0, sdDelay: 7, samples: 0 }), share: round2((paidBy[party] ?? 0) / total) };
  }
  const all = Object.values(delays).flat();
  const cyc = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : 30;
  return { byParty, overall: all.length ? stats(all) : { avgDelay: 0, sdDelay: 7, samples: 0 }, cycleDays: Math.max(0, Math.round(cyc)) };
}

// --- seeded PRNG (mulberry32) + Box-Muller, so Monte Carlo is reproducible
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(1e-12, next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return { next, normal };
}

const WEEKLY = 12 / 52;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const cv = (xs: number[]) => {
  const m = mean(xs);
  if (xs.length < 3 || m <= 0) return 0.25;
  return Math.min(1, Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) / m);
};

export function forecast(inputs: ForecastInputs, scenario?: ForecastScenario, sims = 500): Forecast {
  const H = inputs.horizonWeeks ?? 13;
  const s: ForecastScenario = scenario ?? {
    collectionDelayDays: 0,
    payablesDelayDays: 0,
    salesChangePct: 0,
    expenseChangePct: 0,
    defaultingCustomers: [],
    oneOffs: [],
    monthlyRecurring: [],
  };
  const today = inputs.today;
  const weekStarts = Array.from({ length: H }, (_, w) => addDays(today, w * 7));
  const weekOf = (date: string) => {
    const d = daysBetween(today, date);
    return d < 0 ? 0 : Math.floor(d / 7);
  };
  const defaulting = new Set(s.defaultingCustomers.map((p) => p.toLowerCase()));

  // ---- run-rate levels from the last 6 months
  const recent = inputs.history.slice(-6);
  const level = {
    inInvoiced: mean(recent.map((h) => h.inInvoiced)) * WEEKLY,
    inDirect: mean(recent.map((h) => h.inDirect)) * WEEKLY,
    outInvoiced: mean(recent.map((h) => h.outInvoiced)) * WEEKLY,
    outDirect: mean(recent.map((h) => h.outDirect)) * WEEKLY,
  };
  const lostShare = Object.entries(inputs.customers)
    .filter(([p]) => defaulting.has(p.toLowerCase()))
    .reduce((a, [, b]) => a + b.share, 0);
  const seasonIn = seasonality(inputs.history, (h) => h.inInvoiced + h.inDirect);
  const seasonOut = seasonality(inputs.history, (h) => h.outInvoiced + h.outDirect);
  const volIn = cv(inputs.history.map((h) => h.inInvoiced + h.inDirect));
  const volOut = cv(inputs.history.map((h) => h.outInvoiced + h.outDirect));
  const salesF = (1 + s.salesChangePct / 100) * (1 - Math.min(1, lostShare));
  const expF = 1 + s.expenseChangePct / 100;
  const growth = (w: number) => (1 + inputs.macro.demandGrowthPct / 100) ** (w / 52);
  const inflation = (w: number) => (1 + inputs.macro.inflationPct / 100) ** (w / 52);
  // fraction of a week's invoiced flows that come from invoices not yet raised
  const ramp = (w: number, cycle: number) => (cycle <= 0 ? 1 : Math.min(1, Math.max(0, (w * 7 + 3.5) / cycle)));
  const collectCycle = inputs.collectionCycleDays + s.collectionDelayDays;
  const payCycle = inputs.paymentCycleDays + s.payablesDelayDays;

  const runIn = (w: number) => {
    const m = Number(weekStarts[w]!.slice(5, 7)) - 1;
    return (level.inInvoiced * ramp(w, collectCycle) + level.inDirect) * seasonIn[m]! * growth(w) * salesF;
  };
  const runOut = (w: number) => {
    const m = Number(weekStarts[w]!.slice(5, 7)) - 1;
    return (level.outInvoiced * ramp(w, payCycle) + level.outDirect) * seasonOut[m]! * inflation(w) * expF;
  };

  // ---- open receivables
  const overall = Object.values(inputs.customers);
  const avgDelay = overall.length ? mean(overall.filter((b) => b.samples).map((b) => b.avgDelay)) || 0 : 0;
  const receivables = inputs.receivables.map((r) => {
    const b = inputs.customers[r.party];
    const delay = (b?.samples ? b.avgDelay : avgDelay) + s.collectionDelayDays;
    const sd = b?.sdDelay ?? 10;
    const overdue = daysBetween(r.dueDate, today);
    const probability = defaulting.has(r.party.toLowerCase()) ? 0 : collectionProbability(overdue);
    let expected = addDays(r.dueDate, Math.round(delay));
    // already later than this customer usually pays → expect it soon, not in the past
    if (expected <= today) expected = addDays(today, Math.max(3, Math.round(Math.min(sd, 21))) + Math.max(0, s.collectionDelayDays));
    return { ...r, delay, sd, probability, expected };
  });
  const payables = inputs.payables.map((p) => {
    let expected = addDays(p.dueDate, Math.round(inputs.supplierDelay.avgDelay + s.payablesDelayDays));
    if (expected <= today) expected = addDays(today, 3 + Math.max(0, s.payablesDelayDays));
    return { ...p, expected };
  });

  const recurring = (w: number) =>
    s.monthlyRecurring.filter((r) => !r.startDate || r.startDate <= addDays(weekStarts[w]!, 6)).reduce((a, r) => a + r.amount * WEEKLY, 0);
  const oneOff = (w: number, sign: 1 | -1) =>
    s.oneOffs.filter((o) => (sign > 0 ? o.amount > 0 : o.amount < 0) && o.date >= today && weekOf(o.date) === w).reduce((a, o) => a + Math.abs(o.amount), 0);

  // ---- deterministic base (expected values)
  const weeks: WeekRow[] = [];
  let bal = inputs.openingBalance;
  for (let w = 0; w < H; w++) {
    const rec = receivables.filter((r) => weekOf(r.expected) === w).reduce((a, r) => a + r.outstanding * r.probability, 0);
    const pay = payables.filter((p) => weekOf(p.expected) === w).reduce((a, p) => a + p.outstanding, 0);
    const rIn = runIn(w);
    const rOut = runOut(w);
    const rec2 = recurring(w);
    const inflows = { receivables: rec, runRate: rIn + Math.max(0, rec2), oneOff: oneOff(w, 1), total: 0 };
    const outflows = { payables: pay, runRate: rOut + Math.max(0, -rec2), oneOff: oneOff(w, -1), total: 0 };
    inflows.total = inflows.receivables + inflows.runRate + inflows.oneOff;
    outflows.total = outflows.payables + outflows.runRate + outflows.oneOff;
    bal += inflows.total - outflows.total;
    const r = (o: typeof inflows) => ({ receivables: round2(o.receivables), runRate: round2(o.runRate), oneOff: round2(o.oneOff), total: round2(o.total) });
    weeks.push({ weekStart: weekStarts[w]!, weekEnd: addDays(weekStarts[w]!, 6), inflows: r(inflows), outflows: { payables: round2(outflows.payables), runRate: round2(outflows.runRate), oneOff: round2(outflows.oneOff), total: round2(outflows.total) }, net: round2(inflows.total - outflows.total), closing: round2(bal), p10: 0, p90: 0 });
  }

  // ---- Monte Carlo bands: collection timing/default per invoice, run-rate volatility
  const rand = rng(inputs.seed ?? 42);
  const paths: number[][] = Array.from({ length: H }, () => []);
  let short = 0;
  for (let k = 0; k < sims; k++) {
    const flows = Array(H).fill(0) as number[];
    for (const r of receivables) {
      if (rand.next() > r.probability) continue;
      const d = Math.round(r.delay + rand.normal() * r.sd);
      let date = addDays(r.dueDate, d);
      if (date <= today) date = addDays(today, 3 + Math.floor(rand.next() * 14) + Math.max(0, s.collectionDelayDays));
      const w = weekOf(date);
      if (w < H) flows[w]! += r.outstanding;
    }
    for (const p of payables) {
      const w = weekOf(p.expected);
      if (w < H) flows[w]! -= p.outstanding;
    }
    let b = inputs.openingBalance;
    let wentNegative = false;
    for (let w = 0; w < H; w++) {
      const shockIn = Math.max(0, 1 + rand.normal() * volIn);
      const shockOut = Math.max(0, 1 + rand.normal() * volOut);
      b += flows[w]! + runIn(w) * shockIn - runOut(w) * shockOut + recurring(w) + oneOff(w, 1) - oneOff(w, -1);
      paths[w]!.push(b);
      if (b < 0) wentNegative = true;
    }
    if (wentNegative) short++;
  }
  const pct = (xs: number[], q: number) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] ?? 0;
  };
  weeks.forEach((wk, w) => {
    wk.p10 = round2(sims ? pct(paths[w]!, 0.1) : wk.closing);
    wk.p90 = round2(sims ? pct(paths[w]!, 0.9) : wk.closing);
  });

  const lowest = weeks.reduce((m, w) => (w.closing < m.amount ? { amount: w.closing, weekStart: w.weekStart } : m), { amount: inputs.openingBalance, weekStart: today });
  const late = Object.entries(inputs.customers)
    .filter(([, b]) => b.samples >= 2 && b.avgDelay > 7)
    .map(([party, b]) => ({ party, avgDelayDays: Math.round(b.avgDelay), invoices: b.samples, outstanding: round2(inputs.receivables.filter((r) => r.party === party).reduce((a, r) => a + r.outstanding, 0)) }))
    .sort((a, b) => b.outstanding - a.outstanding || b.avgDelayDays - a.avgDelayDays)
    .slice(0, 8);
  const totIn = weeks.reduce((a, w) => a + w.inflows.total, 0);
  const totOut = weeks.reduce((a, w) => a + w.outflows.total, 0);
  return {
    today,
    currency: inputs.currency,
    openingBalance: round2(inputs.openingBalance),
    horizonWeeks: H,
    weeks,
    totals: { inflows: round2(totIn), outflows: round2(totOut), net: round2(totIn - totOut), closing: weeks.at(-1)?.closing ?? round2(inputs.openingBalance) },
    lowest,
    cashOutWeek: weeks.find((w) => w.closing < 0)?.weekStart ?? null,
    belowBufferWeek: weeks.find((w) => w.closing < inputs.minCashBuffer)?.weekStart ?? null,
    shortfallProbability: sims ? round2(short / sims) : weeks.some((w) => w.closing < 0) ? 1 : 0,
    drivers: {
      collectionCycleDays: inputs.collectionCycleDays,
      paymentCycleDays: inputs.paymentCycleDays,
      avgCustomerDelayDays: round2(avgDelay),
      seasonality: seasonIn.map(round2),
      macro: inputs.macro,
      historyMonths: inputs.history.length,
      weeklyRunRate: { inflow: round2(level.inInvoiced + level.inDirect), outflow: round2(level.outInvoiced + level.outDirect) },
    },
    expectedCollections: receivables
      .filter((r) => r.probability > 0 && weekOf(r.expected) < H)
      .sort((a, b) => b.outstanding - a.outstanding)
      .slice(0, 10)
      .map((r) => ({ party: r.party, doc: r.doc, amount: round2(r.outstanding), expectedDate: r.expected, delayDays: Math.round(r.delay), probability: r.probability })),
    latePayers: late,
    ...(scenario ? { scenario } : {}),
  };
}
