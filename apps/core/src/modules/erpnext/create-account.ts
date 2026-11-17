/**
 * "Create supplier account AM Motors" / "open bank account HDFC": add a customer or supplier, or a ledger to the
 * company's chart of accounts, in the tenant's ERPNext. Nothing is created twice: an existing record (same name,
 * any letter case) is reported instead.
 */
import type { AccountKind } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { clearAccountCache, erpContext, partyDoc } from './mappers.js';

export type LedgerKind = Exclude<AccountKind, 'customer' | 'supplier'>;
export const isPartyKind = (k: AccountKind): k is 'customer' | 'supplier' => k === 'customer' || k === 'supplier';

export interface CreateResult {
  created: boolean;
  /** The record's name in ERPNext. */
  name: string;
  /** Ledgers only: the group it was placed under, without the company suffix. */
  group?: string;
}

const same = (a: unknown, b: string) => typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
const short = (account: string) => account.replace(/\s+-\s+[^-]+$/, '');

export async function createParty(c: Container, tenant: Tenant, kind: 'customer' | 'supplier', name: string): Promise<CreateResult> {
  const doctype = kind === 'customer' ? 'Customer' : 'Supplier';
  const field = kind === 'customer' ? 'customer_name' : 'supplier_name';
  const erp = c.erp(tenant);
  // "like" without wildcards is a case-insensitive equality in ERPNext; re-checked exactly here.
  const [byName, byTitle] = await Promise.all([
    erp.list<Record<string, unknown>>(doctype, { filters: [['name', 'like', name]], fields: ['name', field], limit: 20 }),
    erp.list<Record<string, unknown>>(doctype, { filters: [[field, 'like', name]], fields: ['name', field], limit: 20 }),
  ]);
  const existing = [...byName, ...byTitle].find((r) => same(r.name, name) || same(r[field], name));
  if (existing) return { created: false, name: String(existing.name) };
  const created = await erp.create<{ name?: string }>(doctype, partyDoc(doctype, name, { country: tenant.country }));
  return { created: true, name: created.name ?? name };
}

type AccountRow = { name: string; account_name?: string; is_group?: number; root_type?: string; account_type?: string; parent_account?: string };

/** The group a new ledger of this kind belongs under, from the company's own chart. */
function parentFor(kind: LedgerKind, groups: AccountRow[]): AccountRow | undefined {
  const find = (...tests: Array<(g: AccountRow) => boolean>) => tests.map((t) => groups.find(t)).find(Boolean);
  const named = (re: RegExp) => (g: AccountRow) => re.test(short(g.name));
  switch (kind) {
    case 'expense':
      return find(named(/^indirect expenses?$/i), (g) => g.root_type === 'Expense' && /expense/i.test(g.name) && Boolean(g.parent_account), (g) => g.root_type === 'Expense');
    case 'income':
      return find(named(/^indirect income$/i), named(/^direct income$/i), (g) => g.root_type === 'Income' && Boolean(g.parent_account), (g) => g.root_type === 'Income');
    case 'bank':
      return find((g) => g.account_type === 'Bank', named(/^bank accounts?$/i));
    case 'cash':
      return find((g) => g.account_type === 'Cash', named(/^cash in hand$/i));
  }
}

const ROOT_TYPE: Record<LedgerKind, string> = { expense: 'Expense', income: 'Income', bank: 'Asset', cash: 'Asset' };

export async function createLedger(c: Container, tenant: Tenant, kind: LedgerKind, name: string): Promise<CreateResult> {
  const ctx = erpContext(tenant);
  const erp = c.erp(tenant);
  const rows = await erp.list<AccountRow>('Account', {
    filters: [['company', '=', ctx.company]],
    fields: ['name', 'account_name', 'is_group', 'root_type', 'account_type', 'parent_account'],
    limit: 5000,
  });
  const existing = rows.find((r) => same(r.account_name, name) || same(short(r.name), name));
  if (existing) return { created: false, name: existing.name, group: existing.parent_account ? short(existing.parent_account) : undefined };
  const parent = parentFor(kind, rows.filter((r) => Number(r.is_group) === 1));
  if (!parent) throw new Error(`no ${kind} group in the chart of accounts of ${ctx.company}`);
  const created = await erp.create<{ name?: string }>('Account', {
    account_name: name,
    parent_account: parent.name,
    company: ctx.company,
    is_group: 0,
    root_type: ROOT_TYPE[kind], // ERPNext takes it from the parent; set for clarity
    ...(kind === 'bank' ? { account_type: 'Bank' } : kind === 'cash' ? { account_type: 'Cash' } : {}),
  });
  clearAccountCache(tenant.id); // so the new ledger can be picked for bills straight away
  return { created: true, name: created.name ?? `${name} - ${ctx.abbr}`, group: short(parent.name) };
}
