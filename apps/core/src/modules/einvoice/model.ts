import { round2, type DraftPayload, type EInvoiceScheme, type TenantSettings } from '@nextai/shared';
import type { Tenant } from '@prisma/client';

/** Scheme-neutral invoice model; each scheme (IRP, Peppol, ZATCA) is a pure mapping from this. */
export interface InvoiceModel {
  number: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
  kind: 'invoice' | 'credit_note';
  /** For credit notes: the original invoice number. */
  against?: string;
  currency: string;
  seller: Party;
  buyer: Party;
  /** IN: 2-digit state code where supply is made. */
  placeOfSupply?: string;
  lines: Line[];
  totals: { net: number; cgst: number; sgst: number; igst: number; vat: number; tax: number; total: number };
}

export interface Party {
  name: string;
  taxId?: string;
  line1?: string;
  line2?: string;
  city?: string;
  postalCode?: string;
  stateCode?: string;
  country: string; // ISO 3166-1 alpha-2
}

export interface Line {
  no: number;
  description: string;
  hsn?: string;
  qty: number;
  unit: string;
  unitPrice: number;
  net: number;
  taxRate: number; // percent
  taxAmount: number;
  isService: boolean;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export const defaultScheme = (country: Tenant['country']): EInvoiceScheme => (country === 'IN' ? 'in_irp' : 'ae_peppol');
export const schemeFor = (tenant: Tenant, s: TenantSettings): EInvoiceScheme => s.eInvoicing.scheme ?? defaultScheme(tenant.country);

/** Split an ERPNext taxes table into GST heads / VAT. */
function taxHeads(taxes: Row[]) {
  const h = { cgst: 0, sgst: 0, igst: 0, vat: 0 };
  for (const t of taxes) {
    const label = `${t.account_head ?? ''} ${t.description ?? ''}`.toLowerCase();
    const amt = num(t.tax_amount ?? t.base_tax_amount);
    if (/igst/.test(label)) h.igst += amt;
    else if (/cgst/.test(label)) h.cgst += amt;
    else if (/sgst|utgst/.test(label)) h.sgst += amt;
    else h.vat += amt;
  }
  return h;
}

/** HSN chapter 99 = services (SAC). */
const isServiceHsn = (hsn?: string) => !!hsn && hsn.startsWith('99');

/**
 * Build the model from an ERPNext Sales Invoice (+ Customer). When ERPNext has no taxes table
 * (e.g. the bot posted a simple invoice), tax heads fall back to the NextAi draft payload.
 */
export function buildModel(args: { tenant: Tenant; settings: TenantSettings; invoice: Row; customer?: Row; draft?: DraftPayload }): InvoiceModel {
  const { tenant, settings, invoice: si, customer, draft } = args;
  const country = tenant.country;
  const items = (Array.isArray(si.items) ? (si.items as Row[]) : []).filter(Boolean);
  const rawLines = items.map((it, i) => {
    const qty = num(it.qty) || 1;
    const rate = num(it.rate);
    const net = round2(num(it.net_amount) || num(it.amount) || qty * rate);
    const hsn = str(it.gst_hsn_code) ?? str(it.hsn_code);
    return { no: i + 1, description: str(it.item_name) ?? str(it.description) ?? `Item ${i + 1}`, hsn, qty: Math.abs(qty), unit: (str(it.uom) ?? 'NOS').toUpperCase(), unitPrice: round2(Math.abs(rate) || Math.abs(net / qty)), net: Math.abs(net), isService: isServiceHsn(hsn) };
  });
  const net = round2(rawLines.reduce((s, l) => s + l.net, 0));
  const fromErp = Array.isArray(si.taxes) && (si.taxes as Row[]).length ? taxHeads(si.taxes as Row[]) : undefined;
  const d = draft?.taxes ?? {};
  const heads = fromErp ?? { cgst: num(d.cgst), sgst: num(d.sgst), igst: num(d.igst), vat: num(d.vat) };
  const abs = { cgst: Math.abs(round2(heads.cgst)), sgst: Math.abs(round2(heads.sgst)), igst: Math.abs(round2(heads.igst)), vat: Math.abs(round2(heads.vat)) };
  const tax = round2(abs.cgst + abs.sgst + abs.igst + abs.vat);
  // tax is apportioned to lines by value at the invoice's effective rate (single-rate invoices are the norm for SMEs)
  const rate = net > 0 ? round2((tax / net) * 100) : 0;
  let allocated = 0;
  const lines: Line[] = rawLines.map((l, i) => {
    const t = i === rawLines.length - 1 ? round2(tax - allocated) : round2((l.net * rate) / 100);
    allocated = round2(allocated + t);
    return { ...l, taxRate: rate, taxAmount: t };
  });
  const grand = Math.abs(num(si.grand_total) || num(si.rounded_total)) || round2(net + tax);
  const buyerTaxId = str(si.customer_gstin) ?? str(si.billing_address_gstin) ?? str(si.tax_id) ?? str(customer?.gstin) ?? str(customer?.tax_id) ?? draft?.partyTaxId;
  const buyerState = country === 'IN' && buyerTaxId ? buyerTaxId.slice(0, 2) : undefined;
  const pos = str(si.place_of_supply)?.slice(0, 2) ?? buyerState ?? settings.address.stateCode;
  const posting = String(si.posting_date ?? '').slice(0, 10);
  const time = String(si.posting_time ?? '00:00:00').slice(0, 8).padEnd(8, ':00').slice(0, 8);
  return {
    number: String(si.name),
    date: posting,
    time: /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : '00:00:00',
    kind: num(si.is_return) ? 'credit_note' : 'invoice',
    against: str(si.return_against),
    currency: str(si.currency) ?? tenant.currency,
    seller: {
      name: settings.companyName ?? settings.erpCompany ?? tenant.name,
      taxId: str(si.company_gstin) ?? settings.taxId,
      line1: settings.address.line1,
      line2: settings.address.line2,
      city: settings.address.city,
      postalCode: settings.address.postalCode,
      stateCode: settings.address.stateCode ?? (country === 'IN' && settings.taxId ? settings.taxId.slice(0, 2) : undefined),
      country,
    },
    buyer: {
      name: str(si.customer_name) ?? str(si.customer) ?? 'Customer',
      taxId: buyerTaxId,
      line1: str(customer?.primary_address)?.split('\n')[0] ?? str(si.address_display)?.split('\n')[0],
      city: str(customer?.city),
      postalCode: str(customer?.pincode),
      stateCode: buyerState,
      country: str(customer?.country_code)?.toUpperCase() ?? country,
    },
    placeOfSupply: pos,
    lines,
    totals: { net, ...abs, tax, total: round2(grand) },
  };
}
