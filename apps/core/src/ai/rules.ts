import type { IntentResult } from '@nextai/shared';

const MODES: Record<string, string> = {
  cash: 'cash', bank: 'bank', 'bank transfer': 'bank', transfer: 'bank', cheque: 'bank', check: 'bank', neft: 'bank', imps: 'bank', rtgs: 'bank',
  card: 'card', 'credit card': 'card', 'debit card': 'card', upi: 'upi', gpay: 'upi', phonepe: 'upi', paytm: 'upi', credit: 'credit',
};
const MODE_RE = /\b(?:by|via|through|thru|using|in|with|from|on)\s+(?:my\s+|the\s+|a\s+)?(bank transfer|credit card|debit card|cash|bank|transfer|cheque|check|neft|imps|rtgs|card|upi|gpay|phonepe|paytm|credit)\b/;
/** "date: 15/11/2026", "on 2026-11-15", "15-11-26", "yesterday" → YYYY-MM-DD (day first, as written in IN/AE). */
const DATE_RE = /\b(?:date\s*[:=-]?\s*|dated\s+|on\s+)?(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|yesterday|today)\b/;

export function parseDate(s: string, now = new Date()): string | undefined {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (s === 'today') return iso(now);
  if (s === 'yesterday') return iso(new Date(now.getTime() - 86400_000));
  let y: number, m: number, d: number;
  const ymd = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  else {
    const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (!dmy) return undefined;
    [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
    if (y < 100) y += 2000;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined; // 31/02 etc.
  return iso(date);
}

/**
 * Deterministic, zero-cost intent classifier used before the LLM. Handles the common
 * short phrasings ("paid 500 for tea", "Ravi paid 2000", "sold 5000 to Ravi", "report p&l").
 * Returns undefined when unsure so the caller can fall back to the LLM.
 */
export function ruleClassify(text: string): IntentResult | undefined {
  const raw = text.trim().toLowerCase();
  // "by bank" / "via upi" / "using card" → payment mode; removed so it doesn't end up in party names.
  const modeMatch = raw.match(MODE_RE);
  const paymentMode = modeMatch ? MODES[modeMatch[1]!.replace(/\s+/g, ' ')] : undefined;
  const noMode = modeMatch ? raw.replace(MODE_RE, ' ') : raw;
  const dateMatch = noMode.match(DATE_RE);
  const date = dateMatch ? parseDate(dateMatch[1]!) : undefined;
  // Remove the mode and date phrases so they don't end up in amounts, party names or descriptions.
  const t = (date ? noMode.replace(DATE_RE, ' ') : noMode).replace(/\s+/g, ' ').replace(/\s*[:,;-]\s*$/, '').trim();
  // Prefer the number right after the verb ("Shop 24 paid 2000" → 2000), else the first number.
  // Suffix k/l/lakh only as its own word ("5k", "2 lakh"), so "5000 loaves" stays 5000; "20USD" is fine.
  const NUM = String.raw`(?:rs\.?|₹|inr|aed|dhs?|usd|\$)?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:(k|lakh|l)(?![a-z]))?`;
  const amountMatch =
    t.match(new RegExp(String.raw`\b(?:paid|sent|transferred|spent|sold|bought|purchased|received|sale|invoice)\s+(?:me\s+|us\s+)?` + NUM)) ??
    t.match(new RegExp(NUM));
  const amount = amountMatch
    ? Number(amountMatch[1]!.replace(/,/g, '')) *
      (amountMatch[2] === 'k' ? 1e3 : amountMatch[2] === 'l' || amountMatch[2] === 'lakh' ? 1e5 : 1)
    : undefined;
  // Whole words only: "Traders" must not read as "rs", "Siddharth" not as "dh".
  // Currency words may touch the number ("20usd", "rs500") but not other letters ("traders", "siddharth").
  const word = (w: string) => new RegExp(String.raw`(?<![a-z])(?:${w})(?![a-z])`).test(t);
  const currency = word('aed|dhs?|dirhams?')
    ? ('AED' as const)
    : /₹/.test(t) || word(String.raw`rs\.?|inr|rupees?`)
      ? ('INR' as const)
      : /\$/.test(t) || word('usd|dollars?')
        ? ('USD' as const)
        : undefined;

  if (/^(help|menu|hi|hello|start|\?)$/.test(t)) return { intent: 'help', confidence: 0.95, entities: {} };

  const report = t.match(/\b(report|statement)\b.*?\b(p&l|pnl|profit|loss|balance sheet|bs|receivable|payable|ledger|cash ?flow)\b/) ??
    t.match(/\b(p&l|pnl|profit and loss|balance sheet)\b/);
  if (report) {
    const r = report[0];
    const key = /p&l|pnl|profit/.test(r) ? 'profit_and_loss' : /balance|bs/.test(r) ? 'balance_sheet' : /receivable/.test(r) ? 'receivables' : /payable/.test(r) ? 'payables' : /cash/.test(r) ? 'cash_flow' : 'general_ledger';
    return { intent: 'request_report', confidence: 0.9, entities: { report: key } };
  }

  if (/\bremind\b/.test(t)) {
    const party = t.match(/remind\s+(.+)$/)?.[1]?.trim();
    return { intent: 'send_reminder', confidence: 0.85, entities: { party } };
  }

  // "<party> paid 2000" → payment_in
  const pin = t.match(/^([a-z][\w .&-]{1,40}?)\s+(?:paid|sent|transferred)\s+(?:me\s+)?/);
  if (pin && amount && !/^(i|we)\b/.test(pin[1]!)) {
    return { intent: 'payment_in', confidence: 0.85, entities: { amount, currency, paymentMode, date, party: titleCase(pin[1]!) } };
  }

  // "paid 15000 rent" / "paid 500 for tea" / "spent 200 on fuel" → expense or supplier payment
  if (/^(i |we )?(paid|spent|bought|purchased)\b/.test(t) && amount) {
    const to = t.match(/\bto\s+([a-z][\w .&-]{1,40})$/)?.[1];
    if (to) return { intent: 'payment_out', confidence: 0.8, entities: { amount, currency, paymentMode, date, party: titleCase(to) } };
    const desc = t.match(/\b(?:for|on)\s+(.+)$/)?.[1] ?? t.replace(/^(i |we )?(paid|spent|bought|purchased)\s+/, '').replace(/[\d,.]+\s*(k|l)?/, '').trim();
    return { intent: 'record_expense', confidence: 0.85, entities: { amount, currency, paymentMode, date, description: desc || undefined } };
  }

  // "sold 5000 to ravi" / "sale 5000 ravi"
  const sale = t.match(/^(?:sold|sale|invoice|bill)\b.*?\bto\s+([a-z][\w .&-]{1,40})$/);
  if (/^(sold|sale|invoice)\b/.test(t) && amount) {
    return { intent: 'record_sale', confidence: sale ? 0.85 : 0.7, entities: { amount, currency, paymentMode, date, party: sale ? titleCase(sale[1]!) : undefined } };
  }

  if (/^(add|new)\s+(customer|supplier|party|vendor)\b/.test(t)) {
    return { intent: 'add_party', confidence: 0.85, entities: { party: titleCase(t.replace(/^(add|new)\s+(customer|supplier|party|vendor)\s*/, '')) || undefined } };
  }

  if (/^(how much|what|who|show|list|total)\b|\?$/.test(t)) {
    return { intent: 'ask_books', confidence: 0.75, entities: { question: text.trim() } };
  }
  return undefined;
}

const titleCase = (s: string): string => s.trim().replace(/\b\w/g, (c) => c.toUpperCase());
