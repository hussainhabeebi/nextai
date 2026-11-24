/**
 * Bank statement (CSV) and bank SMS parsing → plain lines. Pure functions.
 * Indian and UAE bank exports differ in column names and date formats; headers are detected, not assumed.
 */
export interface ParsedLine {
  date: string; // YYYY-MM-DD
  amount: number; // positive
  direction: 'in' | 'out';
  description: string;
  reference?: string;
  balance?: number;
}

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** "15/11/2026", "15-11-26", "15 Nov 2026", "15-Nov-26", "2026-11-15" → YYYY-MM-DD (day first, as in IN/AE). */
export function parseBankDate(raw: string): string | undefined {
  const s = raw.trim().replace(/,/g, ' ');
  let y: number, m: number, d: number;
  let r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = s.match(/^(\d{1,2})[\s/-]*([A-Za-z]{3,4})[a-z]*[\s/-]*(\d{2,4})/))) [d, m, y] = [Number(r[1]), MON[r[2]!.toLowerCase()] ?? 0, Number(r[3])];
  else return undefined;
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (!m || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return dt.toISOString().slice(0, 10);
}

/** "1,23,456.70", "12,000.00 Cr", "(500.00)", "-500" → number (negative for Dr / brackets / minus). */
export function parseAmount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim();
  if (!s || /^[-–]$/.test(s)) return undefined;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /\bdr\.?$/i.test(s);
  const n = Number(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || !/\d/.test(s)) return undefined;
  return neg ? -n : n;
}

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === sep && !q) {
      out.push(cur);
      cur = '';
    }
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const COLS = {
  date: /^(txn|transaction|value|posting|tran)?\s*\.?\s*date$|^date$/i,
  description: /narration|description|particulars|remarks|details|transaction details/i,
  reference: /ref|chq|cheque|utr/i,
  debit: /withdrawal|debit|^dr\.?$|paid out|money out/i,
  credit: /deposit|credit|^cr\.?$|paid in|money in/i,
  amount: /^amount|txn amount|transaction amount/i,
  type: /^(cr\/dr|dr\/cr|type|txn type|debit\/credit)$/i,
  balance: /balance/i,
};

/** A bank's CSV export → lines. Returns [] when the file isn't a recognisable statement. */
export function parseCsvStatement(text: string): ParsedLine[] {
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!rows.length) return [];
  const sep = [',', ';', '\t', '|'].sort((a, b) => rows[0]!.split(b).length - rows[0]!.split(a).length)[0]!;
  // Banks put account details above the table: find the header row.
  const headerAt = rows.slice(0, 40).findIndex((r) => {
    const cells = splitCsvLine(r, sep);
    return cells.some((h) => COLS.date.test(h)) && cells.some((h) => COLS.debit.test(h) || COLS.credit.test(h) || COLS.amount.test(h));
  });
  if (headerAt < 0) return [];
  const header = splitCsvLine(rows[headerAt]!, sep);
  const col = (re: RegExp, not?: RegExp) => header.findIndex((h) => re.test(h) && !(not && not.test(h)));
  const ix = {
    date: col(COLS.date),
    description: col(COLS.description),
    reference: col(COLS.reference, COLS.date),
    debit: col(COLS.debit, COLS.type),
    credit: col(COLS.credit, COLS.type),
    amount: col(COLS.amount),
    type: col(COLS.type),
    balance: col(COLS.balance),
  };
  const out: ParsedLine[] = [];
  for (const r of rows.slice(headerAt + 1)) {
    const cells = splitCsvLine(r, sep);
    const date = parseBankDate(cells[ix.date] ?? '');
    if (!date) continue; // totals, footers, blank lines
    let amount: number | undefined;
    let direction: 'in' | 'out' | undefined;
    const dr = ix.debit >= 0 ? parseAmount(cells[ix.debit]) : undefined;
    const cr = ix.credit >= 0 ? parseAmount(cells[ix.credit]) : undefined;
    if (dr && Math.abs(dr) > 0) {
      amount = Math.abs(dr);
      direction = 'out';
    } else if (cr && Math.abs(cr) > 0) {
      amount = Math.abs(cr);
      direction = 'in';
    } else if (ix.amount >= 0) {
      const a = parseAmount(cells[ix.amount]);
      if (a) {
        const t = (cells[ix.type] ?? '').toLowerCase();
        direction = /^(dr|debit|d)/.test(t) ? 'out' : /^(cr|credit|c)/.test(t) ? 'in' : a < 0 ? 'out' : 'in';
        amount = Math.abs(a);
      }
    }
    if (!amount || !direction) continue;
    const balance = ix.balance >= 0 ? parseAmount(cells[ix.balance]) : undefined;
    out.push({
      date,
      amount: Math.round(amount * 100) / 100,
      direction,
      description: (cells[ix.description] ?? '').replace(/\s+/g, ' ').slice(0, 300) || 'Bank transaction',
      reference: ix.reference >= 0 && cells[ix.reference] && !/^0+$/.test(cells[ix.reference]!) ? cells[ix.reference]!.slice(0, 60) : undefined,
      balance: balance === undefined ? undefined : Math.abs(balance),
    });
  }
  return out;
}

