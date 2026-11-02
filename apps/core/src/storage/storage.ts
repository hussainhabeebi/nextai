import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
