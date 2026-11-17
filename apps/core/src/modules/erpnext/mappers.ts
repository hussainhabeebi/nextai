import { ErpError, type ErpClient } from '@nextai/erpnext-client';
import { tenantSettingsSchema, type DraftPayload, type DraftType, type TenantSettings } from '@nextai/shared';
import type { Tenant } from '@prisma/client';

/** Resolved ERPNext naming context for a tenant. */
export interface ErpContext {
  company: string;
  abbr: string;
  settings: TenantSettings;
  country: 'IN' | 'AE';
}

export function erpContext(tenant: Tenant): ErpContext {
  const settings = tenantSettingsSchema.parse(tenant.settings ?? {});
  const company = settings.erpCompany ?? tenant.name;
  const abbr =
    settings.companyAbbr ??
    company
      .split(/\s+/)
      .filter((w) => /^[A-Za-z]/.test(w))
      .map((w) => w[0]!.toUpperCase())
      .join('')
      .slice(0, 5);
  return { company, abbr, settings, country: tenant.country };
}

/** Default ERPNext account names (standard chart of accounts); overridable via settings.accounts. */
export function account(ctx: ErpContext, key: string): string {
  const override = ctx.settings.accounts[key];
  if (override) return override;
  const base: Record<string, string> = {
    cash: 'Cash',
    bank: ctx.settings.defaultBankAccount ?? 'Bank Account', // leaf; 'Bank Accounts' is the group
    misc_expense: 'Miscellaneous Expenses',
    sales: 'Sales',
    receivable: 'Debtors',
    payable: 'Creditors',
  };
  const name = base[key] ?? key;
  return name.includes(' - ') ? name : `${name} - ${ctx.abbr}`;
}

/**
 * Keyword → candidate expense ledgers, most specific first. The first candidate that exists in the company's chart
 * wins (custom ledgers like "Software Subscriptions" are preferred when present). VendorMapping wins over all of this.
 */
/** Whole words only (with plural/verb endings), so "team" isn't "tea", "business" isn't "bus", "cable" isn't "cab". */
const words = (...w: string[]) => new RegExp(String.raw`(?<![a-z0-9])(?:${w.join('|')})(?:s|es|ing)?(?![a-z0-9])`);

export const EXPENSE_RULES: Array<[RegExp, string[]]> = [
  [words('software', 'subscription', 'saas', 'api', 'cloud', 'hosting', 'server', 'domain', 'aws', 'azure', 'gcp', 'google cloud', 'google workspace', 'gemini', 'openai', 'chatgpt', 'claude', 'anthropic', 'github', 'figma', 'canva', 'zoom', 'slack', 'notion', 'microsoft 365', 'office 365', 'adobe', 'licen[cs]e'),
    ['Software Subscriptions', 'Software Expenses', 'Software', 'Subscriptions', 'Computer Expenses', 'IT Expenses', 'Internet Expenses', 'Telephone Expenses']],
  [words('google ads', 'facebook', 'instagram', 'meta ads', 'linkedin', 'advert(?:isement|ising)?', 'marketing', 'promotion', 'seo', 'campaign'), ['Marketing Expenses', 'Advertisement Expenses', 'Advertising', 'Sales Expenses']],
  [words('tea', 'coffee', 'food', 'lunch', 'dinner', 'breakfast', 'snack', 'meal', 'chai', 'restaurant', 'swiggy', 'zomato', 'talabat'), ['Entertainment Expenses', 'Staff Welfare Expenses', 'Food Expenses', 'Refreshment Expenses']],
  [words('petrol', 'diesel', 'fuel', 'taxi', 'uber', 'ola', 'cab', 'travel', 'bus', 'train', 'flight', 'careem', 'hotel', 'parking', 'toll', 'salik'), ['Travel Expenses', 'Travelling Expenses', 'Conveyance Expenses', 'Fuel Expenses']],
  [words('rent', 'lease'), ['Office Rent', 'Rent', 'Rent Expenses']],
  [words('internet', 'wifi', 'broadband', 'phone', 'mobile', 'recharge', 'airtel', 'jio', 'vodafone', 'vi', 'etisalat', 'du', 'telecom'), ['Telephone Expenses', 'Internet Expenses', 'Communication Expenses', 'Utility Expenses']],
  [words('electricity', 'electric', 'power bill', 'water bill', 'water', 'kseb', 'dewa', 'sewa', 'gas bill'), ['Utility Expenses', 'Electricity Expenses', 'Electricity Charges']],
  [words('salary', 'salaries', 'wage', 'staff pay', 'payroll'), ['Salary', 'Salaries', 'Salary Expenses', 'Wages']],
  [words('stationery', 'paper', 'pen', 'printer', 'ink', 'toner', 'printing'), ['Print and Stationery', 'Printing and Stationery', 'Stationery', 'Office Maintenance Expenses']],
  [words('repair', 'maintenance', 'plumber', 'electrician', 'cleaning', 'housekeeping'), ['Repairs and Maintenance', 'Office Maintenance Expenses']],
  [words('courier', 'postage', 'shipping', 'delivery', 'dhl', 'fedex', 'aramex', 'blue dart', 'dtdc'), ['Postal Expenses', 'Courier Charges', 'Freight and Forwarding Charges']],
  [words('legal', 'lawyer', 'advocate', 'audit', 'ca', 'chartered accountant', 'consultant', 'consultancy', 'professional fee', 'accounting fee'), ['Legal Expenses', 'Professional Fees', 'Audit Fees', 'Consultancy Charges']],
  [words('bank charge', 'bank fee', 'transaction fee', 'gateway fee', 'razorpay fee', 'stripe fee', 'commission'), ['Bank Charges', 'Commission on Sales', 'Bank Fees']],
  [words('insurance'), ['Insurance Expenses', 'Insurance']],
];

