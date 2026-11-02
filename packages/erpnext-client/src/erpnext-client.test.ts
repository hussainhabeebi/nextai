import { describe, expect, it, vi } from 'vitest';
import { ErpError, HttpErpClient, friendlyErpMessage } from './index.js';

const creds = { baseUrl: 'https://client1.nextaierp.com/', apiKey: 'k', apiSecret: 's' };

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('HttpErpClient', () => {
  it('sends token auth header and parses data', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { data: { name: 'PINV-0001' } }));
    const c = new HttpErpClient(creds, { fetch: f });
    const doc = await c.create('Purchase Invoice', { supplier: 'ABC' });
    expect(doc.name).toBe('PINV-0001');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://client1.nextaierp.com/api/resource/Purchase%20Invoice');
    expect(new Headers(init.headers).get('Authorization')).toBe('token k:s');
  });

  it('submit sets docstatus=1 via PUT', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { data: { name: 'X', docstatus: 1 } }));
    await new HttpErpClient(creds, { fetch: f }).submit('Sales Invoice', 'X');
    const [, init] = f.mock.calls[0]!;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ docstatus: 1 });
  });

  it('retries 5xx with backoff then succeeds', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(502, {}))
      .mockResolvedValueOnce(res(503, {}))
      .mockResolvedValueOnce(res(200, { message: 'bot@x' }));
    const c = new HttpErpClient(creds, { fetch: f, baseDelayMs: 1 });
    expect(await c.ping()).toMatchObject({ ok: true, user: 'bot@x' });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx and maps error to friendly message', async () => {
    const f = vi.fn().mockResolvedValue(
      res(417, { exc_type: 'LinkValidationError', _server_messages: JSON.stringify([JSON.stringify({ message: 'Could not find Supplier: X' })]) }),
    );
    const c = new HttpErpClient(creds, { fetch: f, baseDelayMs: 1 });
    const err = await c.get('Supplier', 'X').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErpError);
    expect((err as ErpError).userMessage).toMatch(/does not exist yet/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('never serialises credentials', () => {
    const c = new HttpErpClient(creds);
    expect(JSON.stringify(c)).not.toContain('token');
    expect(JSON.stringify(c)).not.toContain(':s');
  });

  it('maps statuses', () => {
    expect(friendlyErpMessage(503)).toMatch(/busy/);
    expect(friendlyErpMessage(401)).toMatch(/needs attention/);
  });
});
