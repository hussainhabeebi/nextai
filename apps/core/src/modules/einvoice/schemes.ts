import { approxEqual, isValidGstin, isValidTrn, round2, type EInvoiceScheme } from '@nextai/shared';
import { createHash } from 'node:crypto';
import type { InvoiceModel } from './model.js';

/**
 * Statutory e-invoice formats. Everything here is pure: model in → document + validation out.
 *
 *  in_irp    India GST Invoice Registration Portal, e-invoice JSON schema v1.1. IRN = SHA-256 of
 *            seller GSTIN + financial year + document type + document number.
 *  ae_peppol UAE e-invoicing (FTA, Peppol 5-corner model), UBL 2.1 invoice on the PINT AE profile.
 *  sa_zatca  KSA ZATCA (FATOORA) phase 2, UBL 2.1 with ICV counter, previous-invoice hash chain and
 *            TLV-encoded QR. The XAdES signature / CSID stamp is applied by the onboarding gateway.
 */

export interface BuiltDocument {
  scheme: EInvoiceScheme;
  format: 'json' | 'xml';
  body: string;
  /** IN: IRN; AE/SA: document UUID. */
  id: string;
  /** base64(SHA-256(body)) for ZATCA PIH chaining; hex elsewhere. */
  hash: string;
  qr?: string;
  counter?: number;
  prevHash?: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const sha256b64 = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64');

/** Indian financial year label for a date, e.g. 2026-11-23 → "2026-27". */
export const indianFy = (date: string): string => {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

// ------------------------------------------------------------------ shared checks

function commonIssues(m: InvoiceModel): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (!m.lines.length) out.push({ field: 'lines', message: 'Invoice has no line items' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date)) out.push({ field: 'date', message: 'Invoice date is missing' });
  else if (m.date > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) out.push({ field: 'date', message: 'Invoice date is in the future' });
  if (!approxEqual(m.totals.net + m.totals.tax, m.totals.total, 1)) {
    out.push({ field: 'totals', message: `Lines (${m.totals.net}) + tax (${m.totals.tax}) do not equal the invoice total (${m.totals.total})` });
  }
  if (!m.seller.line1 || !m.seller.city) out.push({ field: 'seller.address', message: 'Your business address is missing (Settings → Business address)' });
  return out;
}

// ------------------------------------------------------------------ India IRP

export const irn = (sellerGstin: string, date: string, docType: 'INV' | 'CRN' | 'DBN', docNo: string): string =>
  sha256hex(`${sellerGstin.toUpperCase()}${indianFy(date)}${docType}${docNo.toUpperCase()}`);

export function validateIrp(m: InvoiceModel): ValidationIssue[] {
  const out = commonIssues(m);
  if (!m.seller.taxId || !isValidGstin(m.seller.taxId)) out.push({ field: 'seller.gstin', message: 'Your GSTIN is missing or invalid (Settings → Tax ID)' });
  if (!m.buyer.taxId) out.push({ field: 'buyer.gstin', message: 'Customer GSTIN is required for B2B e-invoices' });
  else if (m.buyer.taxId !== 'URP' && !isValidGstin(m.buyer.taxId)) out.push({ field: 'buyer.gstin', message: `Customer GSTIN ${m.buyer.taxId} is invalid` });
  if (!/^[A-Z1-9][A-Z0-9/-]{0,15}$/i.test(m.number)) out.push({ field: 'number', message: 'Invoice number must be ≤16 characters (letters, digits, / and -), not starting with 0' });
  if (!/^[1-9]\d{5}$/.test(m.seller.postalCode ?? '')) out.push({ field: 'seller.pin', message: 'Your 6-digit PIN code is missing' });
  if (!/^\d{2}$/.test(m.seller.stateCode ?? '')) out.push({ field: 'seller.state', message: 'Your GST state code is missing' });
  if (!/^\d{2}$/.test(m.placeOfSupply ?? '')) out.push({ field: 'placeOfSupply', message: 'Place of supply is missing' });
  m.lines.forEach((l) => {
    if (!/^(\d{4}|\d{6}|\d{8})$/.test(l.hsn ?? '')) out.push({ field: `lines[${l.no}].hsn`, message: `Line ${l.no} "${l.description}" needs a 4/6/8-digit HSN/SAC code` });
  });
  const intra = m.seller.stateCode === m.placeOfSupply;
  if (intra && m.totals.igst > 0) out.push({ field: 'taxes', message: 'Intra-state supply should carry CGST + SGST, not IGST' });
  if (!intra && (m.totals.cgst > 0 || m.totals.sgst > 0)) out.push({ field: 'taxes', message: 'Inter-state supply should carry IGST, not CGST + SGST' });
  if (!approxEqual(m.totals.cgst, m.totals.sgst, 0.5)) out.push({ field: 'taxes', message: 'CGST and SGST must be equal' });
  return out;
}

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function buildIrp(m: InvoiceModel): BuiltDocument {
  const typ = m.kind === 'credit_note' ? 'CRN' : 'INV';
  const intra = m.seller.stateCode === m.placeOfSupply;
  const share = (l: { taxAmount: number }) => (intra ? { IgstAmt: 0, CgstAmt: round2(l.taxAmount / 2), SgstAmt: round2(l.taxAmount - round2(l.taxAmount / 2)) } : { IgstAmt: l.taxAmount, CgstAmt: 0, SgstAmt: 0 });
  const doc = {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: m.buyer.country !== 'IN' ? 'EXPWP' : 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: typ, No: m.number, Dt: ddmmyyyy(m.date) },
    SellerDtls: { Gstin: m.seller.taxId, LglNm: m.seller.name, Addr1: m.seller.line1, ...(m.seller.line2 ? { Addr2: m.seller.line2 } : {}), Loc: m.seller.city, Pin: Number(m.seller.postalCode), Stcd: m.seller.stateCode },
    BuyerDtls: {
      Gstin: m.buyer.taxId,
      LglNm: m.buyer.name,
      Pos: m.placeOfSupply,
      Addr1: m.buyer.line1 ?? m.buyer.name,
      Loc: m.buyer.city ?? m.seller.city,
      ...(m.buyer.postalCode ? { Pin: Number(m.buyer.postalCode) } : {}),
      Stcd: m.buyer.stateCode ?? m.placeOfSupply,
    },
    ...(m.against ? { PrecDocDtls: [{ InvNo: m.against, InvDt: ddmmyyyy(m.date) }] } : {}),
    ItemList: m.lines.map((l) => ({
      SlNo: String(l.no),
      PrdDesc: l.description.slice(0, 300),
      IsServc: l.isService ? 'Y' : 'N',
      HsnCd: l.hsn,
      Qty: l.qty,
      Unit: l.isService ? undefined : l.unit === 'NOS' || l.unit === 'NUMBERS' ? 'NOS' : l.unit.slice(0, 3),
      UnitPrice: l.unitPrice,
      TotAmt: l.net,
      Discount: 0,
      AssAmt: l.net,
      GstRt: l.taxRate,
      ...share(l),
      CesAmt: 0,
      TotItemVal: round2(l.net + l.taxAmount),
    })),
    ValDtls: { AssVal: m.totals.net, CgstVal: m.totals.cgst, SgstVal: m.totals.sgst, IgstVal: m.totals.igst, CesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: round2(m.totals.total - m.totals.net - m.totals.tax), TotInvVal: m.totals.total },
  };
  const body = JSON.stringify(doc);
  return { scheme: 'in_irp', format: 'json', body, id: irn(m.seller.taxId ?? '', m.date, typ, m.number), hash: sha256hex(body) };
}

