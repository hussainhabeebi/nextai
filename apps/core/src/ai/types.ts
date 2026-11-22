import type { Country, Currency, Extraction, IntentResult, Language } from '@nextai/shared';

export interface AiUsage {
  tokens: number;
  costMicros: number; // USD micros, for usage/cost dashboards
}

export interface VisionProvider {
  readonly name: string;
  extract(input: {
    content: Uint8Array;
    mime: string;
    pdfText?: string;
    country: Country;
    currency: Currency;
  }): Promise<{ extraction: Extraction; usage: AiUsage }>;
  /** Read the transaction table of a bank statement (PDF or photo). Optional: CSV statements don't need it. */
  extractStatement?(input: { content: Uint8Array; mime: string; currency: Currency }): Promise<{ lines: StatementLine[]; usage: AiUsage }>;
}

export interface StatementLine {
  date: string; // YYYY-MM-DD
  description: string;
  reference: string | null;
  debit: number | null; // money out
  credit: number | null; // money in
  balance: number | null;
}

export interface SttProvider {
  readonly name: string;
  transcribe(input: { content: Uint8Array; mime: string; language?: Language }): Promise<{ text: string; language: Language; usage: AiUsage }>;
}

export interface LlmProvider {
  readonly name: string;
  classify(text: string, ctx: { country: Country; currency: Currency; today: string }): Promise<{ result: IntentResult; usage: AiUsage }>;
  answer(question: string, context: string, lang: Language): Promise<{ text: string; usage: AiUsage }>;
  /** Short WhatsApp-length summary of `context` following `instruction` (team updates, meeting notes). */
  summarize(instruction: string, context: string): Promise<{ text: string; usage: AiUsage }>;
  /** Which checklist items does a customer's message (text + attached file names) cover? Returns items verbatim. */
  checkItems(input: { text: string; fileNames: string[]; items: string[] }): Promise<{ covered: string[]; usage: AiUsage }>;
  /** Pick the best expense ledger for a description from the company's own list (null = none fits). Optional. */
  chooseAccount?(description: string, ledgers: string[], ctx: { country: Country }): Promise<{ account: string | null; usage: AiUsage }>;
}

export interface AiProviders {
  vision: VisionProvider;
  stt: SttProvider;
  llm: LlmProvider;
}
