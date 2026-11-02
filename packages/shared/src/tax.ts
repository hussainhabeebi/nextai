/** GSTIN: 2 digit state + 10 char PAN + entity + Z + checksum */
export const GSTIN_REGEX = /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
/** UAE TRN: 15 digits, starts with 100 */
export const TRN_REGEX = /^100\d{12}$/;

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function isValidGstin(gstin: string): boolean {
  const g = gstin.toUpperCase().trim();
  if (!GSTIN_REGEX.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(g[i]!);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  const check = (36 - (sum % 36)) % 36;
  return GSTIN_CHARS[check] === g[14];
}

export function isValidTrn(trn: string): boolean {
  return TRN_REGEX.test(trn.replace(/\s/g, ''));
}

export function isValidTaxId(taxId: string, country: 'IN' | 'AE'): boolean {
  return country === 'IN' ? isValidGstin(taxId) : isValidTrn(taxId);
}

/** GST state code from GSTIN (first 2 digits). */
export const gstStateCode = (gstin: string): string => gstin.slice(0, 2);
