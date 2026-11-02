import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { tenantKey, assertTenantKey } from '../src/storage/storage.js';

describe('crypto', () => {
  it('round-trips AES-256-GCM with AAD', () => {
    const c = encrypt('s3cret', 'erp_key:a');
    expect(c).not.toContain('s3cret');
    expect(decrypt(c, 'erp_key:a')).toBe('s3cret');
  });
  it('rejects wrong AAD (ciphertext bound to tenant) and tampering', () => {
    const c = encrypt('s3cret', 'erp_key:a');
    expect(() => decrypt(c, 'erp_key:b')).toThrow();
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), 'erp_key:a')).toThrow();
  });
  it('prefixes storage keys per tenant and blocks traversal', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    expect(tenantKey(id, 'docs', '../../etc/passwd')).toBe(`tenants/${id}/docs/etc/passwd`);
    expect(() => assertTenantKey(id, 'tenants/22222222-2222-2222-2222-222222222222/x')).toThrow();
  });
});
