/**
 * Transactional email. Resend (https://resend.com) in production; an in-memory mailer for tests and
 * MOCK_EXTERNALS. Only used for reports and admin notices — customer-facing documents go to WhatsApp.
 */
export interface MailAttachment {
  filename: string;
  content: Uint8Array;
}

export interface MailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: MailAttachment[];
  /** Resend tags (letters, digits, _ and - only). */
  tags?: Record<string, string>;
}

export interface Mailer {
  readonly configured: boolean;
  readonly from: string;
  send(m: MailMessage): Promise<{ id: string }>;
}

export class MailError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'MailError';
  }
}

const tagValue = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);

export class ResendMailer implements Mailer {
  readonly configured = true;
  readonly #apiKey: string;

  constructor(
    apiKey: string,
    readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.resend.com',
  ) {
    this.#apiKey = apiKey;
  }

  async send(m: MailMessage): Promise<{ id: string }> {
    const to = [...new Set(m.to.map((x) => x.trim().toLowerCase()).filter(Boolean))];
    if (to.length === 0) throw new MailError('No recipients', 400);
    const body = {
      from: this.from,
      to,
      subject: m.subject,
      html: m.html,
      text: m.text,
      reply_to: m.replyTo,
      attachments: m.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content).toString('base64'),
      })),
      tags: m.tags
        ? Object.entries(m.tags).map(([name, value]) => ({ name: tagValue(name), value: tagValue(value) }))
        : undefined,
    };
    const res = await this.fetchImpl(`${this.baseUrl}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok || !json.id)
      throw new MailError(
        `Resend ${res.status}: ${json.message ?? json.name ?? 'request failed'}`,
        res.status,
      );
    return { id: json.id };
  }
}

/** Records messages instead of sending. `configured` mirrors whether a real key would be required. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  constructor(
    readonly from = 'NextAi <reports@example.test>',
    readonly configured = true,
  ) {}
  async send(m: MailMessage) {
    this.sent.push(m);
    return { id: `mem_${this.sent.length}` };
  }
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
