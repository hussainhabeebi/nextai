import type { Balances, ErpClient, ErpDoc, ListOptions, ReportResult } from './index.js';
import { ErpError } from './index.js';

/** In-memory ERPNext double used by unit/integration tests and local dev (AI_*=mock). */
export class FakeErpClient implements ErpClient {
  docs = new Map<string, Map<string, ErpDoc>>();
  files: Array<{ filename: string; attachTo?: { doctype: string; name: string } }> = [];
  calls: Array<{ method: string; args: unknown[] }> = [];
  balances: Balances = { cash: 25000, bank: 480000, accounts: [] };
  reports: Record<string, ReportResult> = {};
  failNext?: ErpError;
  private seq = 0;

  private table(doctype: string): Map<string, ErpDoc> {
    let t = this.docs.get(doctype);
    if (!t) {
      t = new Map();
      this.docs.set(doctype, t);
    }
    return t;
  }

  private check(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
  }

  async list<T = ErpDoc>(doctype: string, opts: ListOptions = {}): Promise<T[]> {
    this.check('list', [doctype, opts]);
    let rows = [...this.table(doctype).values()];
    if (opts.filters && !Array.isArray(opts.filters)) {
      const f = opts.filters;
      rows = rows.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v));
    } else if (Array.isArray(opts.filters)) {
      for (const [k, op, v] of opts.filters) {
        if (op === '=') rows = rows.filter((r) => r[k] === v);
        if (op === '>') rows = rows.filter((r) => Number(r[k]) > Number(v));
        if (op === 'in' && Array.isArray(v)) rows = rows.filter((r) => v.includes(r[k]));
        if (op === 'like' && typeof v === 'string') {
          const needle = v.replace(/%/g, '').toLowerCase();
          rows = rows.filter((r) => String(r[k] ?? '').toLowerCase().includes(needle));
        }
      }
    }
    return rows.slice(opts.start ?? 0, (opts.start ?? 0) + (opts.limit ?? 20)) as T[];
  }

  async get<T = ErpDoc>(doctype: string, name: string): Promise<T> {
    this.check('get', [doctype, name]);
    const d = this.table(doctype).get(name);
    if (!d) throw new ErpError('not found', 404, 'DoesNotExistError', 'That record could not be found.', false);
    return d as T;
  }

  async create<T = ErpDoc>(doctype: string, doc: Record<string, unknown>): Promise<T> {
    this.check('create', [doctype, doc]);
    const prefix = doctype
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase();
    const name = (doc.name as string) ?? (doc.customer_name as string) ?? (doc.supplier_name as string) ?? `${prefix}-${++this.seq}`;
    const created: ErpDoc = { ...doc, name, doctype, docstatus: 0 };
    this.table(doctype).set(name, created);
    return created as T;
  }

  async update<T = ErpDoc>(doctype: string, name: string, patch: Record<string, unknown>): Promise<T> {
    this.check('update', [doctype, name, patch]);
    const d = await this.get(doctype, name);
    Object.assign(d, patch);
    return d as T;
  }

  submit<T = ErpDoc>(doctype: string, name: string): Promise<T> {
    return this.update<T>(doctype, name, { docstatus: 1 });
  }

  async cancel(doctype: string, name: string): Promise<void> {
    await this.update(doctype, name, { docstatus: 2 });
  }

  async uploadFile(file: { filename: string; content: Uint8Array; mime: string }, attachTo?: { doctype: string; name: string }) {
    this.check('uploadFile', [file.filename, attachTo]);
    this.files.push({ filename: file.filename, attachTo });
    return { fileUrl: `/private/files/${file.filename}`, name: `FILE-${++this.seq}` };
  }

  async downloadPdf(doctype: string, name: string): Promise<Uint8Array> {
    this.check('downloadPdf', [doctype, name]);
    return new TextEncoder().encode(`%PDF-1.4 fake ${doctype} ${name}`);
  }

  async runReport(reportName: string, filters: Record<string, unknown>): Promise<ReportResult> {
    this.check('runReport', [reportName, filters]);
    return this.reports[reportName] ?? { columns: [], result: [] };
  }

  async getBalances(): Promise<Balances> {
    this.check('getBalances', []);
    return this.balances;
  }

  async ping() {
    return { ok: true, user: 'nextai-bot@example.com', latencyMs: 1 };
  }
}
