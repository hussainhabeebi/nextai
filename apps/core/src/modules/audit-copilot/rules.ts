import { isValidTaxId, round2, type AuditPolicy, type Country, type Currency } from '@nextai/shared';
import { createHash } from 'node:crypto';
import { daysBetween } from '../erpnext/fetch.js';

/**
 * Full-population audit tests. Every function here is pure: the same transactions and policy
 * always produce the same findings, so a run can be re-performed from its stored evidence.
 */

export type AuditDoctype = 'Purchase Invoice' | 'Sales Invoice' | 'Payment Entry' | 'Journal Entry';

export interface AuditTxn {
  doctype: AuditDoctype;
  name: string;
  date: string; // posting date YYYY-MM-DD
  amount: number; // absolute document value
  direction: 'in' | 'out';
  party?: string;
  partyType?: 'Customer' | 'Supplier';
  billNo?: string;
  /** "cash" when settled in cash, "bank" otherwise, undefined when on credit. */
  mode?: 'cash' | 'bank';
  taxId?: string;
  taxAmount?: number;
  isReturn?: boolean;
  owner?: string;
  creation?: string;
  remarks?: string;
  /** docstatus 2 rows are fetched only for invoice-sequence testing. */
  cancelled?: boolean;
}

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface RawFinding {
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  amount?: number;
  txns: AuditTxn[];
  observed: Record<string, unknown>;
}

export interface RuleContext {
  country: Country;
  currency: Currency;
  policy: ResolvedPolicy;
  /** Supplier name → creation date (for new-vendor tests). */
  supplierSince?: Record<string, string>;
}

export interface ResolvedPolicy {
  maxCashPayment?: number;
  maxCashReceiptPerDay?: number;
  approvalThreshold: number;
  taxIdRequiredAbove?: number;
  outlierZ: number;
  duplicateWindowDays: number;
  flagWeekends: boolean;
}

export const RULE_VERSION = '2026.11.1';

/** Statutory defaults: India Income-tax Act Sec 40A(3) (₹10,000 cash payment per person per day) and Sec 269ST (₹2 lakh cash receipt). */
export function resolvePolicy(p: AuditPolicy, country: Country, currency: Currency): ResolvedPolicy {
  const inr = country === 'IN';
  return {
    maxCashPayment: p.maxCashPayment ?? (inr ? 10_000 : undefined),
    maxCashReceiptPerDay: p.maxCashReceiptPerDay ?? (inr ? 200_000 : undefined),
    approvalThreshold: p.approvalThreshold ?? (currency === 'INR' ? 100_000 : currency === 'AED' ? 5_000 : 1_500),
    taxIdRequiredAbove: p.taxIdRequiredAbove ?? (currency === 'INR' ? 50_000 : currency === 'AED' ? 10_000 : undefined),
    outlierZ: p.outlierZ,
    duplicateWindowDays: p.duplicateWindowDays,
    flagWeekends: p.flagWeekends,
  };
}

const norm = (s?: string) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const groupBy = <T>(xs: T[], key: (x: T) => string | undefined): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (k === undefined) continue;
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return m;
};
const sum = (xs: AuditTxn[]) => round2(xs.reduce((s, x) => s + x.amount, 0));

export const fingerprint = (rule: string, txns: Array<{ doctype: string; name: string }>): string =>
  createHash('sha256')
    .update(`${rule}|${txns.map((t) => `${t.doctype}:${t.name}`).sort().join(',')}`)
    .digest('hex');

// ---------------------------------------------------------------- duplicates

/** Same supplier + same bill number posted more than once: the classic duplicate payment. */
export function duplicateBills(txns: AuditTxn[]): RawFinding[] {
  const pis = txns.filter((t) => t.doctype === 'Purchase Invoice' && !t.isReturn && norm(t.billNo));
  return [...groupBy(pis, (t) => `${t.party}|${norm(t.billNo)}`).values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      rule: 'duplicate_bill',
      severity: 'critical' as const,
      title: `Bill ${g[0]!.billNo} from ${g[0]!.party} booked ${g.length} times`,
      detail: `The same supplier bill number appears on ${g.map((x) => x.name).join(', ')}. Only one should be payable.`,
      amount: round2(sum(g) - g[0]!.amount),
      txns: g,
      observed: { billNo: g[0]!.billNo, party: g[0]!.party, count: g.length, amounts: g.map((x) => x.amount) },
    }));
}

