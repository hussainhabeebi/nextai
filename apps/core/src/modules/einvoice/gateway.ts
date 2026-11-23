import type { EInvoiceScheme } from '@nextai/shared';
import { createHash } from 'node:crypto';
import type { BuiltDocument, ValidationIssue } from './schemes.js';

/**
 * Transport to the tax authority. In production this is a licensed intermediary:
 *  - India: a GSP / IRP-certified ASP (the IRP itself is not reachable without GSP credentials)
 *  - UAE:   an FTA-accredited Peppol Access Point (corner 2)
 *  - KSA:   a ZATCA-onboarded solution holding the CSID used to sign/clear invoices
 * The HTTP gateway speaks one neutral JSON contract so the intermediary can be swapped.
 */
export interface GatewaySubmission {
  scheme: EInvoiceScheme;
  tenantId: string;
  invoiceNumber: string;
  sellerTaxId?: string;
  buyerTaxId?: string;
  document: BuiltDocument;
}

export interface GatewayResult {
  status: 'accepted' | 'rejected';
  irn?: string;
  ackNo?: string;
  ackDate?: string; // ISO
  /** Authority-issued QR payload (IRP signed QR JWT; ZATCA cleared QR). Falls back to the locally built one. */
  qr?: string;
  errors?: ValidationIssue[];
}

export interface EInvoiceGateway {
  readonly name: string;
  submit(s: GatewaySubmission): Promise<GatewayResult>;
  cancel(c: { scheme: EInvoiceScheme; tenantId: string; id: string; reason: string; remark?: string }): Promise<{ ok: boolean; errors?: ValidationIssue[] }>;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly retriable: boolean,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/**
 * Local simulator (default when no gateway is configured, and in tests). Applies the authority's
 * duplicate rule (same IRN / UUID twice returns the original acknowledgement) and issues
 * deterministic acknowledgements. Documents are NOT reported to any authority.
 */
export class SandboxGateway implements EInvoiceGateway {
  readonly name = 'sandbox';
  readonly registered = new Map<string, GatewayResult>();
  readonly cancelled = new Set<string>();
  rejectNext?: ValidationIssue[];
  failNext?: GatewayError;

  async submit(s: GatewaySubmission): Promise<GatewayResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
    if (this.rejectNext) {
      const errors = this.rejectNext;
      this.rejectNext = undefined;
      return { status: 'rejected', errors };
    }
    const key = `${s.tenantId}:${s.scheme}:${s.document.id}`;
    const existing = this.registered.get(key);
    if (existing) return existing;
    const ackNo = String(BigInt(`0x${createHash('sha256').update(key).digest('hex').slice(0, 14)}`) % 10n ** 15n).padStart(15, '1');
    const ackDate = new Date().toISOString();
    let qr = s.document.qr;
    if (s.scheme === 'in_irp') {
      const doc = JSON.parse(s.document.body) as { DocDtls: { No: string; Typ: string; Dt: string }; ValDtls: { TotInvVal: number }; ItemList: Array<{ HsnCd?: string }> };
      qr = `${b64url({ alg: 'none', typ: 'JWT', sandbox: true })}.${b64url({
        data: JSON.stringify({ SellerGstin: s.sellerTaxId, BuyerGstin: s.buyerTaxId, DocNo: doc.DocDtls.No, DocTyp: doc.DocDtls.Typ, DocDt: doc.DocDtls.Dt, TotInvVal: doc.ValDtls.TotInvVal, ItemCnt: doc.ItemList.length, MainHsnCode: doc.ItemList[0]?.HsnCd, Irn: s.document.id, IrnDt: ackDate.replace('T', ' ').slice(0, 19) }),
        iss: 'NIC Sandbox',
      })}.`;
    }
    const result: GatewayResult = { status: 'accepted', irn: s.document.id, ackNo, ackDate, qr };
    this.registered.set(key, result);
    return result;
  }

  async cancel(c: { scheme: EInvoiceScheme; tenantId: string; id: string }) {
    this.cancelled.add(`${c.tenantId}:${c.scheme}:${c.id}`);
    return { ok: true };
  }
}

/** Neutral JSON contract: POST {base}/{scheme}/documents and POST {base}/{scheme}/documents/{id}/cancel. */
export class HttpGateway implements EInvoiceGateway {
  readonly name = 'http';
  readonly #token: string;
  constructor(
    private readonly baseUrl: string,
    token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.#token = token;
  }

  toJSON() {
    return { baseUrl: this.baseUrl };
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new GatewayError(`e-invoice gateway unreachable: ${(err as Error).message}`, true);
    }
    if (res.status === 429 || res.status >= 500) throw new GatewayError(`e-invoice gateway ${res.status}`, true);
    const json = (await res.json().catch(() => ({}))) as T & { errors?: ValidationIssue[]; message?: string };
    if (!res.ok) return { status: 'rejected', ok: false, errors: json.errors ?? [{ field: 'gateway', message: json.message ?? `Rejected (${res.status})` }] } as T;
    return json;
  }

  submit(s: GatewaySubmission): Promise<GatewayResult> {
    return this.call<GatewayResult>(`/${s.scheme}/documents`, {
      tenantRef: s.tenantId,
      invoiceNumber: s.invoiceNumber,
      sellerTaxId: s.sellerTaxId,
      buyerTaxId: s.buyerTaxId,
      format: s.document.format,
      documentId: s.document.id,
      hash: s.document.hash,
      counter: s.document.counter,
      previousHash: s.document.prevHash,
      document: s.document.body,
    });
  }

  cancel(c: { scheme: EInvoiceScheme; tenantId: string; id: string; reason: string; remark?: string }) {
    return this.call<{ ok: boolean; errors?: ValidationIssue[] }>(`/${c.scheme}/documents/${encodeURIComponent(c.id)}/cancel`, { tenantRef: c.tenantId, reason: c.reason, remark: c.remark });
  }
}
