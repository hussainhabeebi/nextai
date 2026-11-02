import { extractionSchema, type Extraction } from '@nextai/shared';
import { ruleClassify } from './rules.js';
import type { LlmProvider, SttProvider, VisionProvider } from './types.js';

const zero = { tokens: 0, costMicros: 0 };

/**
 * Mock vision: if the file bytes are a JSON Extraction (used by tests/fixtures) return it,
 * otherwise return a plausible low-confidence receipt so the flow ends up in review.
 */
export class MockVision implements VisionProvider {
  readonly name = 'mock';
  async extract(input: { content: Uint8Array; currency: Extraction['currency'] }) {
    try {
      const parsed = extractionSchema.parse(JSON.parse(new TextDecoder().decode(input.content)));
      return { extraction: parsed, usage: { tokens: 1000, costMicros: 3000 } };
    } catch {
      const extraction: Extraction = {
        docType: 'receipt',
        supplierName: 'Unknown Store',
        supplierTaxId: null,
        invoiceNo: null,
        date: new Date().toISOString().slice(0, 10),
        currency: input.currency,
        lines: [{ description: 'Purchase', qty: 1, rate: 100, amount: 100 }],
        subtotal: 100,
        tax: { cgst: 0, sgst: 0, igst: 0, vat: 0 },
        total: 100,
        paymentMode: 'cash',
        confidence: 0.4,
      };
      return { extraction, usage: zero };
    }
  }
}

/** Mock STT: audio bytes are treated as UTF-8 text. */
export class MockStt implements SttProvider {
  readonly name = 'mock';
  async transcribe(input: { content: Uint8Array; language?: 'en' | 'ml' | 'ar' }) {
    return { text: new TextDecoder().decode(input.content), language: input.language ?? 'en', usage: zero } as const;
  }
}

export class MockLlm implements LlmProvider {
  readonly name = 'mock';
  async classify(text: string) {
    return { result: ruleClassify(text) ?? { intent: 'help' as const, confidence: 0.3, entities: {} }, usage: zero };
  }
  async answer(question: string, context: string) {
    return { text: `Based on your books: ${context.slice(0, 400)}`, usage: zero };
  }
}
