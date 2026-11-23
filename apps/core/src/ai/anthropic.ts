import Anthropic from '@anthropic-ai/sdk';
import { extractionSchema, intentResultSchema, type Country, type Currency, type Language } from '@nextai/shared';
import { z } from 'zod';
import type { AiUsage, LlmProvider, StatementLine, VisionProvider } from './types.js';

/** Default model; override with AI_ANTHROPIC_MODEL. */
const MODEL = process.env.AI_ANTHROPIC_MODEL ?? 'claude-opus-5-5';
// USD per 1M tokens (input, output) for cost dashboards; keep in sync with the model in use.
const PRICE = { input: 4, output: 20 };

type Json = Record<string, unknown>;
/** Convert a Zod schema into a strict JSON schema for structured outputs: all keys required, no extras. */
export function strictJsonSchema(schema: z.ZodType): Json {
  const raw = z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any', reused: 'inline' }) as Json;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Json = {};
    for (const [k, v] of Object.entries(node as Json)) {
      if (['default', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', '$schema'].includes(k)) continue;
      out[k] = walk(v);
    }
    if (out.type === 'object' && out.properties) {
      out.required = Object.keys(out.properties as Json);
      out.additionalProperties = false;
    }
    return out;
  };
  return walk(raw) as Json;
}

const EXTRACTION_JSON = strictJsonSchema(extractionSchema);
const INTENT_JSON = strictJsonSchema(intentResultSchema);
const CHECK_SCHEMA = z.object({ covered: z.array(z.string()) });
const CHECK_JSON = strictJsonSchema(CHECK_SCHEMA);

function parseText<T>(content: Anthropic.ContentBlock[], schema: z.ZodType<T>): T {
  const text = content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return schema.parse(JSON.parse(text));
}

/** Every entity key is required in the output schema, so unused ones come back as "" or 0: drop them before validating. */
export function parseIntent(text: string) {
  const raw = JSON.parse(text) as { entities?: Record<string, unknown> };
  const entities = Object.fromEntries(
    Object.entries(raw.entities ?? {}).filter(([k, v]) => v !== null && v !== '' && !(k === 'amount' && (typeof v !== 'number' || v <= 0)) && !((k === 'date' || k === 'birthDate' || k === 'joiningDate') && !/^\d{4}-\d{2}-\d{2}$/.test(String(v)))),
  );
  return intentResultSchema.parse({ ...raw, entities });
}

function usageOf(u: { input_tokens: number; output_tokens: number }): AiUsage {
  return {
    tokens: u.input_tokens + u.output_tokens,
    costMicros: Math.round(u.input_tokens * PRICE.input + u.output_tokens * PRICE.output),
  };
}

const EXTRACTION_PROMPT = (country: Country, currency: Currency) => `You extract accounting data from a single bill, receipt or invoice for a small business in ${
  country === 'IN' ? 'India (GST: CGST+SGST intra-state, IGST inter-state; GSTIN tax ids)' : 'the UAE (5% VAT; 15-digit TRN tax ids)'
}. Default currency ${currency}.
Rules: dates as YYYY-MM-DD; numbers without separators; null when a field is not visible – never guess tax ids or invoice numbers;
"confidence" (0-1) reflects legibility and completeness of the whole extraction.`;

const STATEMENT_JSON = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD' },
          description: { type: 'string' },
          reference: { type: ['string', 'null'] },
          debit: { type: ['number', 'null'], description: 'money out (withdrawal)' },
          credit: { type: ['number', 'null'], description: 'money in (deposit)' },
          balance: { type: ['number', 'null'] },
        },
        required: ['date', 'description', 'reference', 'debit', 'credit', 'balance'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

export class AnthropicVision implements VisionProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async extract(input: { content: Uint8Array; mime: string; pdfText?: string; country: Country; currency: Currency }) {
    const data = Buffer.from(input.content).toString('base64');
    const media: Anthropic.ContentBlockParam =
      input.mime === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
        : {
            type: 'image',
            source: { type: 'base64', media_type: input.mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data },
          };
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: EXTRACTION_PROMPT(input.country, input.currency),
      output_config: { effort: 'low', format: { type: 'json_schema', schema: EXTRACTION_JSON } },
      messages: [
        {
          role: 'user',
          content: [media, { type: 'text', text: input.pdfText ? `Embedded PDF text:\n${input.pdfText.slice(0, 20000)}` : 'Extract this document.' }],
        },
      ],
    });
    if (response.stop_reason !== 'end_turn') throw new Error(`Vision extraction failed: ${response.stop_reason}`);
    return { extraction: parseText(response.content, extractionSchema), usage: usageOf(response.usage) };
  }

  async extractStatement(input: { content: Uint8Array; mime: string; currency: Currency }) {
    const data = Buffer.from(input.content).toString('base64');
    const media: Anthropic.ContentBlockParam =
      input.mime === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
        : { type: 'image', source: { type: 'base64', media_type: input.mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data } };
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 32000,
      system: `You read bank statements. Return every transaction row of the statement table, in order, exactly as printed:
date as YYYY-MM-DD (statements are day-first), the narration as description, the cheque/reference number if any,
the withdrawal as debit and the deposit as credit (plain numbers in ${input.currency}, no separators; null when empty), and the running balance.
Skip opening/closing balance rows, totals and page headers. Never invent rows.`,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: STATEMENT_JSON } },
      messages: [{ role: 'user', content: [media, { type: 'text', text: 'Extract the transactions.' }] }],
    });
    if (response.stop_reason !== 'end_turn') throw new Error(`Statement extraction failed: ${response.stop_reason}`);
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return { lines: (JSON.parse(text) as { lines: StatementLine[] }).lines, usage: usageOf(response.usage) };
  }
}

