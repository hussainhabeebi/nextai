/**
 * "Create supplier account AM Motors" / "create capital account Hussain" / "open bank account HDFC" /
 * "create account Hussain Drawings under Capital Account": add a customer or supplier, or a ledger of any kind to the
 * company's chart of accounts, in the tenant's ERPNext. Nothing is created twice: an existing record (same name,
 * any letter case) is reported instead.
 */
import type { AccountKind } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { clearAccountCache, erpContext, partyDoc, partyPlacement } from './mappers.js';

export type LedgerKind = Exclude<AccountKind, 'customer' | 'supplier'>;
export const isPartyKind = (k: AccountKind): k is 'customer' | 'supplier' => k === 'customer' || k === 'supplier';

export const KIND_LABEL: Record<AccountKind, string> = {
  customer: 'Customer',
  supplier: 'Supplier',
  expense: 'Expense account',
  direct_expense: 'Direct expense account',
  income: 'Income account',
  direct_income: 'Direct income account',
  bank: 'Bank account',
  cash: 'Cash account',
  capital: 'Capital account',
  liability: 'Liability account',
  loan: 'Loan account',
  tax: 'Tax account',
  asset: 'Asset account',
  fixed_asset: 'Fixed asset account',
  loan_advance: 'Loans & advances account',
  stock: 'Stock account',
  investment: 'Investment account',
};

export interface CreateResult {
  created: boolean;
  /** The record's name in ERPNext. */
  name: string;
  /** Ledgers only: the group it was placed under, without the company suffix. */
  group?: string;
}

export class GroupNotFound extends Error {
  constructor(
    readonly asked: string | undefined,
    readonly groups: string[],
  ) {
    super(asked ? `no account group like "${asked}"` : 'no suitable account group');
  }
}

const same = (a: unknown, b: string) => typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
const short = (account: string) => account.replace(/\s+-\s+[^-]+$/, '');
const squash = (s: string) => s.toLowerCase().replace(/\(.*?\)|[^a-z0-9]+/g, '');

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
  const placement = await partyPlacement(erp, doctype, tenant.id, tenant.country);
  const created = await erp.create<{ name?: string }>(doctype, partyDoc(doctype, name, { country: tenant.country, ...placement }));
  return { created: true, name: created.name ?? name };
}

type AccountRow = { name: string; account_name?: string; is_group?: number; root_type?: string; account_type?: string; parent_account?: string };
type Test = (g: AccountRow) => boolean;

const named = (re: RegExp): Test => (g) => re.test(short(g.name));
const typed = (t: string): Test => (g) => g.account_type === t;
const rooted = (root: string): Test => (g) => g.root_type === root && Boolean(g.parent_account);
const root = (r: string): Test => (g) => g.root_type === r;

/**
 * Where each kind of ledger goes, best guess first. Charts differ (ERPNext standard, India, UAE, custom), so names
 * from the standard charts come first, then account types, then any group of the right root type.
 */
