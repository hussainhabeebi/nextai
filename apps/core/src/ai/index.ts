import type { Env } from '../config/env.js';
import { AnthropicLlm, AnthropicVision } from './anthropic.js';
import { MockLlm, MockStt, MockVision } from './mock.js';
import type { AiProviders, SttProvider } from './types.js';

export * from './types.js';
export { ruleClassify } from './rules.js';

/**
 * Provider-agnostic factory. Add new adapters (OpenAI, Google, Deepgram…) by implementing
 * VisionProvider / SttProvider / LlmProvider and registering them here.
 */
export function createAiProviders(e: Env): AiProviders {
  const need = (key: string | undefined, name: string): string => {
    if (!key) throw new Error(`${name} API key missing`);
    return key;
  };
  const vision =
    e.AI_VISION_PROVIDER === 'anthropic' ? new AnthropicVision(need(e.AI_VISION_API_KEY, 'AI_VISION')) : new MockVision();
  const llm = e.AI_LLM_PROVIDER === 'anthropic' ? new AnthropicLlm(need(e.AI_LLM_API_KEY, 'AI_LLM')) : new MockLlm();
  const stt: SttProvider = new MockStt();
  if (e.AI_STT_PROVIDER !== 'mock') {
    // TODO: add a speech-to-text adapter supporting en/ml/ar (e.g. Whisper-compatible or Deepgram) behind SttProvider.
    throw new Error(`Unsupported AI_STT_PROVIDER: ${e.AI_STT_PROVIDER}`);
  }
  return { vision, stt, llm };
}
