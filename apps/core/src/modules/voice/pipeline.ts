import type { Language } from '@nextai/shared';
import type { Container } from '../../container.js';
import { tenantDb, withSystemTx } from '../../lib/db.js';
import type { BotContext } from '../chatwoot/context.js';
import { handleText } from '../intents/flow.js';
import { incrementUsage } from '../usage/usage.js';

export interface VoiceJob {
  tenantId: string;
  r2Key: string;
  mime: string;
  conversationId: number;
  userId: string;
}

/** voice.process: speech-to-text (en/ml/ar) → same deterministic flow engine as typed text. */
export async function processVoice(c: Container, job: VoiceJob): Promise<string> {
  const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: job.tenantId } }));
  const user = await tenantDb(c.prisma, tenant.id).user.findUniqueOrThrow({ where: { id: job.userId } });
  const audio = await c.storage.get(tenant.id, job.r2Key);
  const lang = ((user.language ?? tenant.language) as Language) ?? 'en';
  const { text, language, usage } = await c.ai.stt.transcribe({ content: audio.body, mime: job.mime, language: lang });
  await incrementUsage(c.prisma, tenant.id, { aiTokens: usage.tokens, aiCostMicros: usage.costMicros });
  const ctx: BotContext = { c, tenant, user, conversationId: job.conversationId, lang: language };
  await c.chatwoot(tenant).sendText(job.conversationId, `🎙️ "${text.slice(0, 200)}"`);
  await handleText(ctx, text);
  return text;
}
