import type { IntentResult } from '@nextai/shared';

/**
 * Deterministic, zero-cost intent classifier used before the LLM. Handles the common
 * short phrasings ("paid 500 for tea", "Ravi paid 2000", "sold 5000 to Ravi", "report p&l").
 * Returns undefined when unsure so the caller can fall back to the LLM.
 */
export function ruleClassify(text: string): IntentResult | undefined {
  const t = text.trim().toLowerCase();
  const amountMatch = t.match(/(?:rs\.?|₹|inr|aed|dhs?)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|l|lakh)?/i);
  const amount = amountMatch
    ? Number(amountMatch[1]!.replace(/,/g, '')) *
      (amountMatch[2] === 'k' ? 1e3 : amountMatch[2] === 'l' || amountMatch[2] === 'lakh' ? 1e5 : 1)
    : undefined;
  const currency = /aed|dhs?|dirham/.test(t) ? ('AED' as const) : /rs|₹|inr|rupee/.test(t) ? ('INR' as const) : undefined;

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
    return { intent: 'payment_in', confidence: 0.85, entities: { amount, currency, party: titleCase(pin[1]!) } };
  }

  // "paid 15000 rent" / "paid 500 for tea" / "spent 200 on fuel" → expense or supplier payment
  if (/^(i |we )?(paid|spent|bought|purchased)\b/.test(t) && amount) {
    const to = t.match(/\bto\s+([a-z][\w .&-]{1,40})$/)?.[1];
    if (to) return { intent: 'payment_out', confidence: 0.8, entities: { amount, currency, party: titleCase(to) } };
    const desc = t.match(/\b(?:for|on)\s+(.+)$/)?.[1] ?? t.replace(/^(i |we )?(paid|spent|bought|purchased)\s+/, '').replace(/[\d,.]+\s*(k|l)?/, '').trim();
    return { intent: 'record_expense', confidence: 0.85, entities: { amount, currency, description: desc || undefined } };
  }

  // "sold 5000 to ravi" / "sale 5000 ravi"
  const sale = t.match(/^(?:sold|sale|invoice|bill)\b.*?\bto\s+([a-z][\w .&-]{1,40})$/);
  if (/^(sold|sale|invoice)\b/.test(t) && amount) {
    return { intent: 'record_sale', confidence: sale ? 0.85 : 0.7, entities: { amount, currency, party: sale ? titleCase(sale[1]!) : undefined } };
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
