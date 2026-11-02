import { t } from '@nextai/shared';
import type { BotContext } from '../chatwoot/context.js';
import { say } from '../chatwoot/context.js';

/** Deterministic flow engine entry point (expanded in milestone 3). */
export async function handleText(ctx: BotContext, text: string): Promise<void> {
  void text;
  await say(ctx, t(ctx.lang, 'bot.help'));
}
