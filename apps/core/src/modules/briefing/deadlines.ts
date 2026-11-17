/**
 * Tax deadline calendar for small businesses in India (GST, TDS, income tax) and the UAE (VAT, Corporate Tax).
 * Dates are the statutory due dates; governments sometimes extend them, so messages say "check the portal".
 * Pure functions: no I/O, easy to test.
 */
import type { TenantSettings } from '@nextai/shared';

export interface Deadline {
  /** Stable id, e.g. "gstr3b-2026-10". */
  key: string;
  /** "GSTR-3B for October 2026". */
  what: string;
  /** YYYY-MM-DD. */
  due: string;
  /** Which kinds of entries must be complete before filing. */
  needs: Array<'sales' | 'purchases' | 'all'>;
  note?: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n: number) => String(n).padStart(2, '0');
/** y, m (1-12, may overflow), d → YYYY-MM-DD; d = 0 is the last day of the previous month. */
const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const monthName = (y: number, m: number) => {
  const dt = new Date(Date.UTC(y, m - 1, 1));
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
};
/** "October–December 2025", or "November 2025–January 2026" across a year end. */
const quarterLabel = (y: number, endMonth: number) => {
  const start = new Date(Date.UTC(y, endMonth - 3, 1));
  const sameYear = start.getUTCFullYear() === y;
  return sameYear ? `${MONTHS[start.getUTCMonth()]}–${MONTHS[endMonth - 1]} ${y}` : `${monthName(start.getUTCFullYear(), start.getUTCMonth() + 1)}–${monthName(y, endMonth)}`;
};
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000);

type Cal = TenantSettings['taxCalendar'];

function india(regime: TenantSettings['taxRegime'], cal: Cal, y: number, m: number): Deadline[] {
  const out: Deadline[] = [];
  const prev = { y: m === 1 ? y - 1 : y, m: m === 1 ? 12 : m - 1 }; // the month just ended
  const quarterEnded = [3, 6, 9, 12].includes(prev.m); // a quarter ended last month
  const quarter = quarterLabel(prev.y, prev.m);
  if (regime === 'gst_regular') {
    if (cal.gstFiling === 'quarterly') {
      if (quarterEnded) {
        out.push({ key: `gstr1q-${prev.y}-${pad(prev.m)}`, what: `GSTR-1 for ${quarter}`, due: ymd(y, m, 13), needs: ['sales'] });
        out.push({ key: `gstr3bq-${prev.y}-${pad(prev.m)}`, what: `GSTR-3B for ${quarter}`, due: ymd(y, m, 22), needs: ['all'], note: 'Due on the 22nd or 24th depending on your state.' });
      } else {
        out.push({ key: `pmt06-${prev.y}-${pad(prev.m)}`, what: `GST payment (PMT-06) for ${monthName(prev.y, prev.m)}`, due: ymd(y, m, 25), needs: ['all'] });
      }
    } else {
      out.push({ key: `gstr1-${prev.y}-${pad(prev.m)}`, what: `GSTR-1 for ${monthName(prev.y, prev.m)}`, due: ymd(y, m, 11), needs: ['sales'] });
      out.push({ key: `gstr3b-${prev.y}-${pad(prev.m)}`, what: `GSTR-3B for ${monthName(prev.y, prev.m)}`, due: ymd(y, m, 20), needs: ['all'] });
    }
    if (m === 12) out.push({ key: `gstr9-${y - 1}`, what: `GSTR-9 annual return for FY ${y - 2}-${String(y - 1).slice(2)}`, due: ymd(y, 12, 31), needs: ['all'], note: 'Required above ₹2 crore turnover.' });
  }
  if (regime === 'gst_composition') {
    if (quarterEnded) out.push({ key: `cmp08-${prev.y}-${pad(prev.m)}`, what: `CMP-08 for ${quarter}`, due: ymd(y, m, 18), needs: ['all'] });
    if (m === 4) out.push({ key: `gstr4-${y - 1}`, what: `GSTR-4 annual return for FY ${y - 2}-${String(y - 1).slice(2)}`, due: ymd(y, 4, 30), needs: ['all'] });
  }
  if (cal.tds) {
    // TDS deducted in a month is paid by the 7th of the next (March: 30 April).
    out.push({ key: `tds-${prev.y}-${pad(prev.m)}`, what: `TDS payment for ${monthName(prev.y, prev.m)}`, due: prev.m === 3 ? ymd(y, 4, 30) : ymd(y, m, 7), needs: ['purchases'] });
    const tdsReturn: Record<number, string> = { 7: 'April–June', 10: 'July–September', 1: 'October–December', 5: 'January–March' };
    if (tdsReturn[m]) out.push({ key: `tdsret-${y}-${pad(m)}`, what: `TDS return (24Q/26Q) for ${tdsReturn[m]}`, due: ymd(y, m + 1, 0), needs: ['purchases'] });
  }
  if (cal.advanceTax) {
    const adv: Record<number, string> = { 6: '15%', 9: '45%', 12: '75%', 3: '100%' };
    if (adv[m]) out.push({ key: `advtax-${y}-${pad(m)}`, what: `Advance tax instalment (${adv[m]} of the year's tax)`, due: ymd(y, m, 15), needs: ['all'] });
  }
  if (m === 7 && !cal.taxAudit) out.push({ key: `itr-${y}`, what: `Income tax return for FY ${y - 1}-${String(y).slice(2)}`, due: ymd(y, 7, 31), needs: ['all'] });
  if (m === 10 && cal.taxAudit) out.push({ key: `itr-${y}`, what: `Income tax return (audited) for FY ${y - 1}-${String(y).slice(2)}`, due: ymd(y, 10, 31), needs: ['all'] });
  return out;
}

