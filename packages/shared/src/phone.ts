/** Normalize a phone number to E.164-ish digits with leading +. Defaults to India if 10 digits. */
export function normalizePhone(raw: string, defaultCountry: 'IN' | 'AE' = 'IN'): string {
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);
  if (digits.startsWith('+')) return '+' + digits.slice(1).replace(/\D/g, '');
  digits = digits.replace(/^0+/, '');
  if (defaultCountry === 'IN' && digits.length === 10) return '+91' + digits;
  if (defaultCountry === 'AE' && digits.length === 9) return '+971' + digits;
  return '+' + digits;
}

/** Mask a phone for logs: +9198******21 */
export function maskPhone(phone: string): string {
  if (phone.length < 6) return '***';
  return phone.slice(0, 5) + '*'.repeat(Math.max(0, phone.length - 7)) + phone.slice(-2);
}