const baseName = (name: string) => name.replace(/\s+-\s+[^-]+$/, '').trim().toLowerCase();

/**
 * Expense ledger for a free-text description. With `ledgers` (the company's real expense ledgers) only an existing
 * ledger is returned and `matched` says whether a keyword rule found it; without, the first candidate is a hint.
 */
export function guessExpenseAccount(ctx: ErpContext, description = '', ledgers?: string[]): string {
  return matchExpenseRule(ctx, description, ledgers)?.account ?? (ledgers?.find((l) => baseName(l) === 'miscellaneous expenses') ?? account(ctx, 'misc_expense'));
}

export function matchExpenseRule(ctx: ErpContext, description: string, ledgers?: string[]): { account: string } | undefined {
  const d = description.toLowerCase();
  for (const [re, candidates] of EXPENSE_RULES) {
    if (!re.test(d)) continue;
    if (!ledgers) return { account: `${candidates[0]} - ${ctx.abbr}` };
    for (const cand of candidates) {
      const hit = ledgers.find((l) => baseName(l) === cand.toLowerCase());
      if (hit) return { account: hit };
    }
  }
  return undefined;
}

/** Find a ledger the user typed ("account software") among the real ones: exact, then starts-with, then contains. */
export function findLedger(typed: string, ledgers: string[]): string | undefined {
  const q = typed.trim().toLowerCase();
  if (!q) return undefined;
  return (
    ledgers.find((l) => l.toLowerCase() === q || baseName(l) === q) ??
    ledgers.find((l) => baseName(l).startsWith(q)) ??
    ledgers.find((l) => baseName(l).includes(q))
  );
}

/** Purchase-side tax template. India Compliance default names; UAE VAT template; overridable. */
export function purchaseTaxTemplate(ctx: ErpContext, taxes?: DraftPayload['taxes']): string | undefined {
  if (!taxes) return undefined;
  const t = ctx.settings.taxTemplates;
  if (ctx.country === 'IN') {
    if ((taxes.igst ?? 0) > 0) return t.purchase_igst ?? `Input GST Out-state - ${ctx.abbr}`;
    if ((taxes.cgst ?? 0) > 0 || (taxes.sgst ?? 0) > 0) return t.purchase_gst ?? `Input GST In-state - ${ctx.abbr}`;
    return undefined;
  }
  return (taxes.vat ?? 0) > 0 ? (t.purchase_vat ?? `UAE VAT 5% - ${ctx.abbr}`) : undefined;
}

export function salesTaxTemplate(ctx: ErpContext, interState = false): string | undefined {
  const t = ctx.settings.taxTemplates;
  if (ctx.country === 'IN') return interState ? (t.sales_igst ?? `Output GST Out-state - ${ctx.abbr}`) : (t.sales_gst ?? `Output GST In-state - ${ctx.abbr}`);
  return t.sales_vat ?? `UAE VAT 5% - ${ctx.abbr}`;
}

