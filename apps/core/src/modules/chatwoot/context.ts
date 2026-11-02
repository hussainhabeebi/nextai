import type { Language } from '@nextai/shared';
import type { Tenant, User } from '@prisma/client';
import type { Container } from '../../container.js';

/** Everything a bot handler needs for one inbound message. */
export interface BotContext {
  c: Container;
  tenant: Tenant;
  user: User;
  conversationId: number;
  lang: Language;
}

export async function say(ctx: BotContext, text: string): Promise<void> {
  await ctx.c.chatwoot(ctx.tenant).sendText(ctx.conversationId, text);
}