/** Same party, same amount, same document type within N days (excluding pairs already caught by bill number). */
export function nearDuplicates(txns: AuditTxn[], ctx: RuleContext, exclude: Set<string>): RawFinding[] {
  const out: RawFinding[] = [];
  const candidates = txns.filter((t) => !t.cancelled && !t.isReturn && t.party && t.amount > 0);
  for (const g of groupBy(candidates, (t) => `${t.doctype}|${t.direction}|${t.party}|${t.amount.toFixed(2)}`).values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((a, b) => a.date.localeCompare(b.date));
    // cluster consecutive items within the window
    let cluster: AuditTxn[] = [sorted[0]!];
    const flush = () => {
      if (cluster.length < 2) return;
      if (cluster.every((x) => exclude.has(`${x.doctype}:${x.name}`))) return;
      const sameBill = new Set(cluster.map((x) => norm(x.billNo))).size === 1 && norm(cluster[0]!.billNo) !== '';
      if (sameBill) return; // covered by duplicate_bill
      const isPayment = cluster[0]!.doctype === 'Payment Entry';
      out.push({
        rule: isPayment ? 'duplicate_payment' : 'duplicate_amount',
        severity: isPayment ? 'high' : 'medium',
        title: `${cluster.length}× ${cluster[0]!.doctype} of the same amount to/from ${cluster[0]!.party}`,
        detail: `${cluster.map((x) => `${x.name} (${x.date})`).join(', ')} share party and amount within ${ctx.policy.duplicateWindowDays} day(s). Confirm these are separate transactions.`,
        amount: round2(sum(cluster) - cluster[0]!.amount),
        txns: cluster,
        observed: { party: cluster[0]!.party, amount: cluster[0]!.amount, dates: cluster.map((x) => x.date), windowDays: ctx.policy.duplicateWindowDays },
      });
    };
    for (const t of sorted.slice(1)) {
      if (daysBetween(cluster[cluster.length - 1]!.date, t.date) <= ctx.policy.duplicateWindowDays) cluster.push(t);
      else {
        flush();
        cluster = [t];
      }
    }
    flush();
  }
  return out;
}

// ---------------------------------------------------------------- statutory cash limits & structuring

const partyKey = (t: AuditTxn) => t.party ?? `${t.doctype}:${t.name}`;

export function cashLimits(txns: AuditTxn[], ctx: RuleContext): RawFinding[] {
  const out: RawFinding[] = [];
  const cash = txns.filter((t) => !t.cancelled && t.mode === 'cash');
  const { maxCashPayment, maxCashReceiptPerDay } = ctx.policy;
  if (maxCashPayment !== undefined) {
    for (const g of groupBy(cash.filter((t) => t.direction === 'out'), (t) => `${partyKey(t)}|${t.date}`).values()) {
      const total = sum(g);
      if (total > maxCashPayment) {
        out.push({
          rule: 'cash_payment_limit',
          severity: 'high',
          title: `Cash paid to ${g[0]!.party ?? 'one payee'} on ${g[0]!.date} exceeds the limit`,
          detail:
            ctx.country === 'IN'
              ? `Cash payments of ${total} in a day exceed ₹${maxCashPayment.toLocaleString('en-IN')}. Under Sec 40A(3) the expense may be disallowed. Pay by bank / UPI instead.`
              : `Cash payments of ${total} in a day exceed your policy limit of ${maxCashPayment}.`,
          amount: total,
          txns: g,
          observed: { total, limit: maxCashPayment, count: g.length },
        });
      }
    }
  }
  if (maxCashReceiptPerDay !== undefined) {
    for (const g of groupBy(cash.filter((t) => t.direction === 'in'), (t) => `${partyKey(t)}|${t.date}`).values()) {
      const total = sum(g);
      if (total >= maxCashReceiptPerDay) {
        out.push({
          rule: 'cash_receipt_limit',
          severity: 'critical',
          title: `Cash received from ${g[0]!.party ?? 'one payer'} on ${g[0]!.date} at or above the limit`,
          detail:
            ctx.country === 'IN'
              ? `Receiving ₹${total.toLocaleString('en-IN')} in cash from one person in a day breaches Sec 269ST (₹2 lakh); the penalty equals the amount received.`
              : `Cash receipts of ${total} from one party in a day exceed your policy limit of ${maxCashReceiptPerDay}.`,
          amount: total,
          txns: g,
          observed: { total, limit: maxCashReceiptPerDay, count: g.length },
        });
      }
    }
  }
  return out;
}