export const DOCTYPE_FOR: Record<DraftType, string> = {
  purchase_invoice: 'Purchase Invoice',
  journal_entry: 'Journal Entry',
  sales_invoice: 'Sales Invoice',
  payment_in: 'Payment Entry',
  payment_out: 'Payment Entry',
};

/**
 * Which money account a payment mode uses. Default is cash: only an explicit bank-type mode goes to the bank.
 * A card goes to the business's card account (settings.accounts.card, e.g. "HDFC Credit Card - ABC") when set,
 * otherwise to cash: a credit card is not the bank account.
 */
export function moneyAccount(ctx: ErpContext, mode?: string): { account: string; voucherType: string; modeOfPayment: string; kind: 'cash' | 'bank' | 'card' } {
  const m = (mode ?? '').toLowerCase();
  if (/card/.test(m) && ctx.settings.accounts.card) {
    return { account: account(ctx, 'card'), voucherType: 'Credit Card Entry', modeOfPayment: 'Credit Card', kind: 'card' };
  }
  if (/bank|upi|transfer|cheque|check|neft|imps|rtgs|wire|online|gpay|phonepe|paytm/.test(m)) {
    return { account: account(ctx, 'bank'), voucherType: 'Bank Entry', modeOfPayment: 'Bank Draft', kind: 'bank' };
  }
  return { account: account(ctx, 'cash'), voucherType: 'Cash Entry', modeOfPayment: 'Cash', kind: 'cash' };
}

/** Map a confirmed draft payload to an ERPNext document body. Pure function – unit tested. */
export function toErpDoc(type: DraftType, p: DraftPayload, ctx: ErpContext): Record<string, unknown> {
  const remarks = [p.remarks, p.documentId ? `NextAi doc ${p.documentId}` : undefined].filter(Boolean).join(' · ') || undefined;
  const lines = p.lines.length ? p.lines : [{ description: p.remarks ?? 'Expense', qty: 1, rate: p.total, amount: p.total }];
  switch (type) {
    case 'purchase_invoice': {
      const paid = p.paymentMode && p.paymentMode !== 'credit' && p.paymentMode !== 'unknown';
      return {
        doctype: 'Purchase Invoice',
        company: ctx.company,
        supplier: p.partyName,
        bill_no: p.billNo,
        bill_date: p.date,
        posting_date: p.date,
        set_posting_time: 1,
        due_date: p.dueDate ?? p.date,
        currency: p.currency,
        taxes_and_charges: p.taxTemplate,
        remarks,
        items: lines.map((l) => ({
          item_code: l.itemCode,
          item_name: l.description.slice(0, 140),
          description: l.description,
          qty: l.qty,
          rate: l.rate,
          uom: 'Nos',
          expense_account: l.account ?? p.expenseAccount ?? account(ctx, 'misc_expense'),
        })),
        ...(paid
          ? {
              is_paid: 1,
              mode_of_payment: moneyAccount(ctx, p.paymentMode).modeOfPayment,
              cash_bank_account: p.paidFromAccount ?? moneyAccount(ctx, p.paymentMode).account,
              paid_amount: p.total,
            }
          : {}),
      };
    }
    case 'journal_entry': {
      const expense = p.expenseAccount ?? account(ctx, 'misc_expense');
      const money = moneyAccount(ctx, p.paymentMode);
      const credit = p.paidFromAccount ?? money.account;
      return {
        doctype: 'Journal Entry',
        voucher_type: money.voucherType,
        company: ctx.company,
        posting_date: p.date,
        // ERPNext requires a reference on Bank Entries.
        cheque_no: p.referenceNo ?? (money.kind === 'cash' ? undefined : `NX-${p.documentId?.slice(0, 8) ?? Date.now()}`),
        cheque_date: p.referenceNo || money.kind !== 'cash' ? p.date : undefined,
        user_remark: remarks ?? lines.map((l) => l.description).join(', '),
        // Row 0 is the other account (expense, capital, loan ...), row 1 the cash/bank (see resolveAccounts).
        accounts:
          p.direction === 'in'
            ? [
                { account: expense, debit_in_account_currency: 0, credit_in_account_currency: p.total },
                { account: p.paidToAccount ?? money.account, debit_in_account_currency: p.total, credit_in_account_currency: 0 },
              ]
            : [
                { account: expense, debit_in_account_currency: p.total, credit_in_account_currency: 0 },
                { account: credit, debit_in_account_currency: 0, credit_in_account_currency: p.total },
              ],
      };
    }
    case 'sales_invoice':
      return {
        doctype: 'Sales Invoice',
        company: ctx.company,
        customer: p.partyName,
        posting_date: p.date,
        set_posting_time: 1,
        due_date: p.dueDate ?? p.date,
        currency: p.currency,
        taxes_and_charges: p.taxTemplate,
        remarks,
        items: lines.map((l) => ({
          item_code: l.itemCode,
          item_name: l.description.slice(0, 140),
          description: l.description,
          qty: l.qty,
          rate: l.rate,
          uom: 'Nos',
          income_account: l.account ?? account(ctx, 'sales'),
        })),
      };
    case 'payment_in':
    case 'payment_out': {
      const receive = type === 'payment_in';
      const money = moneyAccount(ctx, p.paymentMode);
      const bankOrCash = money.account;
      return {
        doctype: 'Payment Entry',
        payment_type: receive ? 'Receive' : 'Pay',
        company: ctx.company,
        posting_date: p.date,
        party_type: receive ? 'Customer' : 'Supplier',
        party: p.partyName,
        mode_of_payment: money.modeOfPayment,
        paid_amount: p.total,
        received_amount: p.total,
        ...(receive ? { paid_to: p.paidToAccount ?? bankOrCash } : { paid_from: p.paidFromAccount ?? bankOrCash }),
        reference_no: p.referenceNo ?? (money.kind === 'cash' ? undefined : `NX-${Date.now()}`),
        reference_date: p.date,
        remarks,
        ...(p.invoiceRef
          ? { references: [{ reference_doctype: receive ? 'Sales Invoice' : 'Purchase Invoice', reference_name: p.invoiceRef, allocated_amount: p.total }] }
          : {}),
      };
    }
  }
}

