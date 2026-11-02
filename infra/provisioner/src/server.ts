import { execFile } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { buildCommand, redactArgv, ValidationError } from './commands.js';

/**
 * NextAi provisioner — internal service on the ERPNext host.
 * Listens on localhost/private network only; requests must carry
 *   x-timestamp (ms) and x-signature = hex(HMAC-SHA256(PROVISIONER_SECRET, `${timestamp}.${body}`))
 * Only whitelisted operations run, via execFile (no shell). One operation at a time.
 */
const SECRET = process.env.PROVISIONER_SECRET ?? '';
const HOST = process.env.PROVISIONER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PROVISIONER_PORT ?? 8099);
const MAX_SKEW_MS = 5 * 60_000;

export function verify(secret: string, ts: string | undefined, sig: string | undefined, body: string, now = Date.now()): boolean {
  if (!secret || !ts || !sig || Math.abs(now - Number(ts)) > MAX_SKEW_MS) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

const seen = new Map<string, number>(); // replay protection
let busy = false;

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 16_384) reject(new Error('too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

function run(argv: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { timeout: 20 * 60_000, maxBuffer: 4 * 1024 * 1024, shell: false }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}\n${stderr}`.trim() });
    });
  });
}

export function parseApiKeys(out: string): Record<string, string> | undefined {
  const m = out.match(/\{[^{}]*"api_key"[^{}]*\}/);
  if (!m) return undefined;
  const j = JSON.parse(m[0]) as { api_key?: string; api_secret?: string };
  return j.api_key && j.api_secret ? { apiKey: j.api_key, apiSecret: j.api_secret } : undefined;
}

export const server = createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/run') return send(404, { ok: false, output: 'not found' });
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    return send(413, { ok: false, output: 'too large' });
  }
  const ts = req.headers['x-timestamp'] as string | undefined;
  const sig = req.headers['x-signature'] as string | undefined;
  if (!verify(SECRET, ts, sig, body)) return send(401, { ok: false, output: 'unauthorized' });
  if (seen.has(sig!)) return send(409, { ok: false, output: 'replay' });
  seen.set(sig!, Date.now());
  for (const [k, t] of seen) if (Date.now() - t > MAX_SKEW_MS * 2) seen.delete(k);

  let cmd: ReturnType<typeof buildCommand>;
  try {
    cmd = buildCommand(JSON.parse(body));
  } catch (e) {
    return send(400, { ok: false, output: e instanceof ValidationError ? e.message : 'bad request' });
  }
  if (busy) return send(429, { ok: false, output: 'another operation is running' });
  busy = true;
  try {
    const { code, out } = await run(cmd.argv);
    const safeOut = out.slice(-4000);
    console.warn(JSON.stringify({ at: new Date().toISOString(), argv: redactArgv(cmd.argv, cmd.secretArgs), code }));
    const data = cmd.parse === 'api-keys' ? parseApiKeys(out) : undefined;
    return send(code === 0 ? 200 : 500, { ok: code === 0, output: cmd.parse === 'api-keys' ? 'api user created' : safeOut, data });
  } finally {
    busy = false;
  }
});

if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  if (!SECRET || SECRET.length < 32) throw new Error('PROVISIONER_SECRET (>=32 chars) is required');
  server.listen(PORT, HOST, () => console.warn(`provisioner listening on ${HOST}:${PORT}`));
}
