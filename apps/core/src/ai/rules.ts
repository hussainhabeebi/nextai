import type { AccountKind, IntentResult } from '@nextai/shared';

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

/** Most specific first: "bank loan" is a loan, "loans and advances" an asset, "indirect expenses" not direct. */
const KIND_PATTERNS: Array<[RegExp, AccountKind]> = [
  [/\b(customers?|clients?|buyers?|debtors?)\b/, 'customer'],
  [/\b(suppliers?|vendors?|sellers?|creditors?)\b/, 'supplier'],
  [/\bloans?\s*(and|&)\s*advances?|\badvances?\b/, 'loan_advance'],
  [/\b(loans?|borrowings?|overdraft|od)\b/, 'loan'],
  [/\bfixed\s+assets?\b/, 'fixed_asset'],
  [/(^|[^n])\bdirect\s+expenses?|\bcost\s+of\s+(goods\s+sold|sales)|\bcogs\b|\bpurchases?\b/, 'direct_expense'],
  [/\bexpenses?\b|\bexp\b/, 'expense'],
  [/(^|[^n])\bdirect\s+income|\bsales\b/, 'direct_income'],
  [/\b(income|revenue)\b/, 'income'],
  [/\b(tax(es)?|duties|gst|vat|tds|tcs|cgst|sgst|igst)\b/, 'tax'],
  [/\bbank\b/, 'bank'],
  [/\bcash\b/, 'cash'],
  [/\b(capital|equity|drawings?|partners?|proprietors?|owners?|reserves?|surplus)\b/, 'capital'],
  [/\b(stock|inventory)\b/, 'stock'],
  [/\binvestments?\b/, 'investment'],
  [/\b(liabilit(y|ies)|provisions?|payables?)\b/, 'liability'],
  [/\b(assets?|deposits?|prepaid|receivables?)\b/, 'asset'],
];
const PARTY_KINDS = new Set<AccountKind>(['customer', 'supplier']);

/** The numbered choices offered when the kind is unclear (see kindQuestion in the flow). */
export const KIND_CHOICES: AccountKind[] = ['customer', 'supplier', 'expense', 'income', 'bank', 'cash', 'capital', 'loan', 'liability', 'asset', 'fixed_asset', 'tax'];

/** "Supplier", "vendor", "7", "partner capital account" → the account kind ("party", "GL" and unknown words → undefined). */
export function normalizeKind(s: string | undefined): AccountKind | undefined {
  if (!s) return undefined;
  const v = s.trim().toLowerCase().replace(/_/g, ' ');
  if (/^\d{1,2}$/.test(v)) return KIND_CHOICES[Number(v) - 1];
  return KIND_PATTERNS.find(([re]) => re.test(v))?.[1];
}

const VERB = String.raw`(?:please\s+)?(?:create|add|new|open|make|register|set\s*up|setup|start|insert|enter|save|put)`;
// Longer phrases first: the first alternative that fits wins ("bank loan" before "bank", "gst payable" before "gst").
const KIND = String.raw`(customers?|clients?|buyers?|debtors?|suppliers?|vendors?|sellers?|creditors?|party|(?:in)?direct\s+(?:expenses?|income)|cost\s+of\s+(?:goods\s+sold|sales)|loans?\s*(?:and|&)\s*advances?|(?:bank|secured|unsecured|car|vehicle|home|term|business)\s+loans?|loans?|advances?|duties\s*(?:and|&)\s*taxes|(?:gst|vat|tds|tcs|cgst|sgst|igst|output|input)\s+(?:payable|receivable|tax(?:es)?)|(?:gst|vat|tds|tcs|cgst|sgst|igst)|tax(?:es)?|(?:partners?'?s?|owners?'?s?|proprietor'?s?|share)\s+capital|capital|equity|drawings?|reserves?|petty\s+cash|bank|cash|(?:fixed|current)\s+assets?|assets?|current\s+liabilit(?:y|ies)|liabilit(?:y|ies)|provisions?|expenses?|income|revenue|sales|purchases?|cogs|deposits?|prepaid|stock|inventory|investments?)`;
const ACC = String.raw`(?:(?:(?:gl|general\s+ledger)\s+)?(?:account|a\/c|acc|ledger|head|master|contact|name)|gl|general\s+ledger)`;
const FILLER = String.raw`(?:(?:a|an|the|new|one|my|our)\s+)*`;
const LINK = String.raw`(?:\s*(?:(?:named|called|name|for|of|as)\b|[:=-])\s*|\s+)`;

