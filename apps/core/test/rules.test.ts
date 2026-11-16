import { describe, expect, it } from 'vitest';
import { parseDate, ruleClassify } from '../src/ai/rules.js';

describe('ruleClassify', () => {
  it('does not read currency hints inside words', () => {
    expect(ruleClassify('sold 5000 to Ravi Traders')!.entities.currency).toBeUndefined(); // "tradeRS"
    expect(ruleClassify('Siddharth paid 2000')!.entities.currency).toBeUndefined(); // "siDDHarth"
    expect(ruleClassify('paid rs 500 for tea')!.entities.currency).toBe('INR');
    expect(ruleClassify('paid ₹500 for tea')!.entities.currency).toBe('INR');
    expect(ruleClassify('paid 500 aed for tea')!.entities.currency).toBe('AED');
  });

  it('extracts the payment mode and keeps it out of party names', () => {
    const out = ruleClassify('paid 1000 to Gulf Office Supplies by bank')!;
    expect(out).toMatchObject({ intent: 'payment_out', entities: { amount: 1000, party: 'Gulf Office Supplies', paymentMode: 'bank' } });
    expect(ruleClassify('paid 1200 for rent via upi')!.entities).toMatchObject({ paymentMode: 'upi', description: 'rent' });
    expect(ruleClassify('Ravi paid 2000 by cash')!.entities).toMatchObject({ party: 'Ravi', paymentMode: 'cash', amount: 2000 });
    expect(ruleClassify('paid 300 on petrol')!.entities.paymentMode).toBeUndefined();
  });

  it('takes the amount after the verb, not a number inside a name', () => {
    expect(ruleClassify('Shop 24 paid 2000')!.entities).toMatchObject({ amount: 2000, party: 'Shop 24' });
    expect(ruleClassify('sold 5000 to Al Noor 2 Trading')!.entities).toMatchObject({ amount: 5000 });
    expect(ruleClassify('paid 1,250.50 for stationery')!.entities.amount).toBe(1250.5);
    expect(ruleClassify('sold 5k to Ravi')!.entities.amount).toBe(5000);
  });

  it('reads a real WhatsApp message: suffixed currency, "from credit card", written date', () => {
    const out = ruleClassify('paid 20USD for Google Gemini API Charges from Credit Card\ndate : 15/11/2026')!;
    expect(out.intent).toBe('record_expense');
    expect(out.entities).toMatchObject({ amount: 20, currency: 'USD', paymentMode: 'card', date: '2026-11-15', description: 'google gemini api charges' });
  });

  it('keeps k/lakh as multipliers only as their own word', () => {
    expect(ruleClassify('sold 5000 loaves to Ravi')!.entities.amount).toBe(5000);
    expect(ruleClassify('sold 2 lakh to Ravi')!.entities.amount).toBe(200000);
    expect(ruleClassify('paid rs500 for tea')!.entities).toMatchObject({ amount: 500, currency: 'INR' });
    expect(ruleClassify('paid $15 for domain')!.entities).toMatchObject({ amount: 15, currency: 'USD' });
    expect(ruleClassify('paid 500 for rsvp cards')!.entities.currency).toBeUndefined(); // "rs" + any char is not rupees
  });

  it('parses day-first dates and rejects impossible ones', () => {
    expect(parseDate('15/11/2026')).toBe('2026-11-15');
    expect(parseDate('5-1-26')).toBe('2026-01-05');
    expect(parseDate('2026-11-15')).toBe('2026-11-15');
    expect(parseDate('31/02/2026')).toBeUndefined();
    expect(parseDate('yesterday', new Date('2026-11-16T10:00:00Z'))).toBe('2026-11-15');
    expect(ruleClassify('paid 300 on petrol yesterday')!.entities.description).toBe('petrol');
  });
});