const PLACEMENT: Record<LedgerKind, { tests: Test[]; rootType: string; accountType?: string }> = {
  expense: { tests: [named(/^indirect expenses?$/i), (g) => rooted('Expense')(g) && /expense/i.test(g.name) && !/^direct/i.test(short(g.name)), rooted('Expense'), root('Expense')], rootType: 'Expense' },
  direct_expense: { tests: [named(/^direct expenses?$/i), named(/^cost of (goods sold|sales)$/i), rooted('Expense'), root('Expense')], rootType: 'Expense' },
  income: { tests: [named(/^indirect incomes?$/i), named(/^other incomes?$/i), rooted('Income'), root('Income')], rootType: 'Income' },
  direct_income: { tests: [named(/^direct incomes?$/i), named(/^sales( accounts?)?$/i), rooted('Income'), root('Income')], rootType: 'Income' },
  bank: { tests: [typed('Bank'), named(/^bank accounts?$/i)], rootType: 'Asset', accountType: 'Bank' },
  cash: { tests: [typed('Cash'), named(/^cash in hand$/i), named(/^cash$/i)], rootType: 'Asset', accountType: 'Cash' },
  capital: { tests: [named(/^capital accounts?$/i), named(/capital/i), rooted('Equity'), root('Equity'), named(/source of funds/i)], rootType: 'Equity' },
  liability: { tests: [named(/^current liabilities$/i), rooted('Liability'), root('Liability')], rootType: 'Liability' },
  loan: { tests: [named(/^loans? \(liabilities\)$/i), named(/^(secured|unsecured) loans?$/i), (g) => g.root_type === 'Liability' && /loan/i.test(g.name), named(/^current liabilities$/i), rooted('Liability'), root('Liability')], rootType: 'Liability' },
  tax: { tests: [named(/^duties and taxes$/i), (g) => typed('Tax')(g) && g.root_type === 'Liability', named(/tax/i), named(/^current liabilities$/i), root('Liability')], rootType: 'Liability', accountType: 'Tax' },
  asset: { tests: [named(/^current assets$/i), rooted('Asset'), root('Asset')], rootType: 'Asset' },
  fixed_asset: { tests: [named(/^fixed assets$/i), typed('Fixed Asset'), named(/fixed asset/i), rooted('Asset'), root('Asset')], rootType: 'Asset', accountType: 'Fixed Asset' },
  loan_advance: { tests: [named(/^loans and advances( \(assets\))?$/i), named(/advances/i), named(/^current assets$/i), rooted('Asset'), root('Asset')], rootType: 'Asset' },
  stock: { tests: [named(/^stock assets$/i), typed('Stock'), named(/^(stock|inventory)/i), named(/^current assets$/i), root('Asset')], rootType: 'Asset', accountType: 'Stock' },
  investment: { tests: [named(/^investments?$/i), named(/investment/i), rooted('Asset'), root('Asset')], rootType: 'Asset' },
};

/** A group the user named ("Capital Account", "duties & taxes", "Loans (Liabilities)"), forgiving case and punctuation. */
export function findGroup(asked: string, groups: AccountRow[]): AccountRow | undefined {
  const a = squash(asked);
  if (!a) return undefined;
  return (
    groups.find((g) => squash(short(g.name)) === a) ??
    groups.find((g) => squash(short(g.name)) === `${a}s` || `${squash(short(g.name))}s` === a) ??
    groups.find((g) => squash(short(g.name)).startsWith(a)) ??
    groups.find((g) => squash(short(g.name)).includes(a))
  );
}

/** Account group names (without the company suffix), for "which group?" replies. */
export async function accountGroups(c: Container, tenant: Tenant): Promise<string[]> {
  return (await chart(c, tenant)).filter((r) => Number(r.is_group) === 1).map((r) => short(r.name));
}

async function chart(c: Container, tenant: Tenant): Promise<AccountRow[]> {
  return c.erp(tenant).list<AccountRow>('Account', {
    filters: [['company', '=', erpContext(tenant).company]],
    fields: ['name', 'account_name', 'is_group', 'root_type', 'account_type', 'parent_account'],
    limit: 5000,
  });
}

/** Create a ledger of `kind`, or under the group the user named. One of the two is needed. */
export async function createLedger(c: Container, tenant: Tenant, opts: { kind?: LedgerKind; group?: string; name: string }): Promise<CreateResult> {
  const ctx = erpContext(tenant);
  const rows = await chart(c, tenant);
  const existing = rows.find((r) => same(r.account_name, opts.name) || same(short(r.name), opts.name));
  if (existing) return { created: false, name: existing.name, group: existing.parent_account ? short(existing.parent_account) : undefined };
  const groups = rows.filter((r) => Number(r.is_group) === 1);
  const place = opts.kind ? PLACEMENT[opts.kind] : undefined;
  const parent = opts.group ? findGroup(opts.group, groups) : place?.tests.map((t) => groups.find(t)).find(Boolean);
  if (!parent) throw new GroupNotFound(opts.group, groups.map((g) => short(g.name)));
  // A bank/cash/tax/stock/fixed-asset type only fits under a group of the same nature; otherwise leave the type empty.
  const accountType = place?.accountType && (parent.root_type ?? place.rootType) === place.rootType ? place.accountType : undefined;
  const created = await c.erp(tenant).create<{ name?: string }>('Account', {
    name: `${opts.name} - ${ctx.abbr}`, // ERPNext names accounts this way itself; given for clients that don't
    account_name: opts.name,
    parent_account: parent.name,
    company: ctx.company,
    is_group: 0,
    root_type: parent.root_type ?? place?.rootType, // ERPNext takes it from the parent; set for clarity
    ...(accountType ? { account_type: accountType } : {}),
  });
  clearAccountCache(tenant.id); // so the new ledger can be picked for bills straight away
  return { created: true, name: created.name ?? `${opts.name} - ${ctx.abbr}`, group: short(parent.name) };
}

