import { describe, expect, it, vi } from 'vitest';
import { HttpChatwootClient, isProcessableIncoming, numberedChoices, parseChoice } from './index.js';

const opts = [
  { title: 'Confirm', value: 'confirm' },
  { title: 'Edit', value: 'edit' },
  { title: 'Cancel', value: 'cancel' },
];

describe('chatwoot-client', () => {
  it('renders and parses numbered choices', () => {
    expect(numberedChoices('Pick', opts)).toBe('Pick\n\n1. Confirm\n2. Edit\n3. Cancel');
    expect(parseChoice('1', opts)).toBe('confirm');
    expect(parseChoice(' 3 ', opts)).toBe('cancel');
    expect(parseChoice('edit', opts)).toBe('edit');
    expect(parseChoice('Conf', opts)).toBe('confirm');
    expect(parseChoice('9', opts)).toBeUndefined();
  });

  it('loop guard ignores outgoing, private and bot messages', () => {
    const base = { event: 'message_created', message_type: 'incoming', sender: { type: 'contact' } };
    expect(isProcessableIncoming(base)).toBe(true);
    expect(isProcessableIncoming({ ...base, message_type: 'outgoing' })).toBe(false);
    expect(isProcessableIncoming({ ...base, private: true })).toBe(false);
    expect(isProcessableIncoming({ ...base, sender: { type: 'agent_bot' } })).toBe(false);
    expect(isProcessableIncoming({ ...base, event: 'conversation_updated' })).toBe(false);
  });

  it('sends with api_access_token and falls back to numbered replies', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 9 }), { status: 200 }));
    const c = new HttpChatwootClient({ baseUrl: 'https://app.aiingo.com', accountId: 1, inboxId: 2, botToken: 'tok' }, { fetch: f });
    await c.sendChoices(55, 'Confirm?', opts);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://app.aiingo.com/api/v1/accounts/1/conversations/55/messages');
    expect(new Headers(init.headers).get('api_access_token')).toBe('tok');
    expect(JSON.parse(init.body).content).toContain('1. Confirm');
    expect(JSON.stringify(c)).not.toContain('tok');
  });
});
