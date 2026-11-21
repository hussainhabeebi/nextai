import type { AccountKind, IntentResult } from '@nextai/shared';

const MODES: Record<string, string> = {
  cash: 'cash', bank: 'bank', 'bank transfer': 'bank', transfer: 'bank', cheque: 'bank', check: 'bank', neft: 'bank', imps: 'bank', rtgs: 'bank',
  card: 'card', 'credit card': 'card', 'debit card': 'card', upi: 'upi', gpay: 'upi', phonepe: 'upi', paytm: 'upi', credit: 'credit',
};
const MODE_RE = /\b(?:by|via|through|thru|using|in|with|from|on)\s+(?:my\s+|the\s+|a\s+)?(bank transfer|credit card|debit card|cash|bank|transfer|cheque|check|neft|imps|rtgs|card|upi|gpay|phonepe|paytm|credit)\b/;
/** "date: 15/11/2026", "on 2026-11-15", "15-11-26", "yesterday" → YYYY-MM-DD (day first, as written in IN/AE). */
const MONTHS = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const ORD = String.raw`(?:st|nd|rd|th)?`;
/** Also "nov 18", "18 Nov", "18th november 2026", "Nov 18, 2026". */
export const DATE_RE = new RegExp(
  String.raw`\b(?:date\s*[:=-]?\s*|dated\s+|on\s+(?:the\s+)?)?(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|yesterday|today|${MONTHS}\s+\d{1,2}${ORD}(?:,?\s+20[2-3]\d)?|\d{1,2}${ORD}\s+(?:of\s+)?${MONTHS}(?:,?\s+20[2-3]\d)?)(?![\w/.-]*\d)\b`,
  'i',
);
const MONTH_NO: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function parseDate(raw: string, now = new Date()): string | undefined {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const s = raw.trim().toLowerCase();
  if (s === 'today') return iso(now);
  if (s === 'yesterday') return iso(new Date(now.getTime() - 86400_000));
  let y: number, m: number, d: number;
  const ymd = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const named = s.toLowerCase().match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/) ??
    s.toLowerCase().match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3})[a-z]*\.?(?:,?\s+(\d{4}))?$/);
  if (ymd) [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  else if (named) {
    const [a, b] = /^\d/.test(named[1]!) ? [named[2]!, named[1]!] : [named[1]!, named[2]!];
    m = MONTH_NO[a]!;
    d = Number(b);
    if (!m) return undefined;
    y = named[3] ? Number(named[3]) : now.getUTCFullYear();
    // "dec 20" written in January means last December, not a date eleven months ahead.
    if (!named[3] && Date.UTC(y, m - 1, d) > now.getTime() + 31 * 86400_000) y -= 1;
  } else {
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

const STAFF = String.raw`(?:employees?|staff(?:\s+member)?|worker|salesman|salesperson|helper|driver)`;
const GENDER_RE = /\b(female|male|woman|man|lady|girl|boy|other)\b/i;
const genderOf = (w: string | undefined) => (!w ? undefined : /^(female|woman|lady|girl)$/i.test(w) ? 'Female' : /^(male|man|boy)$/i.test(w) ? 'Male' : 'Other');

/**
 * "Create Employee Sona C", "add staff Ajith", "new employee: Rahul K", "add Sona C as employee",
 * "create employee Sona C female born 12/03/1995 joined today".
 */
export function parseCreateEmployee(text: string): IntentResult | undefined {
  const s = text.trim().replace(/\s+/g, ' ');
  const m =
    s.match(new RegExp(String.raw`^${VERB}\s+${FILLER}${STAFF}${LINK}(.*)$`, 'i')) ??
    s.match(new RegExp(String.raw`^${VERB}\s+${FILLER}${STAFF}()\.?$`, 'i')) ??
    s.match(new RegExp(String.raw`^(?:${VERB}|hire|hired|appoint|appointed)\s+(.+?)\s+as\s+${FILLER}${STAFF}\.?$`, 'i'));
  if (!m) return undefined;
  let rest = m[1] ?? '';
  const take = (re: RegExp) => {
    const hit = rest.match(re);
    if (hit) rest = rest.replace(hit[0], ' ').replace(/\s+/g, ' ').trim();
    return hit;
  };
  const DATE = String.raw`(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|today|yesterday|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+\.?(?:,?\s+\d{4})?|[a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)`;
  const dob = take(new RegExp(String.raw`[,;]?\s*\b(?:born(?:\s+on)?|dob|d\.o\.b\.?|date\s+of\s+birth|birth\s*date|birthday)\s*[:=-]?\s*${DATE}`, 'i'));
  const doj = take(new RegExp(String.raw`[,;]?\s*\b(?:joined|joining(?:\s+date)?|doj|date\s+of\s+joining|from|starting|starts?)\s*(?:on\s+)?[:=-]?\s*${DATE}`, 'i'));
  const g = take(new RegExp(String.raw`[,;]?\s*(?:gender\s*[:=-]?\s*)?${GENDER_RE.source}\s*$`, 'i'));
  const name = cleanName(rest.replace(/[,;]+$/, ''));
  const entities: IntentResult['entities'] = { party: name };
  const birthDate = dob ? parseDate(dob[1]!) : undefined;
  const joiningDate = doj ? parseDate(doj[1]!) : undefined;
  if (birthDate) entities.birthDate = birthDate;
  if (joiningDate) entities.joiningDate = joiningDate;
  if (g) entities.gender = genderOf(g[1]);
  if (!name) delete entities.party;
  return { intent: 'add_employee', confidence: 0.9, entities };
}

// ---------------- Money messages ----------------

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)\s*(?:(k|lakhs?|lacs?|l|crores?|cr)(?![a-z]))?`;
const CUR = String.raw`(?<![a-z])(?:rs\.?|₹|inr|aed|dhs?|usd|\$)`;
const CUR_AFTER = String.raw`(?:rs|rupees?|inr|aed|dhs?|dirhams?|usd|dollars?|\/-)(?![a-z])`;
const VERBS = 'paid|pay|sent|transferred|spent|sold|bought|purchased|received|recd|rcvd|recieved|got|collected|gave|given|sale|invoice|invoiced|billed|bill|deposited|withdrew|returned|return|credited|debited';
/** An amount written before the verb: "6300 received from …", "rs 500 paid to …". */
const LEAD = String.raw`(?:(?:rs\.?|₹|inr|aed|dhs?|usd|\$)?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|lakhs?|l)?\s*(?:rs|\/-|aed|inr)?\s+)?`;
/** A customer/supplier name: may start with a digit ("4L Fashion", "24 Seven Mart"). */
const NAME = String.raw`([a-z0-9][^,;:\n]{0,80}?)`;
const SUBJECT_PRONOUN = /^(i|we|me|us|i have|we have|i've|we've|he|she|they|you)$/;
/** Words that are not a customer/supplier name on their own. */
const NOT_A_PARTY = /^(bank|the bank|cash|atm|account|customer|client|supplier|vendor|him|her|them|it|someone|party|shop|office|counter|goods|items?|stock)$/;
/** What the money was for, when that's an expense rather than a person ("paid salary 20000 to Ajith"). */
const EXPENSE_WORDS = /\b(rent|salary|salaries|wages?|electricity|current bill|water bill|internet|wifi|phone bill|mobile bill|recharge|petrol|diesel|fuel|tea|coffee|food|lunch|dinner|snacks|transport|freight|courier|repairs?|maintenance|stationery|printing|advertising|ads?|insurance|fees?|commission|bonus|incentive|travel|taxi|cab|parking|toll|loading|unloading|labour|labor|cleaning|allowance|overtime)\b/;
/** Standalone payment words ("6300 cash", "cash sale", "via gpay" is handled by MODE_RE). */
const MODE_WORD = /(?<![a-z])(cash|upi|gpay|google pay|phonepe|paytm|neft|imps|rtgs|cheque)(?![a-z])/;

/** The amount in a message: a currency-marked number, then "for/worth N", then the number after the verb, then the first number. */
export function readAmount(s: string): number | undefined {
  const m =
    s.match(new RegExp(String.raw`${CUR}\s*${NUM}`)) ??
    s.match(new RegExp(String.raw`(?<![\w.])${NUM}\s*${CUR_AFTER}`)) ??
    s.match(new RegExp(String.raw`\b(?:for|worth|of|total|amount|amt|value|@|=)\s*${NUM}(?=\s*(?:$|from\b|to\b|by\b|only\b|cash\b|credit\b|[,.;]))`)) ??
    s.match(new RegExp(String.raw`\b(?:${VERBS})\s+(?:me\s+|us\s+)?${NUM}`)) ??
    s.match(new RegExp(String.raw`(?<![a-z\d])${NUM}`));
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, ''));
  const unit = m[2] ?? '';
  const mult = unit === 'k' ? 1e3 : /^(l|lakhs?|lacs?)$/.test(unit) ? 1e5 : /^(cr|crores?)$/.test(unit) ? 1e7 : 1;
  const v = n * mult;
  return v > 0 ? v : undefined;
}

/** Remove an amount (with its currency) from a phrase: "cement for rs 12000" → "cement". */
const stripAmount = (s: string) =>
  s
    .replace(new RegExp(String.raw`(?:\b(?:for|worth|of|amount|amt|value)\s+)?(?:${CUR}\s*)?(?<![a-z\d])${NUM}(?:\s*${CUR_AFTER})?`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Deterministic, zero-cost intent classifier used before the LLM. Handles the common
 * short phrasings ("paid 500 for tea", "Ravi paid 2000", "sold 5000 to Ravi", "report p&l").
 * Returns undefined when unsure so the caller can fall back to the LLM.
 */
export function ruleClassify(text: string): IntentResult | undefined {
  const raw = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const typed = (part: string) => asTyped(text, part); // names keep the casing they were typed with ("SBI", "4L Fashion")
  // "by bank" / "via upi" / "using card" → payment mode; removed so it doesn't end up in party names.
  const modeMatch = raw.match(MODE_RE);
  let paymentMode = modeMatch ? MODES[modeMatch[1]!.replace(/\s+/g, ' ')] : undefined;
  const noMode = modeMatch ? raw.replace(MODE_RE, ' ') : raw;
  const dateMatch = noMode.match(DATE_RE);
  const date = dateMatch ? parseDate(dateMatch[1]!) : undefined;
  // Remove the mode and date phrases so they don't end up in amounts, party names or descriptions.
  let t = (date ? noMode.replace(DATE_RE, ' ') : noMode).replace(/\s+/g, ' ').replace(/\s*[:,;.!-]+\s*$/, '').trim();
  // Word-level currency (whole words only: "Traders" is not "rs", "Siddharth" not "dh").
  const word = (w: string) => new RegExp(String.raw`(?<![a-z])(?:${w})(?![a-z])`).test(t);
  const currency = word('aed|dhs?|dirhams?')
    ? ('AED' as const)
    : /₹/.test(t) || word(String.raw`rs\.?|inr|rupees?`)
      ? ('INR' as const)
      : /\$/.test(t) || word('usd|dollars?')
        ? ('USD' as const)
        : undefined;

  if (/^(help|menu|hi|hello|start|\?)$/.test(t)) return { intent: 'help', confidence: 0.95, entities: {} };

  if (/^(daily\s+)?(briefing|brief|summary|update)$|^(today'?s?\s+)?(summary|briefing|update)$|^how'?s\s+(the\s+)?business(\s+today)?\??$|^good\s+morning!?$/.test(t)) {
    return { intent: 'briefing', confidence: 0.9, entities: {} };
  }

  if (/^(bank|bank lines?|check bank|bank check|reconcile|bank reconciliation|match bank)$/.test(t)) return { intent: 'bank', confidence: 0.9, entities: {} };

  const employee = parseCreateEmployee(text);
  if (employee) return employee;
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

  // ---- Cash ↔ bank (ERPNext Contra Entry). Read from the raw text: "in bank" / "from bank" are not payment modes here.
  const contra = transferKind(raw);
  if (contra) {
    const amount = readAmount(raw.replace(DATE_RE, ' '));
    return { intent: 'transfer', confidence: 0.9, entities: { amount, currency, date, description: contra } };
  }

  // A standalone "cash" / "upi" / "cheque" word is a payment mode too ("received 6300 cash from Ravi").
  if (!paymentMode) {
    const w = t.match(MODE_WORD);
    if (w && !/^cash\s+(sale|sales|purchase)/.test(t)) {
      paymentMode = MODES[w[1]!] ?? (w[1] === 'google pay' ? 'upi' : undefined);
      t = t.replace(MODE_WORD, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  const base = { currency, paymentMode, date };

  /** Build a money result: the party is validated, its trailing "for …" becomes the description, the amount is read without it. */
  const money = (
    intent: IntentResult['intent'],
    confidence: number,
    partyMatch: RegExpMatchArray | null | undefined,
    extra: { description?: string; needsParty?: boolean } = {},
    g = 1, // the capture group holding the name
  ): IntentResult | undefined => {
    let party: string | undefined;
    let description = extra.description;
    let rest = t;
    let amount: number | undefined;
    let keepDescription = false;
    if (partyMatch) {
      const name = partyMatch[g]!;
      const whole = partyMatch[0];
      // The name is either the end of the match ("… from 4l fashion") or its start ("ravi paid").
      const i = partyMatch.index! + (whole.endsWith(name) ? whole.length - name.length : whole.indexOf(name));
      let cand = name.trim();
      rest = `${t.slice(0, i)} ${t.slice(i + name.length)}`;
      const tail = cand.match(/\s+(?:for|against|towards|being|as|on account of|ref|regarding)\s+(.+)$/);
      amount = readAmount(rest);
      if (tail) {
        cand = cand.slice(0, tail.index);
        description ??= amount === undefined ? tail[1] : tail[1]!.trim(); // "against invoice 12" keeps its number
        if (amount === undefined) amount = readAmount(tail[1]!);
        else keepDescription = true;
      }
      if (amount === undefined) {
        // "received from 4L Fashion 6300": the amount is at the end of the name
        const m = cand.match(new RegExp(String.raw`^(.*?)\s+((?:${CUR}\s*)?\d[\d,]*(?:\.\d+)?\s*(?:k|lakhs?|l)?(?:\s*${CUR_AFTER})?)$`));
        if (m && /[a-z]/.test(m[1]!)) {
          cand = m[1]!;
          amount = readAmount(m[2]!);
        }
      }
      cand = cand.replace(/\s+(?:today|now|only|sir|ji|bhai)$/, '').replace(/^(?:mr\.?|mrs\.?|ms\.?|m\/s\.?)\s+/, '').trim();
      if (!/[a-z]/.test(cand) || NOT_A_PARTY.test(cand) || SUBJECT_PRONOUN.test(cand)) return undefined;
      party = typed(cand);
    } else {
      amount = readAmount(rest);
    }
    if (description && !keepDescription) description = stripAmount(description) || undefined;
    if (amount === undefined && !party) return undefined;
    if (extra.needsParty && !party) return undefined;
    return { intent, confidence, entities: { amount, ...base, party, description } };
  };

  // ---- Returns: credit note (customer returned goods) / debit note (we returned goods to a supplier)
  if (/\b(purchase\s+returns?|debit\s+note|dn)\b/.test(t)) {
    return money('purchase_return', 0.85, t.match(new RegExp(String.raw`\b(?:to|from|for|of)\s+${NAME}$`)) ?? t.match(new RegExp(String.raw`\b(?:returns?|note|dn)\s+(?:\d[\d,.]*\s*(?:k|l)?\s+)?(?:rs\.?\s*)?${NAME}$`)));
  }
  if (/\b(sales?\s+returns?|credit\s+note|cn)\b/.test(t)) {
    return money('sales_return', 0.85, t.match(new RegExp(String.raw`\b(?:from|by|to|for|of)\s+${NAME}$`)) ?? t.match(new RegExp(String.raw`\b(?:returns?|note|cn)\s+(?:\d[\d,.]*\s*(?:k|l)?\s+)?(?:rs\.?\s*)?${NAME}$`)));
  }
  let m = t.match(new RegExp(String.raw`^(?:i |we )?(?:have\s+)?(?:returned|return(?:ed)?\s+(?:the\s+)?(?:goods|items|stock|material))\b.*?\bto\s+${NAME}$`));
  if (m) return money('purchase_return', 0.85, m);
  m = t.match(new RegExp(String.raw`\b(?:goods|items|stock)?\s*returned\s+by\s+${NAME}$`)) ?? t.match(new RegExp(String.raw`^${NAME}\s+(?:has\s+)?returned\b`)) ?? t.match(new RegExp(String.raw`^(?:goods\s+)?returns?\s+from\s+${NAME}$`));
  if (m && !SUBJECT_PRONOUN.test(m[1]!.trim())) return money('sales_return', 0.85, m);

  // ---- Purchases from a supplier (Purchase Invoice): "bought cement for 12000 from AM Motors", "goods received from X 12000"
  m =
    t.match(new RegExp(String.raw`^(?:i |we )?${LEAD}(?:bought|purchased|purchase|purchases|buy|ordered)\b.*?\bfrom\s+${NAME}$`)) ??
    t.match(new RegExp(String.raw`^${LEAD}(?:goods|stock|materials?|items|purchase bill|purchase invoice|bill|invoice)\s+(?:received\s+|purchased\s+|bought\s+)?from\s+${NAME}$`));
  if (m) {
    const what = t.slice(0, m.index! + m[0].lastIndexOf(' from ')).replace(/^(?:i |we )?(?:bought|purchased|purchases|purchase|buy|ordered)\b/, '');
    const desc = stripAmount(what).replace(/^(?:goods|stock|materials?|items|purchase bill|purchase invoice|bill|invoice)(?:\s+(?:received|purchased|bought))?$/, '').trim();
    return money('record_purchase', 0.85, m, { description: desc || undefined });
  }

  // ---- Money in (Payment Entry: Receive) ----
  // "received 5000 from Ravi" / "6300 received from 4L Fashion" / "payment from Shop 24 2000" / "credited 500 by Anil"
  m = t.match(new RegExp(String.raw`^(?:i |we )?(?:have\s+)?${LEAD}(?:received|recd|rcvd|recieved|receive|got|collected|collection|payment|payments|amount|credited|credit|came|cash received|advance received|advance|deposit|deposited)\b.*?\b(?:from|by)\s+${NAME}$`));
  if (m && !/^(?:credited|credit)\b.*\bfrom\s+(?:bank|account)\b/.test(t)) {
    const r = money('payment_in', 0.85, m);
    if (r) return r;
  }
  // "Hussain introduced capital 50000" / "director brought in 1 lakh" / "owner invested 20000" → money in (capital)
  m = t.match(/^([a-z0-9][\w .&'-]{0,40}?)\s+(?:introduced|invested|brought(?:\s+in)?|contributed|put\s+in|added)\b/);
  if (m && !SUBJECT_PRONOUN.test(m[1]!)) {
    const r = money('payment_in', 0.85, m, { description: 'capital' });
    if (r?.entities.amount) return r;
  }
  // "Ravi paid 2000" / "4L Fashion paid 6300" / "Anil gave 1500" / "Shop 24 has sent 2k"
  m = t.match(/^([a-z0-9][\w .&'()/-]{0,60}?)\s+(?:has\s+|have\s+)?(?:paid|sent|transferred|gave|given|deposited|credited|cleared|settled|remitted)\b/);
  if (m && !SUBJECT_PRONOUN.test(m[1]!.trim())) {
    const who = m[1]!.trim();
    if (EXPENSE_WORDS.test(who)) {
      // "rent paid 15000" / "salary paid 20000": an expense, not a customer paying
      const r = money('record_expense', 0.85, undefined, { description: stripAmount(who) });
      if (r?.entities.amount) return r;
    } else {
      const r = money('payment_in', 0.85, m);
      if (r?.entities.amount) return r;
    }
  }

  // ---- Money out (Payment Entry: Pay, or an expense) ----
  // "paid 8000 to AM Motors" / "5000 paid to AM Motors" / "payment to X 3000" / "paid salary 20000 to Ajith"
  m = t.match(new RegExp(String.raw`^(?:i |we )?(?:have\s+)?${LEAD}(?:paid|pay|sent|send|transferred|transfer|gave|given|payment|payments|settled|cleared|remitted|advance)\b(.*?)\bto\s+${NAME}$`));
  if (m && (/^(?:i |we )?(?:have\s+)?\S*\s*(?:paid|pay|gave|given|payment|settled|cleared|remitted|advance)\b/.test(t) || readAmount(t) !== undefined)) {
    const between = m[1]!;
    const who = m[2]!;
    if (EXPENSE_WORDS.test(between)) {
      // An expense paid to a person: book the expense, keep the name in the description.
      const what = stripAmount(between).replace(/^(?:for|of)\s+/, '').trim();
      const r = money('record_expense', 0.85, undefined, { description: `${what} – ${typed(who.trim())}` });
      if (r?.entities.amount) return r;
    } else {
      const r = money('payment_out', 0.85, m, {}, 2);
      if (r) return r;
    }
  }

  // "paid 15000 rent" / "paid 500 for tea" / "spent 200 on fuel" / "rent 15000" → expense
  if (/^(i |we )?(paid|spent|bought|purchased|gave|given|expense|exp)\b/.test(t)) {
    const amount = readAmount(t);
    if (amount) {
      const desc =
        t.match(/\b(?:for|on)\s+(.+)$/)?.[1] ??
        stripAmount(t.replace(/^(i |we )?(paid|spent|bought|purchased|gave|given|expense|exp)\s+/, ''));
      return { intent: 'record_expense', confidence: 0.85, entities: { amount, ...base, description: stripAmount(desc) || undefined } };
    }
  }
  if (EXPENSE_WORDS.test(t) && /^[a-z ]{2,40}\s+(?:bill\s+)?(?:rs\.?\s*|₹\s*)?\d[\d,]*(?:\.\d+)?\s*(?:k|l)?(?:\s*(?:rs|\/-))?$/.test(t)) {
    // "petrol 500", "rent 15000", "electricity bill 3200"
    const amount = readAmount(t);
    if (amount) return { intent: 'record_expense', confidence: 0.85, entities: { amount, ...base, description: stripAmount(t) } };
  }

  // ---- Sales (Sales Invoice) ----
  // "sold 5000 to Ravi" / "sold goods worth 5000 to 4L Fashion" / "sale 5000 Ravi" / "bill 3500 for Anil" / "invoice Ravi 5000"
  if (/^(?:credit\s+|cash\s+)?(?:sold|sale|sales|sell|invoice|invoiced|bill|billed)\b/.test(t) || /^\S+\s+(?:sold|billed|invoiced)\b/.test(t)) {
    const sale = t.match(new RegExp(String.raw`\bto\s+${NAME}$`)) ?? t.match(new RegExp(String.raw`^(?:credit\s+|cash\s+)?(?:sold|sale|sales|sell|bill|billed|invoice|invoiced)\b.*?\bfor\s+${NAME}$`));
    if (sale) {
      const r = money('record_sale', 0.85, sale);
      if (r?.entities.amount && r.entities.party) {
        if (/^cash\s+/.test(t) && !r.entities.paymentMode) r.entities.paymentMode = 'cash';
        return r;
      }
    }
    // no "to": the words left after the verb and amount are the customer, when there are any ("invoice Ravi 5000")
    const amount = readAmount(t);
    if (amount) {
      const left = stripAmount(t.replace(/^(?:credit\s+|cash\s+)?(?:sold|sale|sales|sell|invoice|invoiced|bill|billed)\s*/, '')).replace(/^(?:to|for)\s+/, '').trim();
      const looksLikeName = left && /[a-z]/.test(left) && !/\b(goods|items?|stock|products?|shirts?|bags?|pcs|pieces|nos|kg|units?|worth)\b/.test(left) && !NOT_A_PARTY.test(left);
      return {
        intent: 'record_sale',
        confidence: looksLikeName ? 0.75 : 0.7,
        entities: { amount, ...base, party: looksLikeName ? typed(left) : undefined, ...(/^cash\s+/.test(t) && !paymentMode ? { paymentMode: 'cash' } : {}) },
      };
    }
  }
  // "Ravi bought goods worth 5000" (a customer bought from us)
  m = t.match(/^([a-z0-9][\w .&'-]{0,40}?)\s+(?:bought|purchased|took)\s+(?:goods|items|stock|products?)\b/);
  if (m && !SUBJECT_PRONOUN.test(m[1]!.trim())) {
    const r = money('record_sale', 0.8, m);
    if (r?.entities.amount) return r;
  }

  if (/^(how much|how many|what|who|which|when|show|list|total|did|do|does|is|are|any)\b|\?$/.test(t)) {
    return { intent: 'ask_books', confidence: 0.75, entities: { question: text.trim() } };
  }
  return undefined;
}

/** Cash deposited into the bank, or cash withdrawn from it (an ERPNext Contra Entry). */
function transferKind(t: string): 'deposit' | 'withdrawal' | undefined {
  const dir = t.match(/\bfrom\s+(?:the\s+|my\s+)?(cash|bank|[a-z]+\s+bank)\s+(?:a\/c\s+|account\s+)?to\s+(?:the\s+|my\s+)?(cash|bank|[a-z]+\s+bank|hand)\b/) ?? t.match(/^(cash|bank)\s+to\s+(cash|bank|hand)\b/);
  if (dir) {
    const from = /bank/.test(dir[1]!) ? 'bank' : 'cash';
    const to = /bank/.test(dir[2]!) ? 'bank' : 'cash';
    if (from !== to) return to === 'bank' ? 'deposit' : 'withdrawal';
  }
  const personal = /\b(personal|home|house|drawings?|family|myself|self use|own use)\b/.test(t);
  if (/^(?:i |we )?(?:have\s+)?(?:cash\s+)?deposit(?:ed)?\b/.test(t) && !/\bfrom\s+(?!cash\b|counter\b|shop\b|till\b|office\b|sales?\b|the\s+(?:shop|counter|till))[a-z0-9]/.test(t)) return 'deposit';
  if (/^(?:i |we )?(?:put|kept)\b.*\bin(?:to)?\s+(?:the\s+|my\s+)?(?:[a-z]+\s+)?bank\b/.test(t)) return 'deposit';
  if (/^(?:cdm|cash deposit)\b/.test(t)) return 'deposit';
  if (!personal && /^(?:i |we )?(?:have\s+)?(?:withdrew|withdrawn|withdraw|withdrawal|cash withdrawal|atm withdrawal|atm|took out|taken out|took cash|cash taken)\b/.test(t)) {
    if (/^(?:atm|cash withdrawal|atm withdrawal)\b/.test(t) || /\b(bank|atm|a\/c|account)\b/.test(t)) return 'withdrawal';
  }
  return undefined;
}

const titleCase = (s: string): string => s.trim().replace(/\b\w/g, (c) => c.toUpperCase());

/** `part` (found in the lower-cased message) as it was typed; Title Case when it was typed all lower case. */
function asTyped(original: string, part: string): string {
  const p = part.trim();
  const flat = original.replace(/\s+/g, ' ');
  const i = flat.toLowerCase().indexOf(p.toLowerCase());
  const typed = i >= 0 ? flat.slice(i, i + p.length) : p;
  return typed === typed.toLowerCase() ? titleCase(typed) : typed;
}