const CAPITAL_WORDS = /\b(capital|owner'?s?|directors?'?|partners?'?|proprietors?'?|promoters?'?|shareholders?'?|drawings?|equity)\b/i;
const LOAN_WORDS = /\b(loans?|borrow(?:ed|ing)?|overdraft|od)\b/i;
const NOT_A_NAME = /\b(capital|account|a\/c|acc|ledger|owner'?s?|directors?'?|partners?'?|proprietors?'?|promoters?'?|shareholders?'?|drawings?|equity|loans?|borrow(?:ed|ing)?|overdraft|od|mr|mrs|ms|the|my|our|from|by|as|introduced|invested|contribution|investment)\b\.?/gi;
const MONEY_TYPES = new Set(['Receivable', 'Payable', 'Bank', 'Cash']);

export interface LedgerTarget {
  /** The existing ledger to post against. */
  account?: string;
  /** Or the ledger to create on confirm. */
  newAccount?: { kind: LedgerKind; name: string };
  /** "Capital introduced by Hussain", "Loan received from SBI", "Received from Commission". */
  label: string;
}

/**
 * Money in from / out to something that is not a customer or supplier: the owner's or a director's capital
 * ("received 50000 from Hussain capital account", "director Hussain brought in 1 lakh"), a loan ("loan from SBI"),
 * drawings, or any existing ledger named in the message. These are journal entries against that ledger, not
 * customer receipts or supplier payments. Returns undefined for ordinary customers and suppliers.
 */
export async function ledgerTarget(c: Container, tenant: Tenant, party: string, direction: 'in' | 'out', hint = ''): Promise<LedgerTarget | undefined> {
  const words = `${party} ${hint}`;
  const kind: LedgerKind | undefined = CAPITAL_WORDS.test(words) ? 'capital' : LOAN_WORDS.test(words) ? 'loan' : undefined;
  const bare = party.replace(NOT_A_NAME, ' ').replace(/\s+/g, ' ').trim();
  const name = bare === bare.toLowerCase() ? bare.replace(/\b\w/g, (ch) => ch.toUpperCase()) : bare;
  const rows = await chart(c, tenant);
  const ledgers = rows.filter((r) => Number(r.is_group) !== 1 && !MONEY_TYPES.has(r.account_type ?? ''));
  const wanted = new Set([party, name, `${name} capital`, `${name} capital account`, `${name} drawings`, `${name} loan`, `${name} loan account`].map(squash).filter(Boolean));
  const found = ledgers.find((l) => wanted.has(squash(short(l.name))) || wanted.has(squash(l.account_name ?? '')));
  const label = (what: string) =>
    kind === 'capital'
      ? direction === 'in' ? `Capital introduced by ${what}` : `Drawings by ${what}`
      : kind === 'loan'
        ? direction === 'in' ? `Loan received from ${what}` : `Loan repayment to ${what}`
        : direction === 'in' ? `Received from ${what}` : `Paid to ${what}`;
  if (found) {
    if (!kind) {
      // A plain name that is also a customer/supplier stays a customer/supplier payment.
      const erp = c.erp(tenant);
      const [cust, supp] = await Promise.all([
        erp.list('Customer', { filters: [['name', '=', party]], limit: 1 }),
        erp.list('Supplier', { filters: [['name', '=', party]], limit: 1 }),
      ]);
      if (cust.length || supp.length) return undefined;
    }
    return { account: found.name, label: label(name || short(found.name)) };
  }
  if (kind && name) return { newAccount: { kind, name }, label: label(name) };
  return undefined;
}
