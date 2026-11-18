import { env } from '../../config/env.js';

/**
 * Chatwoot Application API calls used only by the admin "Integrations" screen to connect an inbox.
 * Two kinds of tokens exist in Chatwoot:
 *  - a *user* access token (Profile → Access Token, administrator of the account): can list inboxes,
 *    create Agent Bots and assign them to an inbox;
 *  - an *Agent Bot* token: what NextAi stores per tenant; it may only act on conversations/contacts.
 */
export interface CwInbox {
  id: number;
  name: string;
  channelType: string;
  phoneNumber?: string;
}

type Fetch = typeof fetch;

export class ChatwootAdminError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ChatwootAdminError';
  }
}

export function chatwootWebhookUrl(): string {
  const e = env();
  return `${e.API_URL.replace(/\/+$/, '')}/webhooks/chatwoot?token=${encodeURIComponent(e.CHATWOOT_WEBHOOK_SECRET)}`;
}

async function call<T>(
  f: Fetch,
  token: string,
  accountId: number,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const base = env().CHATWOOT_BASE_URL.replace(/\/+$/, '');
  const res = await f(`${base}/api/v1/accounts/${accountId}${path}`, {
    ...init,
    headers: { api_access_token: token, 'Content-Type': 'application/json', Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) {
    const hint =
      res.status === 401
        ? 'token rejected'
        : res.status === 404
          ? 'not found (check account id / inbox id)'
          : (body.message ?? body.error ?? 'request failed');
    throw new ChatwootAdminError(`Chatwoot ${res.status}: ${hint}`, res.status);
  }
  return body;
}

type RawInbox = { id: number; name: string; channel_type: string; phone_number?: string };
const toInbox = (i: RawInbox): CwInbox => ({
  id: i.id,
  name: i.name,
  channelType: i.channel_type,
  phoneNumber: i.phone_number,
});

/** List inboxes with a user access token (to pick the WhatsApp inbox id). */
export async function listInboxes(
  userToken: string,
  accountId: number,
  f: Fetch = fetch,
): Promise<CwInbox[]> {
  const r = await call<{ payload: RawInbox[] }>(f, userToken, accountId, '/inboxes');
  return (r.payload ?? []).map(toInbox);
}

/** Verify an Agent Bot token can read conversations of the inbox (what NextAi needs at runtime). */
export async function verifyBotToken(
  botToken: string,
  accountId: number,
  inboxId: number,
  f: Fetch = fetch,
): Promise<{ ok: true; openConversations: number }> {
  const r = await call<{ data?: { meta?: { all_count?: number } } }>(
    f,
    botToken,
    accountId,
    `/conversations?inbox_id=${inboxId}&status=open&page=1`,
  );
  return { ok: true, openConversations: r.data?.meta?.all_count ?? 0 };
}

/**
 * One-click connect: with a user (administrator) token, find the inbox, create or reuse the
 * "NextAi" Agent Bot pointing at our webhook, assign it to the inbox and return the bot token.
 */
export async function connectInbox(
  userToken: string,
  accountId: number,
  inboxId: number,
  opts: { botName?: string; fetch?: Fetch } = {},
): Promise<{ inbox: CwInbox; botId: number; botToken: string; created: boolean }> {
  const f = opts.fetch ?? fetch;
  const inbox = toInbox(await call<RawInbox>(f, userToken, accountId, `/inboxes/${inboxId}`));
  const outgoingUrl = chatwootWebhookUrl();
  const name = opts.botName ?? 'NextAi Accountant';
  type Bot = { id: number; name: string; outgoing_url?: string; access_token?: string };
  const bots = await call<Bot[]>(f, userToken, accountId, '/agent_bots');
  let bot = (Array.isArray(bots) ? bots : []).find((b) => b.outgoing_url === outgoingUrl || b.name === name);
  let created = false;
  if (!bot) {
    bot = await call<Bot>(f, userToken, accountId, '/agent_bots', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'Records bills and answers book-keeping questions on WhatsApp',
        outgoing_url: outgoingUrl,
      }),
    });
    created = true;
  } else if (bot.outgoing_url !== outgoingUrl) {
    bot = await call<Bot>(f, userToken, accountId, `/agent_bots/${bot.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ outgoing_url: outgoingUrl }),
    });
  }
  if (!bot.access_token) {
    // Older Chatwoot versions do not return the token on list; fetch the bot itself.
    bot = { ...bot, ...(await call<Bot>(f, userToken, accountId, `/agent_bots/${bot.id}`)) };
  }
  if (!bot.access_token)
    throw new ChatwootAdminError(
      'Chatwoot did not return the Agent Bot token; copy it from Settings → Bots and use the manual form',
      422,
    );
  await call(f, userToken, accountId, `/inboxes/${inboxId}/set_agent_bot`, {
    method: 'POST',
    body: JSON.stringify({ agent_bot: bot.id }),
  });
  return { inbox, botId: bot.id, botToken: bot.access_token, created };
}