/** Intent prompt: everyday, informal and mixed-language phrasing, with examples for every intent. */
export const CLASSIFY_PROMPT = (ctx: { country: Country; currency: Currency; today: string }) => `You read WhatsApp messages from small-business owners and staff in ${ctx.country === 'IN' ? 'India' : 'the UAE'} and decide what they want done in their books.
Today is ${ctx.today}; the business currency is ${ctx.currency}. People write casually: short forms, typos, no punctuation, numbers like 5k / 2 lakh / 1.5L,
and English mixed with Malayalam (Manglish, e.g. "kaasu kitti", "koduthu", "vangi", "add cheyyu") or Arabic. Understand the meaning, not exact words.

Intents (pick exactly one):
- record_expense: they spent money on something. "petrol 500", "tea 50 cash", "paid electricity bill 3200", "rent koduthu 15000",
  "paid salary 25000 to Ajith" (description "salary – Ajith": salary/rent/wages paid to a person are expenses, not supplier payments)
- record_sale: they sold or billed a customer. "sold 5000 to Ravi", "Ravi ku 2000 nte sale", "bill 3500 for Anil"
- record_purchase: they bought goods/services from a named supplier (a supplier bill, usually on credit). "bought cement for 12000 from AM Motors",
  "purchased 9000 from 4L Fashion", "goods received from AM Motors 12000", "AM Motors il ninnu 5000 nte saadhanam vangi"
- sales_return: a customer returned goods (credit note). "Ravi returned goods worth 1500", "sales return 2000 from 4L Fashion", "credit note 500 to Anil"
- purchase_return: they returned goods to a supplier (debit note). "returned 1500 goods to AM Motors", "purchase return 2000 AM Motors", "debit note 800 to X"
- transfer: cash moved between cash in hand and the bank. description "deposit" (cash put into the bank: "deposited 10000 cash in bank",
  "cash deposit 5000") or "withdrawal" (cash taken out of the bank: "withdrew 5000 from bank", "atm 2000", "bank to cash 3000")
- payment_in: money came in from someone: a customer paying, or the owner/director/partner putting in capital, or a loan received.
  "Ravi paid 2000", "got 5k from Shop 24", "received 1500 from Anil by upi", "Anil kaasu thannu 1000",
  "Received Rs 6300 from 4L fashion" (party "4L fashion": names can start with digits; 4L here is part of the name, not 4 lakh),
  "received 50000 cash from Hussain capital account" (party "Hussain capital account", description "capital"),
  "director Hussain brought in 1 lakh" (description "capital"), "loan 2 lakh received from SBI" (party "SBI", description "loan")
- payment_out: money went out to someone: a supplier, a named person, the owner's drawings or a loan repayment.
  "paid 8000 to AM Motors", "gave 500 to Suresh", "advance 2000 to Ravi", "Hussain took 10000 for personal use" (description "drawings"), "repaid 20000 SBI loan" (description "loan")
- add_party: create a customer or supplier (a "party", "account", "contact" or "ledger" for a person or business).
  "Create supplier account AM Motors", "add AM Motors as vendor", "new customer Ravi Traders", "Ravi ne customer aayi add cheyyu"
- add_account: create a ledger (GL account) in the chart of accounts, of any kind. "create expense account Fuel", "open bank account HDFC",
  "create capital account Hussain", "new loan account SBI Car Loan", "add GST payable ledger", "create fixed asset account Delivery Van",
  "create account Hussain Drawings under Capital Account"
- add_employee: add a person to the staff list (an ERPNext Employee). "create employee Sona C", "add staff Ajith", "new employee Rahul joined today",
  "Sona ne employee aayi add cheyyu"
- bank: they want to go through unmatched bank transactions. "bank", "check bank", "reconcile"
- briefing: they want today's overview. "briefing", "summary", "how's business today", "good morning", "innathe kanakku"
- ask_books: a question about their numbers. "how much do customers owe me", "what did I spend on fuel this month", "ethra profit und"
- request_report: P&L, balance sheet, receivables, payables, ledger, cash flow
- send_reminder: remind a customer to pay. "remind Ravi", "Ravi ne remind cheyyu"
- help: greetings or when nothing above fits.

Entities: amount as a plain number (5k → 5000, 2 lakh → 200000); currency only if written; party = the customer/supplier (or employee, for add_employee) name only, never with a date or payment mode attached
("received 1060 from Orbit Travels on nov 18" → party "Orbit Travels", date of Nov 18);
description = what the money was for (say "capital", "drawings" or "loan" when it is one of those; "deposit" or "withdrawal" for transfer); date as YYYY-MM-DD if mentioned; paymentMode = cash, bank, upi, card or credit if mentioned;
kind (add_party / add_account) = one of customer, supplier, expense, direct_expense, income, direct_income, bank, cash, capital, liability, loan,
tax, asset, fixed_asset, loan_advance, stock, investment (empty if not said); accountName (add_account) = the ledger name;
group (add_account) = the account group if they name one ("under Capital Account" → Capital Account), else empty;
question (ask_books) = the question as written; gender (add_employee) = Female, Male or Other if said; birthDate / joiningDate (add_employee) as YYYY-MM-DD if said. Use an empty string (0 for amount) for entities that do not apply.
Prefer a concrete intent over help whenever the meaning is reasonably clear; lower the confidence when unsure.`;

