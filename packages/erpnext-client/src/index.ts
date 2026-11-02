/**
 * Thin, typed client for the Frappe/ERPNext REST API (v16).
 *
 * Only these endpoints are used:
 *   GET/POST/PUT  /api/resource/:doctype[/:name]
 *   POST          /api/method/frappe.client.cancel
 *   POST          /api/method/upload_file
 *   GET           /api/method/frappe.utils.print_format.download_pdf
 *   POST          /api/method/frappe.desk.query_report.run
 *   GET           /api/method/frappe.auth.get_logged_user
 *   GET           /api/method/erpnext.accounts.utils.get_balance_on   (TODO: verify on v16)
 *
 * Secrets are passed in already-decrypted by the caller's factory and are never logged.
 */

export interface ErpCredentials {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
}

export interface ErpClientOptions {
  fetch?: typeof fetch;
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}

export type ErpDoc = Record<string, unknown> & { name?: string; doctype?: string; docstatus?: 0 | 1 | 2 };

export interface ListOptions {
  filters?: Array<[string, string, unknown]> | Record<string, unknown>;
  fields?: string[];
  orderBy?: string;
  limit?: number;
  start?: number;
}

export interface Balances {
  cash: number;
  bank: number;
  accounts: Array<{ account: string; type: 'Cash' | 'Bank'; balance: number }>;
}

export interface ReportResult {
  columns: Array<{ fieldname?: string; label?: string; fieldtype?: string } | string>;
  result: unknown[];
}

/** Interface implemented by the real client and by test doubles. */
export interface ErpClient {
  list<T = ErpDoc>(doctype: string, opts?: ListOptions): Promise<T[]>;
  get<T = ErpDoc>(doctype: string, name: string): Promise<T>;
  create<T = ErpDoc>(doctype: string, doc: Record<string, unknown>): Promise<T>;
  update<T = ErpDoc>(doctype: string, name: string, patch: Record<string, unknown>): Promise<T>;
  submit<T = ErpDoc>(doctype: string, name: string): Promise<T>;
  cancel(doctype: string, name: string): Promise<void>;
  uploadFile(
    file: { filename: string; content: Uint8Array; mime: string },
    attachTo?: { doctype: string; name: string },
    isPrivate?: boolean,
  ): Promise<{ fileUrl: string; name: string }>;
  downloadPdf(doctype: string, name: string, printFormat?: string): Promise<Uint8Array>;
  runReport(reportName: string, filters: Record<string, unknown>): Promise<ReportResult>;
  getBalances(company: string): Promise<Balances>;
  ping(): Promise<{ ok: boolean; user?: string; latencyMs: number }>;
}

export class ErpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly excType: string | undefined,
    public readonly userMessage: string,
    public readonly retriable: boolean,
  ) {
    super(message);
    this.name = 'ErpError';
  }
}

/** Map ERPNext exception types / HTTP statuses to user-friendly messages (never leaks internals). */
export function friendlyErpMessage(status: number, excType?: string, serverMessage?: string): string {
  switch (excType) {
    case 'DuplicateEntryError':
      return 'This entry already exists in your books.';
    case 'LinkValidationError':
      return 'A referenced customer, supplier, item or account does not exist yet.';
    case 'MandatoryError':
      return 'Some required details are missing.';
    case 'PermissionError':
      return 'NextAi is not allowed to do this in your books. Our team has been notified.';
    case 'TimestampMismatchError':
      return 'This record was changed by someone else. Please try again.';
    case 'DoesNotExistError':
      return 'That record could not be found.';
    case 'NegativeStockError':
      return 'Not enough stock for this item.';
    case 'ValidationError':
      return serverMessage ? `Your books rejected this: ${stripHtml(serverMessage).slice(0, 200)}` : 'Your books rejected this entry.';
  }
  if (status === 401 || status === 403) return 'Connection to your books needs attention. Our team has been notified.';
  if (status === 404) return 'That record could not be found.';
  if (status === 429 || status >= 500) return 'Your books are busy right now. We will retry shortly.';
  return 'Something went wrong while updating your books.';
}

const stripHtml = (s: string): string => s.replace(/<[^>]+>/g, '').trim();