/** Several outflows to one party on one day, each under the approval threshold, that add up to more than it. */
export function splitTransactions(txns: AuditTxn[], ctx: RuleContext): RawFinding[] {
  const limit = ctx.policy.approvalThreshold;
  const outs = txns.filter((t) => !t.cancelled && t.direction === 'out' && t.party && t.amount < limit);
  return [...groupBy(outs, (t) => `${t.party}|${t.date}`).values()]
    .filter((g) => g.length >= 2 && sum(g) >= limit)
    .map((g) => ({
      rule: 'split_transaction',
      severity: 'high' as const,
      title: `${g.length} payments to ${g[0]!.party} on ${g[0]!.date} just under the approval limit`,
      detail: `Each is below ${limit} but together they total ${sum(g)}. Splitting can be used to avoid approval.`,
      amount: sum(g),
      txns: g,
      observed: { total: sum(g), threshold: limit, parts: g.map((x) => x.amount) },
    }));
}

// ---------------------------------------------------------------- tax compliance

export function taxIdChecks(txns: AuditTxn[], ctx: RuleContext): RawFinding[] {
  const out: RawFinding[] = [];
  const pis = txns.filter((t) => t.doctype === 'Purchase Invoice' && !t.cancelled && !t.isReturn);
  const label = ctx.country === 'IN' ? 'GSTIN' : 'TRN';
  const missing = pis.filter((t) => !t.taxId && ((t.taxAmount ?? 0) > 0 || (ctx.policy.taxIdRequiredAbove !== undefined && t.amount > ctx.policy.taxIdRequiredAbove)));
  for (const g of groupBy(missing, (t) => t.party ?? t.name).values()) {
    const tax = round2(g.reduce((s, x) => s + (x.taxAmount ?? 0), 0));
    out.push({
      rule: 'missing_tax_id',
      severity: tax > 0 ? 'high' : 'medium',
      title: `${g[0]!.party ?? 'Supplier'} has no ${label} on ${g.length} bill(s)`,
      detail: tax > 0 ? `Input tax of ${tax} is claimed without the supplier's ${label}; the credit can be denied on assessment.` : `Large purchases should carry the supplier's ${label}.`,
      amount: tax || sum(g),
      txns: g,
      observed: { inputTax: tax, bills: g.length },
    });
  }
  const invalid = pis.filter((t) => t.taxId && !isValidTaxId(t.taxId, ctx.country));
  for (const g of groupBy(invalid, (t) => `${t.party}|${t.taxId}`).values()) {
    out.push({
      rule: 'invalid_tax_id',
      severity: 'high',
      title: `${g[0]!.party ?? 'Supplier'} ${label} "${g[0]!.taxId}" is not valid`,
      detail: ctx.country === 'IN' ? 'The GSTIN fails the format/checksum test. Input credit will not match GSTR-2B.' : 'The TRN must be 15 digits starting with 100.',
      amount: round2(g.reduce((s, x) => s + (x.taxAmount ?? 0), 0)),
      txns: g,
      observed: { taxId: g[0]!.taxId },
    });
  }
  return out;
}

/** GST Rule 46 / UAE Art. 59: tax invoices must use one consecutive serial. Gaps need an explanation. */
export function invoiceSequenceGaps(txns: AuditTxn[]): RawFinding[] {
  const out: RawFinding[] = [];
  const sis = txns.filter((t) => t.doctype === 'Sales Invoice');
  const parsed = sis
    .map((t) => ({ t, m: t.name.match(/^(.*?)(\d+)$/) }))
    .filter((x): x is { t: AuditTxn; m: RegExpMatchArray } => !!x.m)
    .map(({ t, m }) => ({ t, prefix: m[1]!, n: Number(m[2]), width: m[2]!.length }));
  for (const [prefix, g] of groupBy(parsed, (x) => x.prefix)) {
    if (g.length < 3) continue;
    const nums = new Set(g.map((x) => x.n));
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (max - min > 100_000) continue; // not a sequential series
    const missing: number[] = [];
    for (let n = min; n <= max && missing.length < 200; n++) if (!nums.has(n)) missing.push(n);
    if (!missing.length) continue;
    const width = g[0]!.width;
    const names = missing.map((n) => `${prefix}${String(n).padStart(width, '0')}`);
    const neighbours = g.filter((x) => missing.some((n) => Math.abs(x.n - n) === 1)).map((x) => x.t);
    out.push({
      rule: 'invoice_sequence_gap',
      severity: missing.length > 5 ? 'high' : 'medium',
      title: `${missing.length} missing number(s) in invoice series ${prefix || '(no prefix)'}`,
      detail: `Not found (neither submitted nor cancelled): ${names.slice(0, 15).join(', ')}${names.length > 15 ? '…' : ''}. Tax invoices must be serially numbered; record why numbers were skipped.`,
      txns: neighbours.slice(0, 20),
      observed: { prefix, from: min, to: max, missing: names },
    });
  }
  return out;
}