export class AnthropicLlm implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async classify(text: string, ctx: { country: Country; currency: Currency; today: string }) {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: CLASSIFY_PROMPT(ctx),
      output_config: { effort: 'low', format: { type: 'json_schema', schema: INTENT_JSON } },
      messages: [{ role: 'user', content: text }],
    });
    if (response.stop_reason !== 'end_turn') throw new Error(`Intent classification failed: ${response.stop_reason}`);
    const json = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return { result: parseIntent(json), usage: usageOf(response.usage) };
  }

  async chooseAccount(description: string, ledgers: string[], ctx: { country: Country }) {
    const NONE = 'NONE';
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: `You book small-business expenses in ERPNext (${ctx.country === 'IN' ? 'India' : 'UAE'}). Choose the single expense account that best fits the expense, from the company's own chart. Reply ${NONE} only if none is a reasonable fit; prefer a specific account over Miscellaneous Expenses.`,
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: { type: 'object', properties: { account: { type: 'string', enum: [...ledgers, NONE] } }, required: ['account'], additionalProperties: false },
        },
      },
      messages: [{ role: 'user', content: `Expense: ${description.slice(0, 500)}` }],
    });
    if (response.stop_reason !== 'end_turn') return { account: null, usage: usageOf(response.usage) };
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    const picked = (JSON.parse(text) as { account: string }).account;
    return { account: picked === NONE || !ledgers.includes(picked) ? null : picked, usage: usageOf(response.usage) };
  }

  async answer(question: string, context: string, lang: Language) {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      system: `You answer questions about a small business's books using only the data provided. Be brief (WhatsApp-length).
Reply in ${lang === 'ml' ? 'Malayalam' : lang === 'ar' ? 'Arabic' : 'English'}. If the data does not answer the question, say so.`,
      messages: [{ role: 'user', content: `Books data:\n${context}\n\nQuestion: ${question}` }],
    });
    if (response.stop_reason === 'refusal') return { text: 'Sorry, I cannot answer that.', usage: usageOf(response.usage) };
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    return { text, usage: usageOf(response.usage) };
  }

  async summarize(instruction: string, context: string) {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system: `You write short internal updates for a small team's WhatsApp. Use plain text with "•" bullets, at most 8 lines,
no preamble. Only use facts from the data. ${instruction}`,
      messages: [{ role: 'user', content: context.slice(0, 30000) }],
    });
    if (response.stop_reason === 'refusal') return { text: '', usage: usageOf(response.usage) };
    return { text: response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim(), usage: usageOf(response.usage) };
  }

  async checkItems(input: { text: string; fileNames: string[]; items: string[] }) {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1000,
      system: `A business customer is sending onboarding material for their WhatsApp bot. Given their message and the names of
the files they attached, return which checklist items they have provided. Copy items exactly as given; include an item only
when the message or a file clearly supplies it. Messages may be in English, Malayalam (incl. Manglish) or Arabic.`,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: CHECK_JSON } },
      messages: [{ role: 'user', content: `Checklist:\n${input.items.map((i) => `- ${i}`).join('\n')}\n\nFiles: ${input.fileNames.join(', ') || '(none)'}\n\nMessage:\n${input.text.slice(0, 4000) || '(no text)'}` }],
    });
    if (response.stop_reason !== 'end_turn') throw new Error(`Checklist check failed: ${response.stop_reason}`);
    const covered = parseText(response.content, CHECK_SCHEMA).covered.filter((x) => input.items.includes(x));
    return { covered, usage: usageOf(response.usage) };
  }
}