export function partyDoc(kind: 'Customer' | 'Supplier', name: string, extra: { taxId?: string; phone?: string; country: 'IN' | 'AE'; group?: string; territory?: string }) {
  return kind === 'Customer'
    ? {
        doctype: 'Customer',
        customer_name: name,
        customer_type: 'Company',
        customer_group: extra.group ?? 'All Customer Groups',
        territory: extra.territory ?? 'All Territories',
        tax_id: extra.taxId,
        mobile_no: extra.phone,
        ...(extra.country === 'IN' && extra.taxId ? { gstin: extra.taxId } : {}),
      }
    : {
        doctype: 'Supplier',
        supplier_name: name,
        supplier_group: extra.group ?? 'All Supplier Groups',
        supplier_type: 'Company',
        tax_id: extra.taxId,
        mobile_no: extra.phone,
        ...(extra.country === 'IN' && extra.taxId ? { gstin: extra.taxId } : {}),
      };
}

const TREE = {
  'Customer Group': { field: 'customer_group_name', parent: 'parent_customer_group', root: 'All Customer Groups', prefer: /^(commercial|company|general|individual)$/i },
  'Supplier Group': { field: 'supplier_group_name', parent: 'parent_supplier_group', root: 'All Supplier Groups', prefer: /^(local|general|services|raw material)$/i },
  Territory: { field: 'territory_name', parent: 'parent_territory', root: 'All Territories', prefer: undefined as RegExp | undefined },
} as const;
const leafCache = new Map<string, string>();

/**
 * A non-group Customer Group / Supplier Group / Territory to put a new party in: ERPNext rejects the root groups
 * ("Cannot select a Group type Customer Group"). Uses the site's own (Commercial, Local, the country ...), and
 * creates "General" under the root when the site has none.
 */
export async function leafOf(erp: Pick<ErpClient, 'list' | 'create'>, doctype: keyof typeof TREE, cacheKey: string, country?: 'IN' | 'AE'): Promise<string> {
  const key = `${cacheKey}:${doctype}`;
  const hit = leafCache.get(key);
  if (hit) return hit;
  const t = TREE[doctype];
  const rows = await erp.list<{ name: string }>(doctype, { filters: [['is_group', '=', 0]], fields: ['name'], limit: 100 });
  const countryName = country === 'IN' ? /^india$/i : country === 'AE' ? /^(united arab emirates|uae)$/i : undefined;
  let leaf = (countryName && rows.find((r) => countryName.test(r.name))) || (t.prefer && rows.find((r) => t.prefer!.test(r.name))) || rows[0];
  if (!leaf) leaf = await erp.create<{ name: string }>(doctype, { name: 'General', [t.field]: 'General', [t.parent]: t.root, is_group: 0 });
  leafCache.set(key, leaf.name);
  return leaf.name;
}

