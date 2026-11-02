import { approxEqual, isValidGstin, isValidTrn, round2, type Extraction } from '@nextai/shared';

export interface ValidationResult {
  issues: string[];
  /** hard issues force human review */
  hard: boolean;
}

/** Math, tax-id format, date sanity and GST split checks on an OCR extraction. */
export function validateExtraction(x: Extraction, country: 'IN' | 'AE', today = new Date()): ValidationResult {
  const issues: string[] = [];
  let hard = false;
  const taxTotal = round2(x.tax.cgst + x.tax.sgst + x.tax.igst + x.tax.vat);

  if (x.total === null || x.total <= 0) {
    issues.push('Total amount not found');
    hard = true;
  }
  if (x.lines.length > 0 && x.subtotal !== null) {
    const sum = round2(x.lines.reduce((s, l) => s + l.amount, 0));
    if (!approxEqual(sum, x.subtotal, Math.max(1, x.subtotal * 0.01))) issues.push(`Line items (${sum}) do not add up to subtotal (${x.subtotal})`);
    for (const l of x.lines) {
      if (!approxEqual(round2(l.qty * l.rate), l.amount, Math.max(1, l.amount * 0.01))) {
        issues.push(`Line "${l.description.slice(0, 30)}": qty × rate ≠ amount`);
        break;
      }
    }
  }
  if (x.subtotal !== null && x.total !== null && !approxEqual(round2(x.subtotal + taxTotal), x.total, Math.max(1, x.total * 0.01))) {
    issues.push(`Subtotal + tax (${round2(x.subtotal + taxTotal)}) ≠ total (${x.total})`);
    hard = true;
  }
  if (x.supplierTaxId) {
    const id = x.supplierTaxId.replace(/\s/g, '').toUpperCase();
    const ok = country === 'IN' ? isValidGstin(id) : isValidTrn(id);
    if (!ok) {
      issues.push(`${country === 'IN' ? 'GSTIN' : 'TRN'} "${x.supplierTaxId}" looks invalid`);
      hard = true;
    }
  }
  if (country === 'IN') {
    if (x.tax.igst > 0 && (x.tax.cgst > 0 || x.tax.sgst > 0)) {
      issues.push('Both IGST and CGST/SGST present');
      hard = true;
    }
    if (!approxEqual(x.tax.cgst, x.tax.sgst, 0.5)) issues.push('CGST and SGST differ');
    if (taxTotal > 0 && !x.supplierTaxId) issues.push('GST charged but supplier GSTIN missing (no input credit)');
  }
  if (country === 'AE' && x.tax.vat > 0 && x.subtotal && !approxEqual(x.tax.vat, x.subtotal * 0.05, Math.max(1, x.subtotal * 0.005))) {
    issues.push('VAT is not 5% of subtotal');
  }
  if (!x.date) {
    issues.push('Invoice date not found');
  } else {
    const d = new Date(`${x.date}T00:00:00Z`);
    const days = (today.getTime() - d.getTime()) / 86400_000;
    if (Number.isNaN(d.getTime()) || days < -1) {
      issues.push('Invoice date is in the future');
      hard = true;
    } else if (days > 365) issues.push('Invoice is more than a year old');
  }
  return { issues, hard };
}