function parseServerMessages(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const arr = JSON.parse(raw) as string[];
    const msgs = arr.map((m) => {
      try {
        return (JSON.parse(m) as { message?: string }).message ?? m;
      } catch {
        return m;
      }
    });
    return msgs.join(' ');
  } catch {
    return raw;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HttpErpClient implements ErpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  readonly #auth: string;
  private readonly baseUrl: string;

  constructor(creds: ErpCredentials, opts: ErpClientOptions = {}) {
    this.baseUrl = creds.baseUrl.replace(/\/+$/, '');
    // private field: not enumerable, not serialised by loggers
    this.#auth = `token ${creds.apiKey}:${creds.apiSecret}`;
    this.fetchImpl = opts.fetch ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 300;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  toJSON(): Record<string, string> {
    return { baseUrl: this.baseUrl };
  }

  private async request(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers = new Headers(init.headers);
        headers.set('Authorization', this.#auth);
        headers.set('Accept', 'application/json');
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
        if (res.ok) return res;
        const retriable = res.status === 429 || res.status >= 500;
        if (retriable && attempt < this.maxRetries) {
          attempt++;
          await sleep(this.backoff(attempt));
          continue;
        }
        throw await this.toError(res);
      } catch (err) {
        if (err instanceof ErpError) throw err;
        if (attempt < this.maxRetries) {
          attempt++;
          await sleep(this.backoff(attempt));
          continue;
        }
        throw new ErpError(
          `ERPNext network error: ${(err as Error).message}`,
          0,
          undefined,
          'Your books are unreachable right now. We will retry shortly.',
          true,
        );
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private backoff(attempt: number): number {
    const exp = this.baseDelayMs * 2 ** (attempt - 1);
    return exp + Math.floor(Math.random() * this.baseDelayMs);
  }

  private async toError(res: Response): Promise<ErpError> {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-json */
    }
    const excType = typeof body.exc_type === 'string' ? body.exc_type : undefined;
    const serverMsg = parseServerMessages(body._server_messages) ?? (typeof body.message === 'string' ? body.message : undefined);
    return new ErpError(
      `ERPNext ${res.status} ${excType ?? ''}`.trim(),
      res.status,
      excType,
      friendlyErpMessage(res.status, excType, serverMsg),
      res.status === 429 || res.status >= 500,
    );
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    const body = (await res.json()) as { data?: T; message?: T };
    return (body.data ?? body.message) as T;
  }

  private jsonInit(method: string, body: unknown): RequestInit {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  async list<T = ErpDoc>(doctype: string, opts: ListOptions = {}): Promise<T[]> {
    const q = new URLSearchParams();
    if (opts.filters) q.set('filters', JSON.stringify(opts.filters));
    q.set('fields', JSON.stringify(opts.fields ?? ['name']));
    if (opts.orderBy) q.set('order_by', opts.orderBy);
    q.set('limit_page_length', String(opts.limit ?? 20));
    if (opts.start) q.set('limit_start', String(opts.start));
    return this.json<T[]>(`/api/resource/${encodeURIComponent(doctype)}?${q.toString()}`);
  }

  get<T = ErpDoc>(doctype: string, name: string): Promise<T> {
    return this.json<T>(`/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
  }

  create<T = ErpDoc>(doctype: string, doc: Record<string, unknown>): Promise<T> {
    return this.json<T>(`/api/resource/${encodeURIComponent(doctype)}`, this.jsonInit('POST', doc));
  }

  update<T = ErpDoc>(doctype: string, name: string, patch: Record<string, unknown>): Promise<T> {
    return this.json<T>(
      `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
      this.jsonInit('PUT', patch),
    );
  }

  submit<T = ErpDoc>(doctype: string, name: string): Promise<T> {
    return this.update<T>(doctype, name, { docstatus: 1 });
  }

  async cancel(doctype: string, name: string): Promise<void> {
    await this.request('/api/method/frappe.client.cancel', this.jsonInit('POST', { doctype, name }));
  }

  async uploadFile(
    file: { filename: string; content: Uint8Array; mime: string },
    attachTo?: { doctype: string; name: string },
    isPrivate = true,
  ): Promise<{ fileUrl: string; name: string }> {
    const form = new FormData();
    form.set('file', new Blob([file.content], { type: file.mime }), file.filename);
    form.set('is_private', isPrivate ? '1' : '0');
    if (attachTo) {
      form.set('doctype', attachTo.doctype);
      form.set('docname', attachTo.name);
    }
    const msg = await this.json<{ file_url: string; name: string }>('/api/method/upload_file', {
      method: 'POST',
      body: form,
    });
    return { fileUrl: msg.file_url, name: msg.name };
  }

  async downloadPdf(doctype: string, name: string, printFormat = 'Standard'): Promise<Uint8Array> {
    const q = new URLSearchParams({ doctype, name, format: printFormat, no_letterhead: '0' });
    const res = await this.request(`/api/method/frappe.utils.print_format.download_pdf?${q.toString()}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  runReport(reportName: string, filters: Record<string, unknown>): Promise<ReportResult> {
    return this.json<ReportResult>(
      '/api/method/frappe.desk.query_report.run',
      this.jsonInit('POST', { report_name: reportName, filters, ignore_prepared_report: true }),
    );
  }

  async getBalances(company: string): Promise<Balances> {
    const accounts = await this.list<{ name: string; account_type: 'Cash' | 'Bank' }>('Account', {
      filters: [
        ['company', '=', company],
        ['account_type', 'in', ['Cash', 'Bank']],
        ['is_group', '=', 0],
      ],
      fields: ['name', 'account_type'],
      limit: 50,
    });
    const today = new Date().toISOString().slice(0, 10);
    const out: Balances = { cash: 0, bank: 0, accounts: [] };
    for (const acc of accounts) {
      // TODO(erpnext-v16): confirm get_balance_on remains whitelisted; fallback is General Ledger report.
      const q = new URLSearchParams({ account: acc.name, date: today, company });
      const balance = Number(await this.json<number>(`/api/method/erpnext.accounts.utils.get_balance_on?${q}`)) || 0;
      out.accounts.push({ account: acc.name, type: acc.account_type, balance });
      if (acc.account_type === 'Cash') out.cash += balance;
      else out.bank += balance;
    }
    return out;
  }

  async ping(): Promise<{ ok: boolean; user?: string; latencyMs: number }> {
    const start = Date.now();
    try {
      const user = await this.json<string>('/api/method/frappe.auth.get_logged_user');
      return { ok: true, user, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}

export function createErpClient(creds: ErpCredentials, opts?: ErpClientOptions): ErpClient {
  return new HttpErpClient(creds, opts);
}