/** Customer/supplier group (and territory) for a new party in this tenant's ERPNext. */
export async function partyPlacement(erp: Pick<ErpClient, 'list' | 'create'>, kind: 'Customer' | 'Supplier', cacheKey: string, country: 'IN' | 'AE') {
  return kind === 'Customer'
    ? { group: await leafOf(erp, 'Customer Group', cacheKey), territory: await leafOf(erp, 'Territory', cacheKey, country) }
    : { group: await leafOf(erp, 'Supplier Group', cacheKey) };
}

type AccountRole = 'bank' | 'cash' | 'expense' | 'income';
export type ChartEntry = { rootType?: string; accountType?: string };
const accountCache = new Map<string, { at: number; ok: Set<string>; expense: string[]; types: Map<string, ChartEntry>; fallback: Partial<Record<AccountRole, string>> }>();

/** Account types that are expenses in the chart but never a target for a typed/photographed bill. */
const NON_BILL_EXPENSE_TYPES = new Set(['Cost of Goods Sold', 'Stock Adjustment', 'Depreciation', 'Round Off', 'Expenses Included In Valuation', 'Expenses Included In Asset Valuation', 'Temporary', 'Accumulated Depreciation']);

/**
 * Make sure every account in an ERPNext document body exists in the company and is a ledger (not a group);
 * otherwise substitute the company's own bank / cash / expense / income ledger. Charts differ between sites
 * (custom charts, India Compliance, renamed accounts), so names guessed from the standard chart are only hints.
 * Mutates and returns the body; the substitutions are returned so callers can keep the draft in sync.
 */
export async function resolveAccounts(
  erp: Pick<ErpClient, 'list'>,
  ctx: ErpContext,
  body: Record<string, unknown>,
  cacheKey: string = ctx.company, // pass the tenant id: company names can repeat across ERPNext sites
): Promise<Record<string, string>> {
  const cache = await loadChart(erp, ctx, cacheKey);
  return applyChart(cache, body);
}

/** The company's ledgers (cached 10 min per tenant + company). */
async function loadChart(erp: Pick<ErpClient, 'list'>, ctx: ErpContext, cacheKey: string) {
  const key = `${cacheKey}:${ctx.company}`;
  let cache = accountCache.get(key);
  if (!cache || Date.now() - cache.at > 10 * 60_000) {
    const rows = await erp.list<{ name: string; is_group: number; account_type?: string; root_type?: string }>('Account', {
      filters: [['company', '=', ctx.company]],
      fields: ['name', 'is_group', 'account_type', 'root_type'],
      limit: 5000,
    });
    const leaves = rows.filter((r) => !r.is_group);
    const pick = (pred: (r: (typeof leaves)[number]) => boolean, preferred?: string) =>
      (preferred && leaves.find((r) => r.name === preferred)?.name) ?? leaves.find(pred)?.name;
    cache = {
      at: Date.now(),
      ok: new Set(leaves.map((r) => r.name)),
      types: new Map(leaves.map((r) => [r.name, { rootType: r.root_type, accountType: r.account_type || undefined }])),
      expense: leaves.filter((r) => r.root_type === 'Expense' && !NON_BILL_EXPENSE_TYPES.has(r.account_type ?? '')).map((r) => r.name).sort(),
      fallback: {
        bank: pick((r) => r.account_type === 'Bank', ctx.settings.defaultBankAccount),
        cash: pick((r) => r.account_type === 'Cash', `Cash - ${ctx.abbr}`),
        expense: pick((r) => r.root_type === 'Expense' && !r.account_type, `Miscellaneous Expenses - ${ctx.abbr}`),
        income: pick((r) => r.root_type === 'Income', `Sales - ${ctx.abbr}`),
      },
    };
    accountCache.set(key, cache);
  }
  return cache;
}

