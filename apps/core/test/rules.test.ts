import { describe, expect, it } from 'vitest';
import { ruleClassify } from '../src/ai/rules.js';

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
});
