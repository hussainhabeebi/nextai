import { describe, expect, it } from 'vitest';
import { formatCompact, formatMoney, isValidGstin, isValidTrn, normalizePhone, t, maskPhone } from './index.js';

describe('shared', () => {
  it('formats INR with lakh grouping', () => {
    expect(formatMoney(1234567.5, 'INR')).toContain('12,34,567.50');
    expect(formatCompact(1500000, 'INR')).toBe('₹15 L');
    expect(formatCompact(25000000, 'INR')).toBe('₹2.5 Cr');
    expect(formatCompact(2500, 'AED')).toBe('AED 2.5K');
  });
  it('validates GSTIN checksum and TRN', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZA')).toBe(false);
    expect(isValidTrn('100123456789012')).toBe(true);
    expect(isValidTrn('200123456789012')).toBe(false);
  });
  it('normalizes and masks phones', () => {
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('0501234567', 'AE')).toBe('+971501234567');
    expect(normalizePhone('+971 50 123 4567')).toBe('+971501234567');
    expect(maskPhone('+919876543210')).toBe('+9198******10');
  });
  it('translates with fallback and interpolation', () => {
    expect(t('en', 'bot.confirmed', { ref: 'PINV-1' })).toBe('Posted ✅ PINV-1');
    expect(t('ml', 'bot.help')).toContain('Send a bill');
    expect(t('ar', 'bot.confirmed', { ref: 'X' })).toContain('X');
  });
});
