import type { ReportResult } from '@nextai/erpnext-client';
import { REPORT_NAMES, formatMoney, type Currency, type ReportKey } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';
import { erpContext } from '../erpnext/mappers.js';

const monthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const today = () => new Date().toISOString().slice(0, 10);
/** Indian FY starts 1 April; UAE uses calendar year by default. */
export function fiscalYearStart(country: 'IN' | 'AE', d = new Date()): string {
  if (country === 'AE') return `${d.getFullYear()}-01-01`;
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-04-01`;
}

export function reportFilters(tenant: Tenant, key: ReportKey, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { company } = erpContext(tenant);
  const fy = fiscalYearStart(tenant.country);
  switch (key) {
    case 'receivables':
    case 'payables':
      return { company, report_date: today(), ageing_based_on: 'Due Date', range: '30, 60, 90, 120', ...extra };
    case 'profit_and_loss':
    case 'balance_sheet':
    case 'cash_flow':
      return { company, filter_based_on: 'Date Range', period_start_date: extra.from ?? fy, period_end_date: extra.to ?? today(), periodicity: 'Monthly', ...extra };
    case 'general_ledger':
      return { company, from_date: extra.from ?? monthStart(), to_date: extra.to ?? today(), group_by: 'Group by Voucher (Consolidated)', ...extra };
  }
}

export async function runReport(c: Container, tenant: Tenant, key: ReportKey, extra: Record<string, unknown> = {}): Promise<ReportResult> {
  return c.erp(tenant).runReport(REPORT_NAMES[key], reportFilters(tenant, key, extra));
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);

/** Sum outstanding from AR/AP report rows. */
export function totalOutstanding(r: ReportResult): number {
  return (r.result as Row[]).filter((x) => x && typeof x === 'object' && x.party).reduce((s, x) => s + num(x.outstanding), 0);
}

/** Pick the "total" row value for a P&L-style report. */
function pnlNet(r: ReportResult): number {
  const rows = r.result as Row[];
  const net = rows.find((x) => x && typeof x === 'object' && /profit|loss/i.test(String(x.account_name ?? x.account ?? '')) && x.total !== undefined);
  return num(net?.total);
}

export async function reportSummary(c: Container, tenant: Tenant, key: ReportKey): Promise<string> {
  const cur = tenant.currency as Currency;
  try {
    const r = await runReport(c, tenant, key);
    if (key === 'receivables' || key === 'payables') {
      const rows = (r.result as Row[]).filter((x) => x?.party).sort((a, b) => num(b.outstanding) - num(a.outstanding));
      const top = rows.slice(0, 5).map((x) => `• ${x.party}: ${formatMoney(num(x.outstanding), cur)}`).join('\n');
      return `📊 ${REPORT_NAMES[key]}\nTotal: ${formatMoney(totalOutstanding(r), cur)}\n${top || 'Nothing outstanding 🎉'}`;
    }
    if (key === 'profit_and_loss') return `📊 Profit & Loss (FY to date)\nNet: ${formatMoney(pnlNet(r), cur)}\nFull report: open the NextAi app → Reports.`;
    return `📊 ${REPORT_NAMES[key]} is ready in the NextAi app → Reports.`;
  } catch {
    return 'Your books are busy right now. Please try again in a few minutes.';
  }
}

/** Compact facts for "ask your books" (LLM answers ONLY from this). */
export async function booksContext(c: Container, tenant: Tenant): Promise<string> {
  const cur = tenant.currency as Currency;
  const erp = c.erp(tenant);
  const { company } = erpContext(tenant);
  const lines: string[] = [`Business: ${tenant.name}. Currency ${cur}. Date ${today()}.`];
  const safe = async <T>(f: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await f();
    } catch {
      return undefined;
    }
  };
  const bal = await safe(() => erp.getBalances(company));
  if (bal) lines.push(`Cash: ${formatMoney(bal.cash, cur)}; Bank: ${formatMoney(bal.bank, cur)}.`);
  const ar = await safe(() => runReport(c, tenant, 'receivables'));
  if (ar) {
    lines.push(`Customers owe: ${formatMoney(totalOutstanding(ar), cur)}.`);
    for (const x of (ar.result as Row[]).filter((y) => y?.party).slice(0, 10)) lines.push(`- ${x.party} owes ${formatMoney(num(x.outstanding), cur)}`);
  }
  const ap = await safe(() => runReport(c, tenant, 'payables'));
  if (ap) lines.push(`You owe suppliers: ${formatMoney(totalOutstanding(ap), cur)}.`);
  const pending = await tenantDb(c.prisma, tenant.id).draft.count({ where: { status: { in: ['pending', 'needs_review'] } } });
  lines.push(`Pending approvals: ${pending}.`);
  return lines.join('\n');
}
