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
}

export interface SttProvider {
  readonly name: string;
  transcribe(input: { content: Uint8Array; mime: string; language?: Language }): Promise<{ text: string; language: Language; usage: AiUsage }>;
}

export interface LlmProvider {
  readonly name: string;
  classify(text: string, ctx: { country: Country; currency: Currency; today: string }): Promise<{ result: IntentResult; usage: AiUsage }>;
  answer(question: string, context: string, lang: Language): Promise<{ text: string; usage: AiUsage }>;
  /** Which checklist items does a customer's message (text + attached file names) cover? Returns items verbatim. */
  checkItems(input: { text: string; fileNames: string[]; items: string[] }): Promise<{ covered: string[]; usage: AiUsage }>;
}

export interface AiProviders {
  vision: VisionProvider;
  stt: SttProvider;
  llm: LlmProvider;
}
