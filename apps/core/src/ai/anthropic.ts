import Anthropic from '@anthropic-ai/sdk';
import { extractionSchema, intentResultSchema, type Country, type Currency, type Language } from '@nextai/shared';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AiUsage, LlmProvider, VisionProvider } from './types.js';

/** Default model; override with AI_ANTHROPIC_MODEL. */
const MODEL = process.env.AI_ANTHROPIC_MODEL ?? 'claude-opus-5-5';
// USD per 1M tokens (input, output) for cost dashboards; keep in sync with the model in use.
const PRICE = { input: 4, output: 20 };

type Json = Record<string, unknown>;
/** Convert a Zod (v3) schema into a strict JSON schema for structured outputs: all keys required, no extras. */
export function strictJsonSchema(schema: z.ZodTypeAny): Json {
  const raw = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' }) as Json;
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

function parseText<T>(content: Anthropic.ContentBlock[], schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  const text = content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return schema.parse(JSON.parse(text));
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
}

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
      system: `Classify a small-business owner's WhatsApp message into one accounting intent and extract entities.
Today is ${ctx.today}; default currency ${ctx.currency}; country ${ctx.country}. Messages may be in English, Malayalam (incl. Manglish) or Arabic.
Intents: record_expense (they spent money), record_sale (they sold/billed), payment_in (a customer paid them),
payment_out (they paid a supplier), ask_books (question about their numbers), request_report, send_reminder, add_party, help.`,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: INTENT_JSON } },
      messages: [{ role: 'user', content: text }],
    });
    if (response.stop_reason !== 'end_turn') throw new Error(`Intent classification failed: ${response.stop_reason}`);
    return { result: parseText(response.content, intentResultSchema), usage: usageOf(response.usage) };
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
}