/** Root/account type of every ledger in the company's chart (for reports: income vs expense, cash/bank, tax). */
export async function chartTypes(erp: Pick<ErpClient, 'list'>, ctx: ErpContext, cacheKey: string): Promise<Map<string, ChartEntry>> {
  return (await loadChart(erp, ctx, cacheKey)).types;
}

/** The company's expense ledgers that a bill can be booked to (empty when ERPNext can't be read). */
export async function expenseLedgers(erp: Pick<ErpClient, 'list'>, ctx: ErpContext, cacheKey: string): Promise<string[]> {
  return (await loadChart(erp, ctx, cacheKey)).expense;
}

function applyChart(cache: NonNullable<ReturnType<typeof accountCache.get>>, body: Record<string, unknown>): Record<string, string> {
  const changed: Record<string, string> = {};
  const fix = (name: unknown, role: AccountRole): unknown => {
    if (typeof name !== 'string' || !name || cache!.ok.has(name)) return name;
    const sub = cache!.fallback[role];
    if (!sub) return name; // nothing better known: let ERPNext report it
    changed[name] = sub;
    return sub;
  };
  // A missing card account falls back to cash (the default), not to the bank.
  const roleOfCashBank = (name: unknown) => (typeof name === 'string' && /cash|card/i.test(name) ? 'cash' : 'bank');
  for (const item of (body.items as Array<Record<string, unknown>> | undefined) ?? []) {
    if ('expense_account' in item) item.expense_account = fix(item.expense_account, 'expense');
    if ('income_account' in item) item.income_account = fix(item.income_account, 'income');
  }
  if ('cash_bank_account' in body) body.cash_bank_account = fix(body.cash_bank_account, roleOfCashBank(body.cash_bank_account));
  if ('paid_from' in body) body.paid_from = fix(body.paid_from, roleOfCashBank(body.paid_from));
  if ('paid_to' in body) body.paid_to = fix(body.paid_to, roleOfCashBank(body.paid_to));
  const rows = (body.accounts as Array<Record<string, unknown>> | undefined) ?? [];
  rows.forEach((row, i) => {
    // Journal Entry: first row is the expense (debit), second the cash/bank (credit) — see toErpDoc.
    row.account = fix(row.account, i === 0 ? 'expense' : roleOfCashBank(row.account));
  });
  return changed;
}

/** Forget a cached chart of accounts (after reconnecting a tenant to another site/company), or all of them. */
export function clearAccountCache(cacheKey?: string) {
  if (!cacheKey) return accountCache.clear();
  for (const k of accountCache.keys()) if (k.startsWith(`${cacheKey}:`)) accountCache.delete(k);
}

const TAX_TEMPLATE_DOCTYPE: Record<string, string> = {
  'Purchase Invoice': 'Purchase Taxes and Charges Template',
  'Sales Invoice': 'Sales Taxes and Charges Template',
};

/**
 * ERPNext fills tax rows from `taxes_and_charges` only in the desk UI, not on API inserts, so a bill posted with
 * just the template name loses its VAT/GST. Copy the template's rows onto the document explicitly.
 */
export async function applyTaxTemplate(erp: Pick<ErpClient, 'get'>, body: Record<string, unknown>): Promise<void> {
  const name = body.taxes_and_charges;
  const doctype = TAX_TEMPLATE_DOCTYPE[body.doctype as string];
  if (typeof name !== 'string' || !name || !doctype || (Array.isArray(body.taxes) && body.taxes.length)) return;
  let tpl: Record<string, unknown>;
  try {
    tpl = await erp.get(doctype, name);
  } catch (err) {
    if (err instanceof ErpError && err.status === 404) {
      throw new ErpError(
        `missing ${doctype} ${name}`,
        404,
        'DoesNotExistError',
        `Tax template "${name}" does not exist in ERPNext. Create it there, or set the business's tax template names.`,
        false,
      );
    }
    throw err;
  }
  const keep = ['category', 'add_deduct_tax', 'charge_type', 'row_id', 'account_head', 'description', 'rate', 'cost_center', 'included_in_print_rate', 'tax_amount'];
  body.taxes = ((tpl.taxes as Array<Record<string, unknown>> | undefined) ?? []).map((row) =>
    Object.fromEntries(keep.filter((k) => row[k] !== undefined && row[k] !== null).map((k) => [k, row[k]])),
  );
}
