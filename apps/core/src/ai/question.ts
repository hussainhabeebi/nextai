/**
 * Questions about the books, read without the AI: what is asked (topic), for which period, and for whom.
 * "how much sales is today", "expenses last month", "who owes me", "Ravi balance", "cash in hand", "profit this year".
 * Pure: unit tested in rules.test.ts.
 */

export const TOPICS = [
  'sales', 'purchases', 'expenses', 'profit', 'received', 'paid', 'receivables', 'payables',
  'cash', 'party', 'top_customers', 'top_suppliers', 'tax', 'pending', 'unpaid_invoices', 'unpaid_bills', 'summary',
] as const;
export type Topic = (typeof TOPICS)[number];

export interface QPeriod {
  /** "today", "this month", "Oct 2026", "1 Apr – 18 Nov 2026" */
  label: string;
  from: string;
  to: string;
  /** true when the message named the period (else the topic's default was used) */
  explicit: boolean;
}

export interface Question {
  topic: Topic;
  period: QPeriod;
  party?: string;
  /** expenses: only ledgers matching this ("fuel", "rent") */
  about?: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (s: string, n: number) => iso(new Date(utc(s).getTime() + n * 86400_000));
const ymd = (y: number, m: number, d: number) => iso(new Date(Date.UTC(y, m, d)));
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const short = (s: string, withYear = false) =>
  utc(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });

