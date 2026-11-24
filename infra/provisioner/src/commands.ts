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

const SITE = /^[a-z0-9][a-z0-9-]{1,38}\.nextaierp\.com$/;
const PASSWORD = /^[A-Za-z0-9_-]{16,64}$/;
const EMAIL = /^nextai-bot@[a-z0-9][a-z0-9-]{1,38}\.nextaierp\.com$/;
const CONFIG_VALUE = /^[A-Za-z0-9:/._-]{1,200}$/;
const APPS = new Set(['erpnext', 'india_compliance']);
const CONFIG_KEYS = new Set(['host_name', 'maintenance_mode', 'pause_scheduler']);
const COMPANY = /^[\p{L}\p{N}][\p{L}\p{N} &.,()'-]{0,139}$/u;
const ABBR = /^[A-Z][A-Z0-9]{0,9}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SETUP_COUNTRY: Record<string, { currency: string; timezone: string }> = {
  India: { currency: 'INR', timezone: 'Asia/Kolkata' },
  'United Arab Emirates': { currency: 'AED', timezone: 'Asia/Dubai' },
};

export class ValidationError extends Error {}

const project = () => process.env.COMPOSE_PROJECT ?? 'nextai';
const service = () => process.env.COMPOSE_SERVICE ?? 'backend';
const exec = (...args: string[]) => ['docker', 'compose', '-p', project(), 'exec', '-T', service(), ...args];
const bench = (...args: string[]) => exec('bench', ...args);

/** Validate and build argv. Throws ValidationError for anything off the whitelist. */
export function buildCommand(input: unknown): { argv: string[]; secretArgs: number[]; parse?: 'api-keys' | 'apps' | 'json' } {
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
    case 'site-status':
      // Exit code 0 + app list when the site exists; non-zero otherwise. Lets core retry provisioning safely.
      return { argv: bench('--site', site, 'list-apps'), secretArgs: [], parse: 'apps' };
    case 'complete-setup': {
      const companyName = String(o.companyName ?? '').trim();
      const abbr = String(o.abbr ?? '');
      const country = String(o.country ?? '');
      const expect = SETUP_COUNTRY[country];
      const fyStart = String(o.fyStart ?? '');
      const fyEnd = String(o.fyEnd ?? '');
      if (!COMPANY.test(companyName)) throw new ValidationError('invalid company name');
      if (!ABBR.test(abbr)) throw new ValidationError('invalid abbreviation');
      if (!expect || o.currency !== expect.currency || o.timezone !== expect.timezone) throw new ValidationError('invalid country/currency/timezone');
      if (!DATE.test(fyStart) || !DATE.test(fyEnd) || fyStart >= fyEnd) throw new ValidationError('invalid fiscal year');
      const kwargs = { company_name: companyName, abbr, country, currency: expect.currency, timezone: expect.timezone, fy_start: fyStart, fy_end: fyEnd };
      // Fixed module function; the JSON goes to argv via execFile (no shell).
      return { argv: bench('--site', site, 'execute', 'nextai_provisioning.complete_setup', '--kwargs', JSON.stringify(kwargs)), secretArgs: [], parse: 'json' };
    }
    default:
      throw new ValidationError('op not allowed');
  }
}

/** Redact secret argv entries for logs/responses. */
export const redactArgv = (argv: string[], secretIdx: number[]) => argv.map((a, i) => (secretIdx.includes(i) ? '***' : a));