/**
 * A bank SMS forwarded to WhatsApp → one line, or undefined if it isn't one. Needs an amount, a credit/debit word
 * and an account/card mention, so ordinary chat ("paid 500 for tea") never reads as an SMS.
 */
export function parseBankSms(text: string, today: string): ParsedLine | undefined {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length < 30 || s.length > 600) return undefined;
  // Banks always mask the account/card number (XX1234, **1234, "ending 1234"); chat like "capital account by cash" doesn't.
  if (!/\b(?:a\/?c|acct|account|card)\b[^.;]{0,20}?(?:x{2,}|\*{2,}|\.{2,}|ending\s*|no\.?\s*)\d{3,}|\bx{2,}\d{3,}|\*{2,}\d{3,}/i.test(s)) return undefined;
  const dir = s.match(/\b(credited|received|deposited|added)\b|\b(debited|withdrawn|spent|deducted|paid|sent|transferred)\b/i);
  if (!dir) return undefined;
  const direction: 'in' | 'out' = dir[1] ? 'in' : 'out';
  const amt = s.match(/(?:rs\.?|inr|₹|aed|dhs?)\s*([\d,]+(?:\.\d{1,2})?)/i) ?? s.match(/([\d,]+\.\d{2})\s*(?:rs|inr|aed)?\b/i);
  const amount = amt ? Number(amt[1]!.replace(/,/g, '')) : NaN;
  if (!(amount > 0)) return undefined;
  const dm = s.match(/\b(\d{1,2}[/.-](?:\d{1,2}|[A-Za-z]{3})[/.-]\d{2,4})\b|\b(\d{4}-\d{2}-\d{2})\b|\b(\d{1,2}\s?[A-Za-z]{3}\s?\d{2,4})\b/);
  const date = (dm && parseBankDate(dm[0])) || today;
  const ref = s.match(/\b(?:ref(?:erence)?|utr|upi ref|upi|rrn|txn|imps|neft)\s*(?:no\.?|number|id)?\s*[:#-]?\s*([A-Za-z0-9]{6,22})\b/i)?.[1];
  const stop = String.raw`(?=\s+(?:on|ref|upi|via|info|avl|avbl|bal|\(|imps|neft|for)\b|[.;,]|$)`;
  const who =
    s.match(new RegExp(String.raw`\bfrom\s+(?:VPA\s+)?([A-Za-z0-9@._ &-]{3,40}?)` + stop, 'i'))?.[1] ??
    (direction === 'out' ? s.match(/[;.,]\s*([A-Za-z][A-Za-z0-9 .&]{2,40}?)\s+credited\b/i)?.[1] : undefined) ??
    s.match(new RegExp(String.raw`\bby\s+(?:VPA\s+)?([A-Za-z0-9@._ &-]{3,40}?)` + stop, 'i'))?.[1] ??
    s.match(/\b(?:to|at|towards)\s+(?:VPA\s+)?([A-Za-z0-9@._ &-]{3,40}?)(?=\s+(?:on|ref|upi|via|info|avl|avbl|bal|\(|imps|neft|for)\b|[.;,]|$)/i)?.[1] ??
    s.match(/info[:\s]+([^.;]{3,60})/i)?.[1];
  return { date, amount, direction, description: who ? who.trim() : s.slice(0, 120), reference: ref };
}
