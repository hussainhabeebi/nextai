import { z } from 'zod';

/**
 * Chatwoot client used by NextAi as an Agent Bot.
 *
 * Endpoints used (Chatwoot Application API, authenticated with `api_access_token`):
 *   POST /api/v1/accounts/:account/conversations/:id/messages        (text, attachments, templates)
 *   POST /api/v1/accounts/:account/conversations/:id/labels
 *   POST /api/v1/accounts/:account/conversations/:id/toggle_status
 *   GET  /api/v1/accounts/:account/contacts/search
 *   POST /api/v1/accounts/:account/contacts
 *   POST /api/v1/accounts/:account/conversations
 */

export interface ChatwootCredentials {
  baseUrl: string;
  accountId: number;
  inboxId: number;
  botToken: string;
}

export interface ChatwootClientOptions {
  fetch?: typeof fetch;
  /** Whether this inbox renders `input_select` interactive messages. Defaults to false → numbered replies. */
  supportsInteractive?: boolean;
  maxRetries?: number;
  /** Hosts attachments may be downloaded from (SSRF guard). Defaults to the Chatwoot host. */
  attachmentHosts?: string[];
}

export interface ChoiceOption {
  title: string;
  value: string;
}

export interface TemplateMessage {
  name: string;
  language: string;
  category?: string;
  params: string[];
}

export interface ChatwootClient {
  sendText(conversationId: number, content: string, opts?: { private?: boolean }): Promise<{ id: number }>;
  sendFile(conversationId: number, file: { filename: string; content: Uint8Array; mime: string }, caption?: string): Promise<{ id: number }>;
  sendTemplate(conversationId: number, fallbackText: string, template: TemplateMessage): Promise<{ id: number }>;
  sendChoices(conversationId: number, prompt: string, options: ChoiceOption[]): Promise<{ id: number }>;
  findOrCreateContact(phone: string, name: string): Promise<{ contactId: number; sourceId: string }>;
  createConversation(contactId: number, sourceId: string): Promise<{ conversationId: number }>;
  addLabels(conversationId: number, labels: string[]): Promise<void>;
  toggleStatus(conversationId: number, status: 'open' | 'pending' | 'resolved'): Promise<void>;
  downloadAttachment(dataUrl: string): Promise<{ content: Uint8Array; mime: string }>;
}

export class ChatwootError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ChatwootError';
  }
}

/** Render options as numbered text for channels without interactive support. */
export function numberedChoices(prompt: string, options: ChoiceOption[]): string {
  return `${prompt}\n\n${options.map((o, i) => `${i + 1}. ${o.title}`).join('\n')}`;
}

/** Parse a user reply ("1", "confirm", "Confirm ✅") into an option value. */
export function parseChoice(reply: string, options: ChoiceOption[]): string | undefined {
  const r = reply.trim().toLowerCase();
  const n = Number.parseInt(r, 10);
  if (String(n) === r && n >= 1 && n <= options.length) return options[n - 1]!.value;
  return options.find((o) => o.value.toLowerCase() === r || o.title.toLowerCase().startsWith(r) && r.length >= 3)?.value;
}

export class HttpChatwootClient implements ChatwootClient {
  readonly #token: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly interactive: boolean;
  private readonly maxRetries: number;
  private readonly attachmentHosts: string[];

  constructor(
    private readonly creds: Omit<ChatwootCredentials, 'botToken'> & { botToken: string },
    opts: ChatwootClientOptions = {},
  ) {
    this.#token = creds.botToken;
    this.base = `${creds.baseUrl.replace(/\/+$/, '')}/api/v1/accounts/${creds.accountId}`;
    this.fetchImpl = opts.fetch ?? fetch;
    this.interactive = opts.supportsInteractive ?? false;
    this.maxRetries = opts.maxRetries ?? 2;
    this.attachmentHosts = opts.attachmentHosts ?? [new URL(creds.baseUrl).hostname];
  }

  toJSON(): Record<string, unknown> {
    return { accountId: this.creds.accountId, inboxId: this.creds.inboxId };
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      headers.set('api_access_token', this.#token);
      const res = await this.fetchImpl(`${this.base}${path}`, { ...init, headers });
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        continue;
      }
      throw new ChatwootError(`Chatwoot ${res.status} on ${path.split('?')[0]}`, res.status);
    }
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  sendText(conversationId: number, content: string, opts: { private?: boolean } = {}) {
    return this.post<{ id: number }>(`/conversations/${conversationId}/messages`, {
      content,
      message_type: 'outgoing',
      private: opts.private ?? false,
    });
  }

  sendFile(conversationId: number, file: { filename: string; content: Uint8Array; mime: string }, caption?: string) {
    const form = new FormData();
    form.set('message_type', 'outgoing');
    if (caption) form.set('content', caption);
    form.append('attachments[]', new Blob([file.content], { type: file.mime }), file.filename);
    return this.call<{ id: number }>(`/conversations/${conversationId}/messages`, { method: 'POST', body: form });
  }

