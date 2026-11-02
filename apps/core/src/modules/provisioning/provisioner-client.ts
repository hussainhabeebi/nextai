import { hmacSha256 } from '../../lib/crypto.js';

/** Whitelisted provisioner operations (see infra/provisioner). */
export type ProvisionerOp =
  | { op: 'new-site'; site: string; adminPassword: string; dbRootPassword?: string }
  | { op: 'install-app'; site: string; app: 'erpnext' | 'india_compliance' }
  | { op: 'enable-scheduler'; site: string }
  | { op: 'set-config'; site: string; key: 'host_name' | 'maintenance_mode' | 'pause_scheduler'; value: string }
  | { op: 'create-api-user'; site: string; email: string }
  | { op: 'backup'; site: string };

export interface ProvisionerClient {
  run(op: ProvisionerOp): Promise<{ ok: boolean; output: string; data?: Record<string, string> }>;
}

export class HttpProvisionerClient implements ProvisionerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  async run(op: ProvisionerOp) {
    const body = JSON.stringify(op);
    const ts = String(Date.now());
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-signature': hmacSha256(this.secret, `${ts}.${body}`) },
      body,
      signal: AbortSignal.timeout(15 * 60_000),
    });
    const json = (await res.json()) as { ok: boolean; output: string; data?: Record<string, string> };
    if (!res.ok) throw new Error(`Provisioner ${op.op} failed: ${json.output?.slice(0, 300)}`);
    return json;
  }
}

export class FakeProvisionerClient implements ProvisionerClient {
  ops: ProvisionerOp[] = [];
  async run(op: ProvisionerOp) {
    this.ops.push(op);
    if (op.op === 'create-api-user') return { ok: true, output: 'created', data: { apiKey: 'fake-key', apiSecret: 'fake-secret' } };
    return { ok: true, output: `${op.op} ok` };
  }
}