/** Indian FY starts 1 April; UAE uses the calendar year. */
export function fyStart(country: 'IN' | 'AE', today: string): string {
  const d = utc(today);
  if (country === 'AE') return `${d.getUTCFullYear()}-01-01`;
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-04-01`;
}

/** A named period in the text ("today", "last month", "in october", "last 7 days", "on 15/11"), or undefined. */
export function parsePeriod(text: string, today: string, country: 'IN' | 'AE'): (QPeriod & { match: string }) | undefined {
  const t = text.toLowerCase();
  const d = utc(today);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const p = (label: string, from: string, to: string, match: string) => ({ label, from, to, explicit: true, match });
  let x: RegExpMatchArray | null;
  if ((x = t.match(/\b(?:to\s*day|today'?s?|innu|innathe)\b/))) return p(`today (${short(today)})`, today, today, x[0]);
  if ((x = t.match(/\b(?:yesterday'?s?|innale)\b/))) return p(`yesterday (${short(addDays(today, -1))})`, addDays(today, -1), addDays(today, -1), x[0]);
  if ((x = t.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+days?\b/))) {
    const n = Number(x[1]);
    return p(`last ${n} days`, addDays(today, -(n - 1)), today, x[0]);
  }
  const monday = addDays(today, -((d.getUTCDay() + 6) % 7));
  if ((x = t.match(/\b(?:this|current)\s+week\b|\bweek\s+to\s+date\b|\bwtd\b/))) return p('this week', monday, today, x[0]);
  if ((x = t.match(/\b(?:last|previous|past)\s+week\b/))) return p(`last week (${short(addDays(monday, -7))} – ${short(addDays(monday, -1))})`, addDays(monday, -7), addDays(monday, -1), x[0]);
  if ((x = t.match(/\b(?:this|current)\s+month\b|\bmonth\s+to\s+date\b|\bmtd\b|\bee\s+maasam\b/))) return p(`this month (${MONTHS[m]!.replace(/^./, (c) => c.toUpperCase())} ${y})`, ymd(y, m, 1), today, x[0]);
  if ((x = t.match(/\b(?:last|previous|past)\s+month\b/))) {
    const from = ymd(y, m - 1, 1);
    return p(`last month (${short(from, true).replace(/^\d+\s/, '')})`, from, ymd(y, m, 0), x[0]);
  }
  if ((x = t.match(/\b(?:this|current)\s+quarter\b|\bqtd\b/))) {
    const q = Math.floor(m / 3) * 3;
    return p('this quarter', ymd(y, q, 1), today, x[0]);
  }
  if ((x = t.match(/\b(?:last|previous)\s+quarter\b/))) {
    const q = Math.floor(m / 3) * 3;
    return p('last quarter', ymd(y, q - 3, 1), ymd(y, q, 0), x[0]);
  }
  const fy = fyStart(country, today);
  if ((x = t.match(/\b(?:this|current)\s+(?:financial\s+|fiscal\s+)?year\b|\b(?:ytd|fytd|year\s+to\s+date|so\s+far\s+this\s+year)\b|\bthis\s+fy\b/))) {
    return p(`this ${country === 'IN' ? 'financial ' : ''}year (${short(fy, true)} – ${short(today)})`, fy, today, x[0]);
  }
  if ((x = t.match(/\b(?:last|previous)\s+(?:financial\s+|fiscal\s+)?year\b|\blast\s+fy\b/))) {
    const from = iso(new Date(Date.UTC(utc(fy).getUTCFullYear() - 1, utc(fy).getUTCMonth(), 1)));
    return p(`last ${country === 'IN' ? 'financial ' : ''}year (${short(from, true)} – ${short(addDays(fy, -1), true)})`, from, addDays(fy, -1), x[0]);
  }
  // "in october", "oct 2026", "for march"
  if ((x = t.match(new RegExp(String.raw`\b(?:in\s+|for\s+|of\s+|during\s+)?${MONTH_RE}(?:\s*[-' ]?\s*(\d{2,4}))?\b`)))) {
    // "may" is also a verb: only as a month when a year follows or "in/for may"
    if (!/^may$/.test(x[1]!) || x[2] || /^(in|for|of|during)\s/.test(x[0])) {
      const mi = MONTHS.indexOf(x[1]!.slice(0, 3));
      let yy = x[2] ? Number(x[2]) : y;
      if (yy < 100) yy += 2000;
      if (!x[2] && mi > m) yy -= 1; // "october" in March means last October
      const from = ymd(yy, mi, 1);
      const end = ymd(yy, mi + 1, 0);
      return p(`${MONTHS[mi]!.replace(/^./, (c) => c.toUpperCase())} ${yy}`, from, end < today ? end : today, x[0]);
    }
  }
  // "on 15/11", "on 15-11-2026", "on 2026-11-15"
  if ((x = t.match(/\b(?:on\s+)?(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?)\b/))) {
    const s = x[1]!;
    let day: string | undefined;
    const a = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const b = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
    if (a) day = ymd(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
    else if (b) {
      let yy = b[3] ? Number(b[3]) : y;
      if (yy < 100) yy += 2000;
      day = ymd(yy, Number(b[2]) - 1, Number(b[1]));
      if (!b[3] && day > today) day = ymd(yy - 1, Number(b[2]) - 1, Number(b[1]));
    }
    if (day && Number(b?.[2] ?? 1) <= 12) return p(short(day, true), day, day, x[0]);
  }
  return undefined;
}

/** The period used when none is named: flows default to this month, balances are "as of today". */
function defaultPeriod(topic: Topic, today: string, country: 'IN' | 'AE'): QPeriod {
  const d = utc(today);
  if (topic === 'profit') {
    const fy = fyStart(country, today);
    return { label: `this ${country === 'IN' ? 'financial ' : ''}year (${short(fy, true)} – ${short(today)})`, from: fy, to: today, explicit: false };
  }
  if (topic === 'summary') return { label: `today (${short(today)})`, from: today, to: today, explicit: false };
  const from = ymd(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return { label: `this month (${MONTHS[d.getUTCMonth()]!.replace(/^./, (c) => c.toUpperCase())} ${d.getUTCFullYear()})`, from, to: today, explicit: false };
}

const NAME = String.raw`([a-z0-9][a-z0-9 .&'()/-]{0,60}?)`;
const NOT_NAME = /^(me|us|i|we|my|our|you|customers?|clients?|suppliers?|vendors?|parties|party|everyone|anyone|people|them|the|total|all|today|it|this|that|what|how|much|cash|bank|gst|vat|tax)$/;

/** The topic of a question (and the party it is about, if any). Undefined when it is not a recognisable question. */
export function parseQuestion(text: string, today: string, country: 'IN' | 'AE'): Question | undefined {
  const raw = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?!.]+$/, '').trim();
  if (!raw) return undefined;
  const period = parsePeriod(raw, today, country);
  // the text without the period words, for topic and name matching
  const t = (period ? raw.replace(period.match, ' ') : raw).replace(/\s+/g, ' ').replace(/\b(?:is|are|was|were)\s*$/, '').trim();
  const isQuestion = /^(how|what|whats|what's|who|whom|which|when|show|list|tell|give|get|send|check|total|any|did|do|does|is|are|my|our|can you|please|pls|ethra|enthu|evide)\b/.test(raw) || /\?\s*$/.test(text.trim());
  // A money message ("sales 5000 ravi", "paid 500 for tea") is a transaction, not a question.
  // Digits glued to letters ("4L Fashion", "24seven") are names, not amounts.
  const hasAmount = /(?:rs\.?|₹|aed|inr)\s*\d|(?<![a-z0-9])\d[\d,]*(?:\.\d+)?(?:\s*(?:k|lakhs?)\b|(?![a-z0-9]))(?!\s*(?:days?|weeks?|months?))/.test(t.replace(/\b(?:20\d\d|top\s+\d+)\b/g, ''));
  if (hasAmount && !isQuestion) return undefined;

  const q = (topic: Topic, party?: string): Question => ({ topic, period: period ?? defaultPeriod(topic, today, country), ...(party ? { party } : {}) });
  const name = (s: string | undefined) => {
    const n = s?.trim().replace(/^(?:the|mr\.?|mrs\.?|ms\.?|m\/s\.?)\s+/, '').replace(/\s+(?:now|currently|total|so far)$/, '').trim();
    return n && /[a-z]/.test(n) && !NOT_NAME.test(n) ? n : undefined;
  };
  let m: RegExpMatchArray | null;

  // ---- about one customer/supplier
  if ((m = t.match(new RegExp(String.raw`\bhow\s+much\s+(?:does|do|did|is|has)\s+${NAME}\s+(?:owe|have\s+to\s+(?:pay|give)|pending|due|balance)\b`)))) {
    const n = name(m[1]);
    if (n) return q('party', n);
  }
  if ((m = t.match(new RegExp(String.raw`\bhow\s+much\s+(?:do|did)\s+(?:i|we)\s+owe\s+(?:to\s+)?${NAME}$`)))) {
    const n = name(m[1]);
    if (n) return q('party', n);
  }
  if ((m = t.match(new RegExp(String.raw`\b(?:balance|outstanding|dues?|pending|ledger|statement|account|a\/c|history)\s+(?:of|for|from|with|to)\s+${NAME}$`)))) {
    const n = name(m[1]);
    if (n) return q('party', n);
  }
  if ((m = t.match(new RegExp(String.raw`^(?:show\s+|what\s+is\s+|whats\s+|what's\s+|check\s+)?${NAME}(?:'s)?\s+(?:balance|outstanding|dues?|pending|ledger|statement|account|a\/c)$`)))) {
    const n = name(m[1]);
    if (n && !/\b(cash|bank|total|customer|supplier|my|our|gst|vat|tax|trial)\b/.test(n)) return q('party', n);
  }
  // sales to X / purchases from X / received from X / paid to X (in a period)
  if ((m = t.match(new RegExp(String.raw`\b(?:sales?|sold|billed|invoiced?)\s+(?:to|for)\s+${NAME}$`))) && name(m[1])) return q('sales', name(m[1]));
  if ((m = t.match(new RegExp(String.raw`\b(?:purchases?|bought|bills?)\s+from\s+${NAME}$`))) && name(m[1])) return q('purchases', name(m[1]));
  if ((m = t.match(new RegExp(String.raw`\b(?:received|receipts?|collected|collections?|payments?|got)\s+from\s+${NAME}$`))) && name(m[1])) return q('received', name(m[1]));
  if ((m = t.match(new RegExp(String.raw`\b(?:paid|payments?|gave|given|sent)\s+to\s+${NAME}$`))) && name(m[1])) return q('paid', name(m[1]));
  if ((m = t.match(new RegExp(String.raw`\b(?:did|do|have)\s+(?:i|we)\s+(?:pay|paid|give|gave)\s+(?:to\s+)?${NAME}$`))) && name(m[1])) return q('paid', name(m[1]));
  if ((m = t.match(new RegExp(String.raw`\b(?:did|has)\s+${NAME}\s+(?:pay|paid)\b`))) && name(m[1])) return q('received', name(m[1]));
  if ((m = t.match(new RegExp(String.raw`\b(?:did|have)\s+(?:i|we)\s+(?:buy|bought|purchase|purchased)\s+from\s+${NAME}$`))) && name(m[1])) return q('purchases', name(m[1]));
  if ((m = t.match(new RegExp(String.raw`\b(?:did|have)\s+(?:i|we)\s+(?:sell|sold|bill|billed)\s+(?:to\s+)?${NAME}$`))) && name(m[1])) return q('sales', name(m[1]));

  // ---- whole-business topics (most specific first)
  if (/\b(top|best|biggest|largest|main)\s+(\d+\s+)?(customers?|clients?|buyers?)\b/.test(t)) return q('top_customers');
  if (/\b(top|biggest|largest|main)\s+(\d+\s+)?(suppliers?|vendors?)\b/.test(t)) return q('top_suppliers');
  if (/\b(unpaid|pending|open|outstanding|due)\s+(sales\s+)?invoices?\b|\binvoices?\s+(not\s+paid|unpaid|pending|due)\b/.test(t)) return q('unpaid_invoices');
  if (/\b(unpaid|pending|open|outstanding|due)\s+(purchase\s+)?bills?\b|\bbills?\s+(to\s+pay|not\s+paid|unpaid|pending|due)\b/.test(t)) return q('unpaid_bills');
  if (/\b(who|which\s+customers?)\s+(owes?|has\s+to\s+pay|have\s+to\s+pay|is\s+pending)\b|\bcustomers?\s+(owe|dues?|outstanding|pending|balance)|\b(receivables?|debtors|to\s+collect|collect(?:ion)?s?\s+pending|money\s+to\s+(?:come|receive)|pending\s+(?:payments?\s+)?from\s+customers)\b|\bowe\s+(me|us)\b|\boverdue\b/.test(t)) return q('receivables');
  if (/\b(gst|vat|tax(es)?)\b.*\b(payable|due|pay|liability|owe|deadline|return|filing|file)\b|\b(gstr|vat\s+return|tax\s+due|gst\s+due|vat\s+due)\b|^(gst|vat|tax)$/.test(t)) return q('tax');
  if (/\b(payables?|creditors|i\s+owe|we\s+owe|to\s+pay\s+suppliers|suppliers?\s+(dues?|outstanding|pending|balance)|owe\s+(to\s+)?suppliers?|pending\s+to\s+suppliers)\b/.test(t)) return q('payables');
  if (/\b(cash\s+(in\s+hand|balance|position)|bank\s+balance|balance\s+in\s+(the\s+)?bank|how\s+much\s+(cash|money)|money\s+in\s+(the\s+)?bank|cash\s+and\s+bank|cash\s*&\s*bank|cash\s+available|liquidity)\b|^(cash|bank|balance|cash balance)$/.test(t)) return q('cash');
  if (/\b(pending\s+approvals?|waiting\s+for\s+approval|to\s+approve|drafts?)\b/.test(t)) return q('pending');
  if (/\b(profit|loss|p\s*&\s*l|pnl|margin|net\s+income|earning|earned|labham|laabham|nashtam)\b/.test(t)) return q('profit');
  if (/\b(purchases?|bought|buying|purchase\s+bills?)\b/.test(t)) return q('purchases');
  if (/\b(expenses?|expenditure|spent|spend|spending|costs?|chilavu|chelavu)\b/.test(t)) {
    // "what did I spend on fuel", "expenses for rent": only that kind of expense
    const on = t.match(/\b(?:spen[dt]|spending|expenses?|expenditure|costs?)\s+(?:on|for)\s+([a-z][a-z &]{1,30})$/)?.[1]?.trim();
    return { ...q('expenses'), ...(on && !/^(the|all|total|it|this|that)$/.test(on) ? { about: on } : {}) };
  }
  if (/\b(received|receipts?|collected|collections?|money\s+(came\s+)?in|inflows?)\b/.test(t)) return q('received');
  if (/\b(paid\s+out|payments?\s+made|money\s+(went\s+)?out|outflows?|paid)\b/.test(t)) return q('paid');
  if (/\b(sales?|sold|revenue|turnover|income|business\s+(done|today)|billing|invoiced|vilpana|kachavadam)\b/.test(t)) return q('sales');
  if (isQuestion && /\b(summary|overview|status|how\s+is\s+(the\s+)?business|how'?s\s+(the\s+)?business|position)\b/.test(t)) return q('summary');
  return undefined;
}
