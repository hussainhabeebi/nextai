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
    bank: ctx.settings.defaultBankAccount ?? 'Bank Accounts',
    misc_expense: 'Miscellaneous Expenses',
    sales: 'Sales',
    receivable: 'Debtors',
    payable: 'Creditors',
  };
  const name = base[key] ?? key;
  return name.includes(' - ') ? name : `${name} - ${ctx.abbr}`;
}

/** Keyword → expense account heuristics for free-text expenses. VendorMapping wins when present. */
export function guessExpenseAccount(ctx: ErpContext, description = ''): string {
  const d = description.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/tea|coffee|food|lunch|dinner|snack|meal|chai/, 'Entertainment Expenses'],
    [/petrol|diesel|fuel|taxi|uber|ola|cab|travel|bus|train|flight|careem/, 'Travel Expenses'],
    [/rent/, 'Rent'],
    [/electric|power|water|kseb|dewa|internet|wifi|phone|mobile|recharge/, 'Utility Expenses'],
    [/salary|wage|staff pay/, 'Salary'],
    [/stationery|paper|pen|printer|office/, 'Office Maintenance Expenses'],
    [/courier|postage|shipping|delivery/, 'Postal Expenses'],
    [/advert|marketing|facebook|google ads|instagram/, 'Marketing Expenses'],
  ];
  const hit = rules.find(([re]) => re.test(d));
  return hit ? `${hit[1]} - ${ctx.abbr}` : account(ctx, 'misc_expense');
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

const isCash = (mode?: string) => !mode || /cash/i.test(mode);

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
              mode_of_payment: isCash(p.paymentMode) ? 'Cash' : 'Bank Draft',
              cash_bank_account: p.paidFromAccount ?? account(ctx, isCash(p.paymentMode) ? 'cash' : 'bank'),
              paid_amount: p.total,
            }
          : {}),
      };
    }
    case 'journal_entry': {
      const expense = p.expenseAccount ?? account(ctx, 'misc_expense');
      const credit = p.paidFromAccount ?? account(ctx, isCash(p.paymentMode) ? 'cash' : 'bank');
      return {
        doctype: 'Journal Entry',
        voucher_type: isCash(p.paymentMode) ? 'Cash Entry' : 'Bank Entry',
        company: ctx.company,
        posting_date: p.date,
        cheque_no: p.referenceNo,
        cheque_date: p.referenceNo ? p.date : undefined,
        user_remark: remarks ?? lines.map((l) => l.description).join(', '),
        accounts: [
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
      const bankOrCash = account(ctx, isCash(p.paymentMode) ? 'cash' : 'bank');
      return {
        doctype: 'Payment Entry',
        payment_type: receive ? 'Receive' : 'Pay',
        company: ctx.company,
        posting_date: p.date,
        party_type: receive ? 'Customer' : 'Supplier',
        party: p.partyName,
        mode_of_payment: isCash(p.paymentMode) ? 'Cash' : 'Bank Draft',
        paid_amount: p.total,
        received_amount: p.total,
        ...(receive ? { paid_to: p.paidToAccount ?? bankOrCash } : { paid_from: p.paidFromAccount ?? bankOrCash }),
        reference_no: p.referenceNo ?? (isCash(p.paymentMode) ? undefined : `NX-${Date.now()}`),
        reference_date: p.date,
        remarks,
      };
    }
  }
}

export function partyDoc(kind: 'Customer' | 'Supplier', name: string, extra: { taxId?: string; phone?: string; country: 'IN' | 'AE' }) {
  return kind === 'Customer'
    ? {
        doctype: 'Customer',
        customer_name: name,
        customer_type: 'Company',
        customer_group: 'All Customer Groups',
        territory: 'All Territories',
        tax_id: extra.taxId,
        mobile_no: extra.phone,
        ...(extra.country === 'IN' && extra.taxId ? { gstin: extra.taxId } : {}),
      }
    : {
        doctype: 'Supplier',
        supplier_name: name,
        supplier_group: 'All Supplier Groups',
        supplier_type: 'Company',
        tax_id: extra.taxId,
        mobile_no: extra.phone,
        ...(extra.country === 'IN' && extra.taxId ? { gstin: extra.taxId } : {}),
      };
}