// ------------------------------------------------------------------ UBL 2.1 (Peppol PINT AE, ZATCA)

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
const amt = (n: number) => round2(n).toFixed(2);

/** Deterministic RFC 4122-shaped UUID from tenant + invoice, so retries produce the same document id. */
export function stableUuid(seed: string): string {
  const h = sha256hex(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Category S = standard rated, Z = zero rated. */
const category = (rate: number) => (rate > 0 ? 'S' : 'Z');

interface UblOptions {
  customizationId: string;
  profileId: string;
  uuid: string;
  invoiceTypeName?: string; // ZATCA transaction code
  extraRefs?: string; // AdditionalDocumentReference blocks
  sellerScheme?: string;
  sellerEndpoint?: string;
  buyerEndpoint?: string;
}

function ubl(m: InvoiceModel, o: UblOptions): string {
  const credit = m.kind === 'credit_note';
  const root = credit ? 'CreditNote' : 'Invoice';
  const lineTag = credit ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyTag = credit ? 'CreditedQuantity' : 'InvoicedQuantity';
  const rate = m.lines[0]?.taxRate ?? 0;
  const party = (p: InvoiceModel['seller'], endpoint?: string) => `
      <cac:Party>${endpoint ? `
        <cbc:EndpointID schemeID="${esc(o.sellerScheme ?? '0235')}">${esc(endpoint)}</cbc:EndpointID>` : ''}
        <cac:PostalAddress>
          ${p.line1 ? `<cbc:StreetName>${esc(p.line1)}</cbc:StreetName>` : ''}
          ${p.line2 ? `<cbc:AdditionalStreetName>${esc(p.line2)}</cbc:AdditionalStreetName>` : ''}
          ${p.city ? `<cbc:CityName>${esc(p.city)}</cbc:CityName>` : ''}
          ${p.postalCode ? `<cbc:PostalZone>${esc(p.postalCode)}</cbc:PostalZone>` : ''}
          ${p.stateCode ? `<cbc:CountrySubentity>${esc(p.stateCode)}</cbc:CountrySubentity>` : ''}
          <cac:Country><cbc:IdentificationCode>${esc(p.country)}</cbc:IdentificationCode></cac:Country>
        </cac:PostalAddress>${p.taxId ? `
        <cac:PartyTaxScheme>
          <cbc:CompanyID>${esc(p.taxId)}</cbc:CompanyID>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:PartyTaxScheme>` : ''}
        <cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName></cac:PartyLegalEntity>
      </cac:Party>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${esc(o.customizationId)}</cbc:CustomizationID>
  <cbc:ProfileID>${esc(o.profileId)}</cbc:ProfileID>
  <cbc:ID>${esc(m.number)}</cbc:ID>
  <cbc:UUID>${o.uuid}</cbc:UUID>
  <cbc:IssueDate>${m.date}</cbc:IssueDate>
  <cbc:IssueTime>${m.time}</cbc:IssueTime>
  <cbc:${root}TypeCode${o.invoiceTypeName ? ` name="${o.invoiceTypeName}"` : ''}>${credit ? '381' : '380'}</cbc:${root}TypeCode>
  <cbc:DocumentCurrencyCode>${esc(m.currency)}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${esc(m.currency)}</cbc:TaxCurrencyCode>${m.against ? `
  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${esc(m.against)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ''}${o.extraRefs ?? ''}
  <cac:AccountingSupplierParty>${party(m.seller, o.sellerEndpoint)}
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>${party(m.buyer, o.buyerEndpoint)}
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${esc(m.currency)}">${amt(m.totals.tax)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${esc(m.currency)}">${amt(m.totals.net)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${esc(m.currency)}">${amt(m.totals.tax)}</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>${category(rate)}</cbc:ID><cbc:Percent>${amt(rate)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${esc(m.currency)}">${amt(m.totals.net)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${esc(m.currency)}">${amt(m.totals.net)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${esc(m.currency)}">${amt(m.totals.net + m.totals.tax)}</cbc:TaxInclusiveAmount>
    <cbc:PayableRoundingAmount currencyID="${esc(m.currency)}">${amt(m.totals.total - m.totals.net - m.totals.tax)}</cbc:PayableRoundingAmount>
    <cbc:PayableAmount currencyID="${esc(m.currency)}">${amt(m.totals.total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${m.lines
    .map(
      (l) => `
  <cac:${lineTag}>
    <cbc:ID>${l.no}</cbc:ID>
    <cbc:${qtyTag} unitCode="${l.isService ? 'E48' : 'C62'}">${l.qty}</cbc:${qtyTag}>
    <cbc:LineExtensionAmount currencyID="${esc(m.currency)}">${amt(l.net)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${esc(m.currency)}">${amt(l.taxAmount)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="${esc(m.currency)}">${amt(l.net + l.taxAmount)}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${esc(l.description)}</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>${category(l.taxRate)}</cbc:ID><cbc:Percent>${amt(l.taxRate)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${esc(m.currency)}">${amt(l.unitPrice)}</cbc:PriceAmount></cac:Price>
  </cac:${lineTag}>`,
    )
    .join('')}
</${root}>
`;
}

// ------------------------------------------------------------------ UAE Peppol (PINT AE)

/** PINT AE identifiers; keep in sync with the FTA's published Peppol specification. */
export const PINT_AE = { customizationId: 'urn:peppol:pint:billing-1@ae-1', profileId: 'urn:peppol:bis:billing' } as const;

export function validatePeppol(m: InvoiceModel): ValidationIssue[] {
  const out = commonIssues(m);
  if (!m.seller.taxId || !isValidTrn(m.seller.taxId)) out.push({ field: 'seller.trn', message: 'Your TRN is missing or invalid (15 digits starting with 100)' });
  if (!m.buyer.taxId) out.push({ field: 'buyer.trn', message: 'Customer TRN is required to route the e-invoice on Peppol' });
  else if (!isValidTrn(m.buyer.taxId)) out.push({ field: 'buyer.trn', message: `Customer TRN ${m.buyer.taxId} is invalid` });
  if (m.totals.cgst || m.totals.sgst || m.totals.igst) out.push({ field: 'taxes', message: 'UAE invoices carry VAT, not GST' });
  const rate = m.totals.net > 0 ? (m.totals.vat / m.totals.net) * 100 : 0;
  if (m.totals.vat > 0 && !approxEqual(rate, 5, 0.1)) out.push({ field: 'taxes', message: `VAT is ${rate.toFixed(2)}% of the taxable amount; standard rate is 5%` });
  return out;
}

export function buildPeppol(m: InvoiceModel, tenantId: string, sellerPeppolId?: string): BuiltDocument {
  const uuid = stableUuid(`${tenantId}:${m.number}`);
  const body = ubl(m, {
    ...PINT_AE,
    uuid,
    sellerEndpoint: sellerPeppolId?.split(':').pop() ?? m.seller.taxId,
    sellerScheme: sellerPeppolId?.split(':')[0] ?? '0235',
    buyerEndpoint: m.buyer.taxId,
  });
  return { scheme: 'ae_peppol', format: 'xml', body, id: uuid, hash: sha256hex(body) };
}

// ------------------------------------------------------------------ KSA ZATCA

/** PIH of the very first invoice: base64 of the hex SHA-256 of "0" (per ZATCA spec). */
export const ZATCA_GENESIS_PIH = Buffer.from(sha256hex('0')).toString('base64');

export const isValidKsaVat = (v?: string) => !!v && /^3\d{13}3$/.test(v);

/** ZATCA QR: TLV (tag, length, UTF-8 value) concatenated and base64-encoded. */
export function zatcaTlv(fields: Array<[number, string]>): string {
  const parts = fields.map(([tag, value]) => {
    const v = Buffer.from(value, 'utf8');
    if (v.length > 255) throw new Error(`TLV value for tag ${tag} too long`);
    return Buffer.concat([Buffer.from([tag, v.length]), v]);
  });
  return Buffer.concat(parts).toString('base64');
}

export function decodeTlv(b64: string): Record<number, string> {
  const buf = Buffer.from(b64, 'base64');
  const out: Record<number, string> = {};
  for (let i = 0; i < buf.length; ) {
    const tag = buf[i]!;
    const len = buf[i + 1]!;
    out[tag] = buf.subarray(i + 2, i + 2 + len).toString('utf8');
    i += 2 + len;
  }
  return out;
}

export function validateZatca(m: InvoiceModel): ValidationIssue[] {
  const out = commonIssues(m);
  if (!isValidKsaVat(m.seller.taxId)) out.push({ field: 'seller.vat', message: 'Seller VAT number must be 15 digits starting and ending with 3' });
  if (m.buyer.taxId && !isValidKsaVat(m.buyer.taxId)) out.push({ field: 'buyer.vat', message: `Buyer VAT number ${m.buyer.taxId} is invalid` });
  const rate = m.totals.net > 0 ? (m.totals.vat / m.totals.net) * 100 : 0;
  if (m.totals.vat > 0 && !approxEqual(rate, 15, 0.1)) out.push({ field: 'taxes', message: `VAT is ${rate.toFixed(2)}% of the taxable amount; KSA standard rate is 15%` });
  return out;
}

export function buildZatca(m: InvoiceModel, tenantId: string, chain: { counter: number; prevHash?: string }): BuiltDocument {
  const uuid = stableUuid(`${tenantId}:${m.number}`);
  const pih = chain.prevHash ?? ZATCA_GENESIS_PIH;
  const simplified = !m.buyer.taxId; // B2C
  const refs = `
  <cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>${chain.counter}</cbc:UUID></cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${pih}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>`;
  const body = ubl(m, { customizationId: 'urn:zatca:fatoora', profileId: 'reporting:1.0', uuid, invoiceTypeName: simplified ? '0200000' : '0100000', extraRefs: refs });
  const hash = sha256b64(body);
  const qr = zatcaTlv([
    [1, m.seller.name],
    [2, m.seller.taxId ?? ''],
    [3, `${m.date}T${m.time}Z`],
    [4, amt(m.totals.total)],
    [5, amt(m.totals.vat)],
    [6, hash],
  ]);
  return { scheme: 'sa_zatca', format: 'xml', body, id: uuid, hash, qr, counter: chain.counter, prevHash: pih };
}

export function validate(scheme: EInvoiceScheme, m: InvoiceModel): ValidationIssue[] {
  return scheme === 'in_irp' ? validateIrp(m) : scheme === 'ae_peppol' ? validatePeppol(m) : validateZatca(m);
}
