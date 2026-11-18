import type { ChatwootClient, ChoiceOption, TemplateMessage } from './index.js';
import { numberedChoices } from './index.js';

export interface SentMessage {
  conversationId: number;
  kind: 'text' | 'file' | 'template' | 'choices' | 'private';
  content: string;
  filename?: string;
  template?: TemplateMessage;
}

/** Records all outbound traffic; used in tests and mock mode. */
export class FakeChatwootClient implements ChatwootClient {
  sent: SentMessage[] = [];
  labels = new Map<number, string[]>();
  statuses = new Map<number, string>();
  contacts = new Map<string, number>();
  attachments = new Map<string, { content: Uint8Array; mime: string }>();
  private seq = 100;

  async sendText(conversationId: number, content: string, opts: { private?: boolean } = {}) {
    this.sent.push({ conversationId, kind: opts.private ? 'private' : 'text', content });
    return { id: ++this.seq };
  }
  async sendFile(conversationId: number, file: { filename: string }, caption?: string) {
    this.sent.push({ conversationId, kind: 'file', content: caption ?? '', filename: file.filename });
    return { id: ++this.seq };
  }
  async sendTemplate(conversationId: number, fallbackText: string, template: TemplateMessage) {
    this.sent.push({ conversationId, kind: 'template', content: fallbackText, template });
    return { id: ++this.seq };
  }
  async sendChoices(conversationId: number, prompt: string, options: ChoiceOption[]) {
    this.sent.push({ conversationId, kind: 'choices', content: numberedChoices(prompt, options) });
    return { id: ++this.seq };
  }
  async findOrCreateContact(phone: string) {
    let id = this.contacts.get(phone);
    if (!id) {
      id = ++this.seq;
      this.contacts.set(phone, id);
    }
    return { contactId: id, sourceId: phone.replace(/^\+/, '') };
  }
  /** contactId → conversation ids, oldest first */
  conversations = new Map<number, number[]>();
  async createConversation(contactId?: number) {
    const conversationId = ++this.seq;
    if (contactId !== undefined) this.conversations.set(contactId, [...(this.conversations.get(contactId) ?? []), conversationId]);
    return { conversationId };
  }
  async findLatestConversation(contactId: number) {
    const id = this.conversations.get(contactId)?.at(-1);
    return id === undefined ? null : { conversationId: id, status: 'open' };
  }
  async addLabels(conversationId: number, labels: string[]) {
    this.labels.set(conversationId, [...(this.labels.get(conversationId) ?? []), ...labels]);
  }
  async toggleStatus(conversationId: number, status: 'open' | 'pending' | 'resolved') {
    this.statuses.set(conversationId, status);
  }
  async downloadAttachment(dataUrl: string) {
    return this.attachments.get(dataUrl) ?? { content: new TextEncoder().encode(`file:${dataUrl}`), mime: 'image/jpeg' };
  }
  lastText(conversationId?: number): string | undefined {
    const msgs = this.sent.filter((m) => conversationId === undefined || m.conversationId === conversationId);
    return msgs.at(-1)?.content;
  }
}
