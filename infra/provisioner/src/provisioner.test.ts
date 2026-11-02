import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCommand, redactArgv } from './commands.js';
import { parseApiKeys, verify } from './server.js';

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
});