function uae(regime: TenantSettings['taxRegime'], cal: Cal, y: number, m: number): Deadline[] {
  const out: Deadline[] = [];
  const prev = { y: m === 1 ? y - 1 : y, m: m === 1 ? 12 : m - 1 };
  if (regime === 'vat' || regime === 'vat_ct') {
    // VAT return and payment: 28 days after the tax period ends (the 28th of the following month).
    const periodEnds = cal.vatPeriod === 'monthly' || cal.vatQuarterEnds.includes(prev.m);
    if (periodEnds) {
      const label = cal.vatPeriod === 'monthly' ? monthName(prev.y, prev.m) : quarterLabel(prev.y, prev.m);
      out.push({ key: `vat-${prev.y}-${pad(prev.m)}`, what: `VAT return (VAT201) for ${label}`, due: ymd(y, m, 28), needs: ['all'] });
    }
  }
  if (regime === 'vat_ct' && m === 9) {
    // Corporate Tax: return and payment within 9 months of the financial year end (calendar year by default).
    out.push({ key: `ct-${y - 1}`, what: `Corporate Tax return for ${y - 1}`, due: ymd(y, 9, 30), needs: ['all'] });
  }
  return out;
}

/** Deadlines falling within `days` from `today` (inclusive), soonest first. */
export function upcomingDeadlines(country: 'IN' | 'AE', settings: Pick<TenantSettings, 'taxRegime' | 'taxCalendar'>, today: string, days = 30): Deadline[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const all: Deadline[] = [];
  for (let k = -1; k <= Math.ceil(days / 28) + 1; k++) {
    const mm = m + k;
    const yy = y + Math.floor((mm - 1) / 12);
    const m1 = ((((mm - 1) % 12) + 12) % 12) + 1;
    all.push(...(country === 'IN' ? india(settings.taxRegime, settings.taxCalendar, yy, m1) : uae(settings.taxRegime, settings.taxCalendar, yy, m1)));
  }
  const seen = new Set<string>();
  return all
    .filter((d) => {
      const left = daysBetween(today, d.due);
      if (left < 0 || left > days || seen.has(d.key)) return false;
      seen.add(d.key);
      return true;
    })
    .sort((a, b) => a.due.localeCompare(b.due));
}
