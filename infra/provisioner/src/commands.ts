/**
 * Whitelisted operations → fixed argv arrays (no shell, no string interpolation into commands).
 * Every user-supplied value is validated against a strict pattern before it reaches argv.
 */
export type Op =
  | { op: 'new-site'; site: string; adminPassword: string }
  | { op: 'install-app'; site: string; app: 'erpnext' | 'india_compliance' }
  | { op: 'enable-scheduler'; site: string }
  | { op: 'set-config'; site: string; key: 'host_name' | 'maintenance_mode' | 'pause_scheduler'; value: string }
  | { op: 'create-api-user'; site: string; email: string }
  | { op: 'backup'; site: string };

const SITE = /^[a-z0-9][a-z0-9-]{1,38}\.nextaierp\.com$/;
const PASSWORD = /^[A-Za-z0-9_-]{16,64}$/;
const EMAIL = /^nextai-bot@[a-z0-9][a-z0-9-]{1,38}\.nextaierp\.com$/;
const CONFIG_VALUE = /^[A-Za-z0-9:/._-]{1,200}$/;
const APPS = new Set(['erpnext', 'india_compliance']);
const CONFIG_KEYS = new Set(['host_name', 'maintenance_mode', 'pause_scheduler']);

export class ValidationError extends Error {}

const project = () => process.env.COMPOSE_PROJECT ?? 'nextai';
const service = () => process.env.COMPOSE_SERVICE ?? 'backend';
const exec = (...args: string[]) => ['docker', 'compose', '-p', project(), 'exec', '-T', service(), ...args];
const bench = (...args: string[]) => exec('bench', ...args);

/** Validate and build argv. Throws ValidationError for anything off the whitelist. */
export function buildCommand(input: unknown): { argv: string[]; secretArgs: number[]; parse?: 'api-keys' } {
  const o = input as Partial<Op> & Record<string, unknown>;
  if (!o || typeof o !== 'object' || typeof o.op !== 'string') throw new ValidationError('op required');
  const site = String(o.site ?? '');
  if (!SITE.test(site)) throw new ValidationError('invalid site');
  switch (o.op) {
    case 'new-site': {
      const pw = String(o.adminPassword ?? '');
      if (!PASSWORD.test(pw)) throw new ValidationError('invalid admin password');
      const dbRoot = process.env.DB_ROOT_PASSWORD;
      if (!dbRoot) throw new ValidationError('DB_ROOT_PASSWORD not configured');
      const argv = bench('new-site', site, '--mariadb-user-host-login-scope=%', '--admin-password', pw, '--db-root-password', dbRoot, '--install-app', 'erpnext');
      return { argv, secretArgs: [argv.indexOf(pw), argv.indexOf(dbRoot)] };
    }
    case 'install-app': {
      const app = String(o.app ?? '');
      if (!APPS.has(app)) throw new ValidationError('app not allowed');
      return { argv: bench('--site', site, 'install-app', app), secretArgs: [] };
    }
    case 'enable-scheduler':
      return { argv: bench('--site', site, 'enable-scheduler'), secretArgs: [] };
    case 'set-config': {
      const key = String(o.key ?? '');
      const value = String(o.value ?? '');
      if (!CONFIG_KEYS.has(key) || !CONFIG_VALUE.test(value)) throw new ValidationError('config not allowed');
      return { argv: bench('--site', site, 'set-config', key, value), secretArgs: [] };
    }
    case 'create-api-user': {
      const email = String(o.email ?? '');
      if (!EMAIL.test(email)) throw new ValidationError('invalid bot email');
      // Runs a fixed, versioned script shipped with the provisioner image (see scripts/create_api_user.py).
      return { argv: bench('--site', site, 'execute', 'nextai_provisioning.create_api_user', '--kwargs', JSON.stringify({ email })), secretArgs: [], parse: 'api-keys' };
    }
    case 'backup':
      return { argv: bench('--site', site, 'backup', '--with-files'), secretArgs: [] };
    default:
      throw new ValidationError('op not allowed');
  }
}

/** Redact secret argv entries for logs/responses. */
export const redactArgv = (argv: string[], secretIdx: number[]) => argv.map((a, i) => (secretIdx.includes(i) ? '***' : a));