// ---------------------------------------------------------------- analytics

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Robust z-score (median / MAD) per party and document type: amounts far outside a party's normal range. */
export function outliers(txns: AuditTxn[], ctx: RuleContext): RawFinding[] {
  const out: RawFinding[] = [];
  const base = txns.filter((t) => !t.cancelled && !t.isReturn && t.party && t.amount > 0);
  for (const g of groupBy(base, (t) => `${t.doctype}|${t.party}`).values()) {
    if (g.length < 6) continue;
    const amounts = g.map((x) => x.amount);
    const med = median(amounts);
    const mad = median(amounts.map((a) => Math.abs(a - med)));
    if (mad === 0) continue;
    for (const t of g) {
      const z = (0.6745 * (t.amount - med)) / mad;
      if (z > ctx.policy.outlierZ) {
        out.push({
          rule: 'amount_outlier',
          severity: z > ctx.policy.outlierZ * 2 ? 'high' : 'medium',
          title: `${t.doctype} ${t.name} is unusually large for ${t.party}`,
          detail: `Amount ${t.amount} vs a typical ${round2(med)} (robust z = ${z.toFixed(1)}, ${g.length} transactions compared).`,
          amount: t.amount,
          txns: [t],
          observed: { amount: t.amount, median: round2(med), mad: round2(mad), z: round2(z), sample: g.length },
        });
      }
    }
  }
  return out;
}

/** Benford first-digit test (Nigrini MAD thresholds). Population-level; flags the most over-represented digit. */
export function benford(txns: AuditTxn[]): { finding?: RawFinding; stats: { n: number; mad: number; conformity: string; observed: number[]; expected: number[] } } {
  const pool = txns.filter((t) => !t.cancelled && t.amount >= 10);
  const expected = Array.from({ length: 9 }, (_, i) => Math.log10(1 + 1 / (i + 1)));
  const counts = Array(9).fill(0) as number[];
  for (const t of pool) {
    const d = Number(String(Math.floor(t.amount)).replace(/^0+/, '')[0]);
    if (d >= 1 && d <= 9) counts[d - 1]!++;
  }
  const n = counts.reduce((a, b) => a + b, 0);
  const observed = counts.map((c) => (n ? c / n : 0));
  const mad = n ? observed.reduce((s, o, i) => s + Math.abs(o - expected[i]!), 0) / 9 : 0;
  const conformity = mad <= 0.006 ? 'close' : mad <= 0.012 ? 'acceptable' : mad <= 0.015 ? 'marginal' : 'nonconformity';
  const stats = { n, mad: Number(mad.toFixed(4)), conformity, observed: observed.map((o) => Number(o.toFixed(4))), expected: expected.map((e) => Number(e.toFixed(4))) };
  if (n < 100 || conformity !== 'nonconformity') return { stats };
  const worst = observed.map((o, i) => ({ d: i + 1, excess: o - expected[i]! })).sort((a, b) => b.excess - a.excess)[0]!;
  const flagged = pool
    .filter((t) => String(Math.floor(t.amount))[0] === String(worst.d))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 25);
  return {
    stats,
    finding: {
      rule: 'benford_deviation',
      severity: 'medium',
      title: `Amounts starting with "${worst.d}" are over-represented`,
      detail: `First-digit distribution of ${n} amounts deviates from Benford's law (MAD ${stats.mad} > 0.015). This often points to invented, rounded or threshold-driven amounts; the largest ones are listed for review.`,
      txns: flagged,
      observed: { digit: worst.d, excessShare: Number(worst.excess.toFixed(4)), ...stats },
    },
  };
}

