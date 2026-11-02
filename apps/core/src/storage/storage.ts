import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** All objects live under tenants/{tenant_id}/... – enforced here, not by callers. */
export function tenantKey(tenantId: string, ...parts: string[]): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('Invalid tenant id');
  const safe = parts.map((p) => p.replace(/\.\.+/g, '').replace(/^\/+|\/+$/g, '').replace(/[^\w.\-/]/g, '_'));
  return ['tenants', tenantId, ...safe].join('/');
}

export function assertTenantKey(tenantId: string, key: string): void {
  if (!key.startsWith(`tenants/${tenantId}/`)) throw new Error('Storage key does not belong to tenant');
}

export interface ObjectStorage {
  put(tenantId: string, key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(tenantId: string, key: string): Promise<{ body: Uint8Array; contentType: string }>;
  /** Short-lived signed GET URL. There are no public URLs. */
  signedUrl(tenantId: string, key: string, expiresSeconds?: number): Promise<string>;
}

export class R2Storage implements ObjectStorage {
  private readonly s3: S3Client;
  constructor(
    accountId: string,
    accessKeyId: string,
    secretAccessKey: string,
    private readonly bucket: string,
  ) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async put(tenantId: string, key: string, body: Uint8Array, contentType: string): Promise<void> {
    assertTenantKey(tenantId, key);
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(tenantId: string, key: string) {
    assertTenantKey(tenantId, key);
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = await res.Body!.transformToByteArray();
    return { body, contentType: res.ContentType ?? 'application/octet-stream' };
  }

  async signedUrl(tenantId: string, key: string, expiresSeconds = 300): Promise<string> {
    assertTenantKey(tenantId, key);
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresSeconds });
  }
}

/** Dev/test storage. */
export class MemoryStorage implements ObjectStorage {
  objects = new Map<string, { body: Uint8Array; contentType: string }>();
  async put(tenantId: string, key: string, body: Uint8Array, contentType: string) {
    assertTenantKey(tenantId, key);
    this.objects.set(key, { body, contentType });
  }
  async get(tenantId: string, key: string) {
    assertTenantKey(tenantId, key);
    const o = this.objects.get(key);
    if (!o) throw new Error('Object not found');
    return o;
  }
  async signedUrl(tenantId: string, key: string, expiresSeconds = 300) {
    assertTenantKey(tenantId, key);
    return `memory://${key}?expires=${Date.now() + expiresSeconds * 1000}`;
  }
}

/**
 * Local filesystem storage for development (shared by API + worker). URLs are HMAC-signed with
 * an expiry and served by GET /files/* in core — same "signed URLs only" contract as R2.
 */
export class LocalFsStorage implements ObjectStorage {
  constructor(
    private readonly dir: string,
    private readonly apiUrl: string,
    private readonly secret: string,
  ) {}

  private path(key: string) {
    return join(this.dir, ...key.split('/'));
  }

  async put(tenantId: string, key: string, body: Uint8Array, contentType: string) {
    assertTenantKey(tenantId, key);
    await mkdir(dirname(this.path(key)), { recursive: true });
    await writeFile(this.path(key), body);
    await writeFile(`${this.path(key)}.type`, contentType);
  }

  async get(tenantId: string, key: string) {
    assertTenantKey(tenantId, key);
    const body = new Uint8Array(await readFile(this.path(key)));
    const contentType = await readFile(`${this.path(key)}.type`, 'utf8').catch(() => 'application/octet-stream');
    return { body, contentType };
  }

  sign(key: string, exp: number) {
    return createHmac('sha256', this.secret).update(`${key}:${exp}`).digest('hex');
  }

  async signedUrl(tenantId: string, key: string, expiresSeconds = 300) {
    assertTenantKey(tenantId, key);
    const exp = Math.floor(Date.now() / 1000) + expiresSeconds;
    return `${this.apiUrl}/files/${key}?exp=${exp}&sig=${this.sign(key, exp)}`;
  }

  verify(key: string, exp: number, sig: string) {
    return exp > Date.now() / 1000 && sig.length === 64 && timingSafeEqual(Buffer.from(sig), Buffer.from(this.sign(key, exp)));
  }
}