  sendTemplate(conversationId: number, fallbackText: string, template: TemplateMessage) {
    return this.post<{ id: number }>(`/conversations/${conversationId}/messages`, {
      content: fallbackText,
      message_type: 'outgoing',
      template_params: {
        name: template.name,
        category: template.category ?? 'UTILITY',
        language: template.language,
        processed_params: Object.fromEntries(template.params.map((p, i) => [String(i + 1), p])),
      },
    });
  }

  sendChoices(conversationId: number, prompt: string, options: ChoiceOption[]) {
    if (this.interactive) {
      return this.post<{ id: number }>(`/conversations/${conversationId}/messages`, {
        content: prompt,
        message_type: 'outgoing',
        content_type: 'input_select',
        content_attributes: { items: options },
      });
    }
    return this.sendText(conversationId, numberedChoices(prompt, options));
  }

  async findOrCreateContact(phone: string, name: string) {
    const found = await this.call<{ payload: Array<{ id: number; phone_number?: string; contact_inboxes?: Array<{ source_id: string; inbox: { id: number } }> }> }>(
      `/contacts/search?q=${encodeURIComponent(phone)}`,
    );
    const match = found.payload.find((c) => c.phone_number === phone);
    if (match) {
      const ci = match.contact_inboxes?.find((x) => x.inbox.id === this.creds.inboxId);
      return { contactId: match.id, sourceId: ci?.source_id ?? phone.replace(/^\+/, '') };
    }
    const created = await this.post<{ payload: { contact: { id: number }; contact_inbox?: { source_id: string } } }>('/contacts', {
      inbox_id: this.creds.inboxId,
      name,
      phone_number: phone,
    });
    return {
      contactId: created.payload.contact.id,
      sourceId: created.payload.contact_inbox?.source_id ?? phone.replace(/^\+/, ''),
    };
  }

  async createConversation(contactId: number, sourceId: string) {
    const conv = await this.post<{ id: number }>('/conversations', {
      source_id: sourceId,
      inbox_id: this.creds.inboxId,
      contact_id: contactId,
      status: 'pending',
    });
    return { conversationId: conv.id };
  }

  async addLabels(conversationId: number, labels: string[]) {
    await this.post(`/conversations/${conversationId}/labels`, { labels });
  }

  async toggleStatus(conversationId: number, status: 'open' | 'pending' | 'resolved') {
    await this.post(`/conversations/${conversationId}/toggle_status`, { status });
  }

  async downloadAttachment(dataUrl: string) {
    const url = new URL(dataUrl);
    // SSRF guard: only https and only allowlisted hosts (Chatwoot + its storage bucket).
    if (url.protocol !== 'https:' || !this.attachmentHosts.includes(url.hostname)) {
      throw new ChatwootError('Refusing to download attachment from untrusted host', 400);
    }
    const res = await this.fetchImpl(url, { redirect: 'follow' });
    if (!res.ok) throw new ChatwootError(`Attachment download failed ${res.status}`, res.status);
    return {
      content: new Uint8Array(await res.arrayBuffer()),
      mime: res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
    };
  }
}

export function createChatwootClient(creds: ChatwootCredentials, opts?: ChatwootClientOptions): ChatwootClient {
  return new HttpChatwootClient(creds, opts);
}

// ---------------- Webhook payloads (Agent Bot) ----------------
export const chatwootAttachmentSchema = z.object({
  id: z.number().optional(),
  file_type: z.string(), // image | audio | file | video
  data_url: z.string().url(),
  extension: z.string().nullable().optional(),
  file_size: z.number().optional(),
});

export const chatwootWebhookSchema = z
  .object({
    event: z.string(),
    id: z.number().optional(),
    content: z.string().nullable().optional(),
    message_type: z.union([z.string(), z.number()]).optional(),
    content_type: z.string().nullable().optional(),
    content_attributes: z.record(z.unknown()).nullable().optional(),
    private: z.boolean().optional(),
    created_at: z.union([z.string(), z.number()]).optional(),
    account: z.object({ id: z.number() }).passthrough().optional(),
    inbox: z.object({ id: z.number() }).passthrough().optional(),
    conversation: z
      .object({ id: z.number(), status: z.string().optional(), contact_inbox: z.object({ source_id: z.string() }).partial().optional() })
      .passthrough()
      .optional(),
    sender: z
      .object({ id: z.number().optional(), type: z.string().optional(), name: z.string().nullable().optional(), phone_number: z.string().nullable().optional() })
      .passthrough()
      .optional(),
    attachments: z.array(chatwootAttachmentSchema).optional(),
  })
  .passthrough();
export type ChatwootWebhook = z.infer<typeof chatwootWebhookSchema>;

/** Only process incoming customer messages; drop outgoing/bot/private/template echoes (loop guard). */
export function isProcessableIncoming(evt: ChatwootWebhook): boolean {
  if (evt.event !== 'message_created') return false;
  const mt = evt.message_type;
  if (!(mt === 'incoming' || mt === 0)) return false;
  if (evt.private) return false;
  const senderType = evt.sender?.type?.toLowerCase();
  if (senderType && senderType !== 'contact') return false;
  return true;
}