export function roundAmounts(txns: AuditTxn[], ctx: RuleContext): RawFinding[] {
  const min = ctx.currency === 'INR' ? 10_000 : 1_000;
  const hits = txns.filter((t) => !t.cancelled && t.direction === 'out' && t.amount >= min && t.amount % 1000 === 0 && !(t.taxAmount ?? 0) && t.doctype !== 'Payment Entry');
  return [...groupBy(hits, (t) => t.party ?? '(no party)').values()].map((g) => ({
    rule: 'round_amount',
    severity: 'low' as const,
    title: `${g.length} round-figure expense(s) without tax${g[0]!.party ? ` for ${g[0]!.party}` : ''}`,
    detail: `Exact round amounts (${g.map((x) => x.amount).slice(0, 5).join(', ')}) with no tax are typical of estimates or unsupported entries. Make sure a bill is attached.`,
    amount: sum(g),
    txns: g,
    observed: { count: g.length },
  }));
}

/** IN: Sunday; AE: Saturday + Sunday (since 2022). */
export function weekendPostings(txns: AuditTxn[], ctx: RuleContext): RawFinding[] {
  if (!ctx.policy.flagWeekends) return [];
  const weekend = ctx.country === 'AE' ? [0, 6] : [0];
  const hits = txns.filter((t) => !t.cancelled && t.direction === 'out' && t.amount >= ctx.policy.approvalThreshold && weekend.includes(new Date(`${t.date}T00:00:00Z`).getUTCDay()));
  return hits.map((t) => ({
    rule: 'weekend_posting',
    severity: 'low' as const,
    title: `High-value ${t.doctype} dated on a weekend (${t.date})`,
    detail: `${t.name} for ${t.amount} is dated on a non-working day. Confirm it is genuine and approved.`,
    amount: t.amount,
    txns: [t],
    observed: { weekday: new Date(`${t.date}T00:00:00Z`).getUTCDay() },
  }));
}

/** A supplier created recently that already receives a large payment. */
export function newVendorPayments(txns: AuditTxn[], ctx: RuleContext): RawFinding[] {
  if (!ctx.supplierSince) return [];
  const out: RawFinding[] = [];
  const pays = txns.filter((t) => !t.cancelled && t.direction === 'out' && t.partyType === 'Supplier' && t.amount >= ctx.policy.approvalThreshold && t.party);
  for (const t of pays) {
    const since = ctx.supplierSince[t.party!];
    if (!since) continue;
    const age = daysBetween(since.slice(0, 10), t.date);
    if (age >= 0 && age <= 30) {
      out.push({
        rule: 'new_vendor_large_payment',
        severity: 'medium',
        title: `${t.party} was added ${age} day(s) before a ${t.amount} ${t.doctype}`,
        detail: 'Large payments to newly created suppliers are a common fraud pattern. Verify the supplier (tax ID, bank details) independently.',
        amount: t.amount,
        txns: [t],
        observed: { supplierCreated: since.slice(0, 10), ageDays: age },
      });
    }
  }
  return out;
}

export const RULES = [
  'duplicate_bill',
  'duplicate_payment',
  'duplicate_amount',
  'cash_payment_limit',
  'cash_receipt_limit',
  'split_transaction',
  'missing_tax_id',
  'invalid_tax_id',
  'invoice_sequence_gap',
  'amount_outlier',
  'benford_deviation',
  'round_amount',
  'weekend_posting',
  'new_vendor_large_payment',
] as const;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Run every test over the full population. */
export function analyze(txns: AuditTxn[], ctx: RuleContext) {
  const live = txns.filter((t) => !t.cancelled);
  const dupBills = duplicateBills(live);
  const excluded = new Set(dupBills.flatMap((f) => f.txns.map((t) => `${t.doctype}:${t.name}`)));
  const ben = benford(live);
  const findings = [
    ...dupBills,
    ...nearDuplicates(live, ctx, excluded),
    ...cashLimits(live, ctx),
    ...splitTransactions(live, ctx),
    ...taxIdChecks(live, ctx),
    ...invoiceSequenceGaps(txns), // needs cancelled docs too
    ...outliers(live, ctx),
    ...(ben.finding ? [ben.finding] : []),
    ...roundAmounts(live, ctx),
    ...weekendPostings(live, ctx),
    ...newVendorPayments(live, ctx),
  ].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.amount ?? 0) - (a.amount ?? 0));
  return { findings, benford: ben.stats };
}