/** The name as typed, without quotes or a trailing full stop; Title Case only when it was typed all lower case. */
export function cleanName(s: string): string | undefined {
  const n = s.trim().replace(/^["'“‘]+|["'”’.!]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!n || n.length > 80 || /^\d[\d,.]*$/.test(n)) return undefined;
  return n === n.toLowerCase() ? titleCase(n) : n;
}

/**
 * "Create supplier account AM Motors", "add customer Ravi", "new vendor: AM Motors", "add AM Motors as a supplier",
 * "AM Motors is a new supplier", "open bank account HDFC", "create expense ledger Fuel", "create account for X".
 * Ledger kinds (expense/income/bank/cash) need the word account/ledger, so "add expense 500 for tea" stays an expense.
 */
export function parseCreateAccount(text: string): IntentResult | undefined {
  // "... under Capital Account" / "... in Indirect Expenses group": the group is taken as given
  const full = text.trim().replace(/\s+/g, ' ');
  const under = full.match(/^(.*?)\s+(?:(?:under|inside|within)\s+(?:the\s+)?(.+?)(?:\s+group)?|in\s+(?:the\s+)?(.+?)\s+group)\.?$/i);
  const group = under ? cleanName(under[2] ?? under[3]!) : undefined;
  const r = under && group ? parseCreate(under[1]!) : undefined;
  // Only a ledger takes a group; for anything else ("add customer Ravi under ...") read the message as written.
  if (!r || PARTY_KINDS.has(r.entities.kind as AccountKind)) return parseCreate(full);
  const { party, ...entities } = r.entities;
  return { intent: 'add_account', confidence: r.confidence, entities: { ...entities, group, accountName: entities.accountName ?? party } };
}

function parseCreate(s: string): IntentResult | undefined {
  const result = (kindWord: string | undefined, accWord: boolean, rawName: string): IntentResult | undefined => {
    const kind = normalizeKind(kindWord);
    const hasAccWord = accWord || /^party$/i.test(kindWord ?? ''); // "add party Ravi": a party of unknown kind
    if (kind && !PARTY_KINDS.has(kind) && !hasAccWord) return undefined;
    if (!kind && !hasAccWord) return undefined;
    const name = cleanName(rawName);
    if (!name) return { intent: kind && !PARTY_KINDS.has(kind) ? 'add_account' : 'add_party', confidence: 0.9, entities: { kind } };
    return kind && !PARTY_KINDS.has(kind)
      ? { intent: 'add_account', confidence: 0.9, entities: { kind, accountName: name } }
      : { intent: 'add_party', confidence: 0.9, entities: { kind, party: name } };
  };
  // add AM Motors as (a) supplier (account)
  let m = s.match(new RegExp(String.raw`^${VERB}\s+(.+?)\s+as\s+${FILLER}${KIND}(?:\s+${ACC})?\.?$`, 'i'));
  if (m) return result(m[2], true, m[1]!);
  // AM Motors is a (new) supplier
  m = s.match(new RegExp(String.raw`^(.+?)\s+is\s+${FILLER}${KIND}(?:\s+${ACC})?\.?$`, 'i'));
  if (m && PARTY_KINDS.has(normalizeKind(m[2]) as AccountKind)) return result(m[2], true, m[1]!);
  // create (a new) supplier (account) (named) AM Motors   |   new supplier: AM Motors   |   create account for AM Motors
  m = s.match(new RegExp(String.raw`^${VERB}\s+${FILLER}(?:${KIND}\s*)?(${ACC}s?)?${LINK}(.*)$`, 'i'));
  const named = m && (m[1] || m[2]) ? result(m[1], Boolean(m[2]), m[3] ?? '') : undefined;
  if (named) return named; // else try the no-name form below ("add GST payable ledger")
  m = s.match(new RegExp(String.raw`^${VERB}\s+${FILLER}(?:${KIND})(?:\s+(${ACC}s?))?\s*$`, 'i')); // "add a supplier" (name asked next)
  if (m) return result(m[1], true, '');
  return undefined;
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
    t.match(new RegExp(String.raw`\b(?:paid|sent|transferred|spent|sold|bought|purchased|received|recd|got|collected|gave|given|sale|invoice)\s+(?:me\s+|us\s+)?` + NUM)) ??
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

  const create = parseCreateAccount(text);
  if (create) return create;

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
  // "received 5000 from Ravi" / "got 2k from Shop 24" / "collected 1500 from Anil" → payment_in
  const recv = t.match(/^(?:i |we )?(?:received|recd|got|collected)\b.*?\bfrom\s+([a-z][\w .&-]{1,40})$/);
  if (recv && amount) {
    return { intent: 'payment_in', confidence: 0.85, entities: { amount, currency, paymentMode, date, party: titleCase(recv[1]!) } };
  }

  const pin = t.match(/^([a-z][\w .&-]{1,40}?)\s+(?:paid|sent|transferred|gave)\s+(?:me\s+|us\s+)?/);
  if (pin && amount && !/^(i|we)\b/.test(pin[1]!)) {
    return { intent: 'payment_in', confidence: 0.85, entities: { amount, currency, paymentMode, date, party: titleCase(pin[1]!) } };
  }

  // "paid 15000 rent" / "paid 500 for tea" / "spent 200 on fuel" → expense or supplier payment
  if (/^(i |we )?(paid|spent|bought|purchased|gave)\b/.test(t) && amount) {
    const to = t.match(/\bto\s+([a-z][\w .&-]{1,40})$/)?.[1];
    if (to) return { intent: 'payment_out', confidence: 0.8, entities: { amount, currency, paymentMode, date, party: titleCase(to) } };
    const desc = t.match(/\b(?:for|on)\s+(.+)$/)?.[1] ?? t.replace(/^(i |we )?(paid|spent|bought|purchased|gave)\s+/, '').replace(/[\d,.]+\s*(k|l)?/, '').trim();
    return { intent: 'record_expense', confidence: 0.85, entities: { amount, currency, paymentMode, date, description: desc || undefined } };
  }

  // "sold 5000 to ravi" / "sale 5000 ravi"
  const sale = t.match(/^(?:sold|sale|invoice|bill)\b.*?\bto\s+([a-z][\w .&-]{1,40})$/);
  if (/^(sold|sale|invoice)\b/.test(t) && amount) {
    const party = sale?.[1]!.replace(/\s+(?:for|of|worth)\s+.*$/, '');
    return { intent: 'record_sale', confidence: party ? 0.85 : 0.7, entities: { amount, currency, paymentMode, date, party: party ? titleCase(party) : undefined } };
  }

  if (/^(how much|what|who|show|list|total)\b|\?$/.test(t)) {
    return { intent: 'ask_books', confidence: 0.75, entities: { question: text.trim() } };
  }
  return undefined;
}

const titleCase = (s: string): string => s.trim().replace(/\b\w/g, (c) => c.toUpperCase());
