import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCommand, redactArgv } from './commands.js';
import { parseApiKeys, parseApps, parseJson, verify } from './server.js';

describe('provisioner', () => {
  process.env.DB_ROOT_PASSWORD = 'rootpw';
  it('builds fixed argv for whitelisted ops only', () => {
    expect(buildCommand({ op: 'install-app', site: 'acme.nextaierp.com', app: 'erpnext' }).argv).toEqual([
      'docker', 'compose', '-p', 'nextai', 'exec', '-T', 'backend', 'bench', '--site', 'acme.nextaierp.com', 'install-app', 'erpnext',
    ]);
    expect(() => buildCommand({ op: 'install-app', site: 'acme.nextaierp.com', app: 'hrms' })).toThrow();
    expect(() => buildCommand({ op: 'drop-site', site: 'acme.nextaierp.com' })).toThrow();
    expect(() => buildCommand({ op: 'enable-scheduler', site: 'acme.nextaierp.com; rm -rf /' })).toThrow();
    expect(() => buildCommand({ op: 'set-config', site: 'acme.nextaierp.com', key: 'db_password', value: 'x' })).toThrow();
    expect(() => buildCommand({ op: 'set-config', site: 'acme.nextaierp.com', key: 'host_name', value: '$(reboot)' })).toThrow();
  });
  it('redacts secrets in logs', () => {
    const c = buildCommand({ op: 'new-site', site: 'acme.nextaierp.com', adminPassword: 'A'.repeat(20) });
    const red = redactArgv(c.argv, c.secretArgs);
    expect(red.join(' ')).not.toContain('AAAA');
    expect(red.join(' ')).not.toContain('rootpw');
  });
  it('verifies HMAC with timestamp skew', () => {
    const body = '{"op":"backup"}';
    const ts = String(Date.now());
    const sig = createHmac('sha256', 's'.repeat(32)).update(`${ts}.${body}`).digest('hex');
    expect(verify('s'.repeat(32), ts, sig, body)).toBe(true);
    expect(verify('s'.repeat(32), ts, sig, body + ' ')).toBe(false);
    expect(verify('s'.repeat(32), String(Date.now() - 600_000), sig, body)).toBe(false);
  });
  it('parses api keys from bench output', () => {
    expect(parseApiKeys('noise\n{"api_key": "k1", "api_secret": "s1"}\n')).toEqual({ apiKey: 'k1', apiSecret: 's1' });
  });
  it('builds site-status and complete-setup with strict validation', () => {
    expect(buildCommand({ op: 'site-status', site: 'acme.nextaierp.com' }).argv.slice(-3)).toEqual(['--site', 'acme.nextaierp.com', 'list-apps']);
    const ok = { op: 'complete-setup', site: 'acme.nextaierp.com', companyName: "Kochi Spice Traders (P) Ltd.", abbr: 'KST', country: 'India', currency: 'INR', timezone: 'Asia/Kolkata', fyStart: '2026-04-01', fyEnd: '2027-03-31' };
    const c = buildCommand(ok);
    expect(c.argv.slice(7, 12)).toEqual(['bench', '--site', 'acme.nextaierp.com', 'execute', 'nextai_provisioning.complete_setup']);
    expect(JSON.parse(c.argv.at(-1)!)).toMatchObject({ company_name: 'Kochi Spice Traders (P) Ltd.', abbr: 'KST', currency: 'INR', fy_end: '2027-03-31' });
    expect(buildCommand({ ...ok, companyName: 'مطعم الريان' }).argv.at(-1)).toContain('مطعم الريان');
    expect(() => buildCommand({ ...ok, companyName: 'x"; import os' })).toThrow();
    expect(() => buildCommand({ ...ok, abbr: 'kst' })).toThrow();
    expect(() => buildCommand({ ...ok, currency: 'AED' })).toThrow();
    expect(() => buildCommand({ ...ok, fyEnd: '2026-01-01' })).toThrow();
  });
  it('parses app lists and JSON results', () => {
    expect(parseApps('frappe 15.40.0 version-15\nerpnext 15.35.1 version-15\nindia_compliance 15.8.0 version-15\n')).toEqual(['frappe', 'erpnext', 'india_compliance']);
    expect(parseApps('frappe\nerpnext\n')).toEqual(['frappe', 'erpnext']);
    expect(parseJson('Updating...\n{"company": "Acme", "abbr": "AC", "setup": "completed"}\n')).toEqual({ company: 'Acme', abbr: 'AC', setup: 'completed' });
  });
});
