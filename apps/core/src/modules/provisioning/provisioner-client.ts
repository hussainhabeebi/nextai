import { hmacSha256 } from '../../lib/crypto.js';

/** Whitelisted provisioner operations (see infra/provisioner). */
export type ProvisionerOp =
  | { op: 'new-site'; site: string; adminPassword: string; dbRootPassword?: string }
  | { op: 'install-app'; site: string; app: 'erpnext' | 'india_compliance' }
  | { op: 'enable-scheduler'; site: string }
  | { op: 'set-config'; site: string; key: 'host_name' | 'maintenance_mode' | 'pause_scheduler'; value: string }
  | { op: 'create-api-user'; site: string; email: string }
  | { op: 'backup'; site: string }
  | { op: 'site-status'; site: string }
  | {
      op: 'complete-setup';
      site: string;
      companyName: string;
      abbr: string;
      country: 'India' | 'United Arab Emirates';
      currency: 'INR' | 'AED';
      timezone: 'Asia/Kolkata' | 'Asia/Dubai';
      fyStart: string;
      fyEnd: string;
    };

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
    const json = (await res.json().catch(() => ({ ok: false, output: res.statusText }))) as { ok: boolean; output: string; data?: Record<string, string> };
    if (res.status === 429) throw new Error(`Provisioner busy (429): another operation is running`);
    if (!res.ok) throw new Error(`Provisioner ${op.op} failed: ${json.output?.slice(0, 300)}`);
    return json;
  }
}

export class FakeProvisionerClient implements ProvisionerClient {
  ops: ProvisionerOp[] = [];
  /** Sites and their apps, as `bench list-apps` would report them */
  sites = new Map<string, Set<string>>();
  /** Test hooks: fail an op once, or report busy a number of times */
  failNext: Partial<Record<ProvisionerOp['op'], string>> = {};
  busy = 0;
  async run(op: ProvisionerOp): Promise<{ ok: boolean; output: string; data?: Record<string, string> }> {
    if (this.busy > 0) {
      this.busy--;
      throw new Error('Provisioner busy (429): another operation is running');
    }
    const fail = this.failNext[op.op];
    if (fail) {
      delete this.failNext[op.op];
      throw new Error(`Provisioner ${op.op} failed: ${fail}`);
    }
    this.ops.push(op);
    if (op.op === 'site-status') {
      const apps = this.sites.get(op.site);
      return { ok: true, output: apps ? 'site exists' : 'no such site', data: { exists: apps ? '1' : '0', apps: apps ? ['frappe', ...apps].join(',') : '' } };
    }
    if (op.op === 'new-site') this.sites.set(op.site, new Set(['erpnext']));
    if (op.op === 'install-app') this.sites.get(op.site)?.add(op.app);
    if (op.op === 'complete-setup') return { ok: true, output: 'setup ok', data: { company: op.companyName, abbr: op.abbr, setup: 'completed' } };
    if (op.op === 'create-api-user') return { ok: true, output: 'created', data: { apiKey: 'fake-key', apiSecret: 'fake-secret' } };
    return { ok: true, output: `${op.op} ok` };
  }
}
