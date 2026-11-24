import { CONVERSATION_TTL_SECONDS, type Intent } from '@nextai/shared';
import type { Redis } from 'ioredis';

export type ConversationStep = 'idle' | 'awaiting_confirm' | 'awaiting_edit' | 'awaiting_field' | 'awaiting_party' | 'handover';

export interface ConversationState {
  step: ConversationStep;
  draftId?: string;
  field?: string;
  pendingIntent?: Intent;
  partial?: Record<string, unknown>;
  /** awaiting_party: the numbered options that were offered. */
  choices?: Array<{ title: string; value: string }>;
  /** awaiting_party: the bank line the entry being drafted is for. */
  bankLineId?: string;
  updatedAt: number;
}

export interface ConversationStore {
  get(tenantId: string, conversationId: number): Promise<ConversationState>;
  set(tenantId: string, conversationId: number, state: Omit<ConversationState, 'updatedAt'>): Promise<void>;
  clear(tenantId: string, conversationId: number): Promise<void>;
}

export const conversationKey = (tenantId: string, conversationId: number): string => `cw:${tenantId}:${conversationId}`;

export class RedisConversationStore implements ConversationStore {
  constructor(private readonly redis: Redis) {}

  async get(tenantId: string, conversationId: number): Promise<ConversationState> {
    const raw = await this.redis.get(conversationKey(tenantId, conversationId));
    return raw ? (JSON.parse(raw) as ConversationState) : { step: 'idle', updatedAt: Date.now() };
  }

  async set(tenantId: string, conversationId: number, state: Omit<ConversationState, 'updatedAt'>): Promise<void> {
    await this.redis.set(
      conversationKey(tenantId, conversationId),
      JSON.stringify({ ...state, updatedAt: Date.now() }),
      'EX',
      CONVERSATION_TTL_SECONDS,
    );
  }

  async clear(tenantId: string, conversationId: number): Promise<void> {
    await this.redis.del(conversationKey(tenantId, conversationId));
  }
}

export class MemoryConversationStore implements ConversationStore {
  map = new Map<string, ConversationState>();
  async get(tenantId: string, conversationId: number) {
    return this.map.get(conversationKey(tenantId, conversationId)) ?? { step: 'idle' as const, updatedAt: Date.now() };
  }
  async set(tenantId: string, conversationId: number, state: Omit<ConversationState, 'updatedAt'>) {
    this.map.set(conversationKey(tenantId, conversationId), { ...state, updatedAt: Date.now() });
  }
  async clear(tenantId: string, conversationId: number) {
    this.map.delete(conversationKey(tenantId, conversationId));
  }
}
