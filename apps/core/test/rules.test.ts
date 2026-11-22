import { describe, expect, it } from 'vitest';
import { parseIntent } from '../src/ai/anthropic.js';
import { parseDate, ruleClassify } from '../src/ai/rules.js';

describe('creating accounts and everyday phrasing', () => {
  it('understands everyday ways of asking for a customer, supplier or ledger account', () => {
    const r = (text: string) => ruleClassify(text);
    expect(r('Create supplier account AM Motors')).toMatchObject({ intent: 'add_party', entities: { kind: 'supplier', party: 'AM Motors' } });
    expect(r('add customer ravi traders')).toMatchObject({ intent: 'add_party', entities: { kind: 'customer', party: 'Ravi Traders' } });
    expect(r('new vendor: AM Motors')).toMatchObject({ intent: 'add_party', entities: { kind: 'supplier', party: 'AM Motors' } });
    expect(r('please add AM Motors as a supplier')).toMatchObject({ intent: 'add_party', entities: { kind: 'supplier', party: 'AM Motors' } });
    expect(r('Al Noor Trading is a new customer')).toMatchObject({ intent: 'add_party', entities: { kind: 'customer', party: 'Al Noor Trading' } });
    expect(r('create a new client named "Shop 24"')).toMatchObject({ intent: 'add_party', entities: { kind: 'customer', party: 'Shop 24' } });
    expect(r('create account for AM Motors')).toMatchObject({ intent: 'add_party', entities: { party: 'AM Motors' } });
    expect(r('create account for AM Motors')!.entities.kind).toBeUndefined();
    expect(r('add party Ravi')).toMatchObject({ intent: 'add_party', entities: { party: 'Ravi' } });
    expect(r('add a supplier')).toMatchObject({ intent: 'add_party', entities: { kind: 'supplier' } });
    expect(r('create expense account Fuel')).toMatchObject({ intent: 'add_account', entities: { kind: 'expense', accountName: 'Fuel' } });
    expect(r('open bank account HDFC Current')).toMatchObject({ intent: 'add_account', entities: { kind: 'bank', accountName: 'HDFC Current' } });
    expect(r('new income ledger Commission')).toMatchObject({ intent: 'add_account', entities: { kind: 'income', accountName: 'Commission' } });
    expect(r('Create Capital account Hussain')).toMatchObject({ intent: 'add_account', entities: { kind: 'capital', accountName: 'Hussain' } });
    expect(r('open bank loan account HDFC OD')).toMatchObject({ intent: 'add_account', entities: { kind: 'loan', accountName: 'HDFC OD' } });
    expect(r('create fixed asset account Delivery Van')).toMatchObject({ intent: 'add_account', entities: { kind: 'fixed_asset' } });
    expect(r('create loans and advances account Staff Advance')).toMatchObject({ intent: 'add_account', entities: { kind: 'loan_advance' } });
    expect(r('add GST payable ledger')).toMatchObject({ intent: 'add_account', entities: { kind: 'tax' } });
    expect(r('create sales account Online Sales')).toMatchObject({ intent: 'add_account', entities: { kind: 'direct_income' } });
    expect(r('create ledger Office Deposit in current assets group')).toMatchObject({ intent: 'add_account', entities: { group: 'Current Assets', accountName: 'Office Deposit' } });
    expect(r('create account Hussain Drawings under Capital Account')).toMatchObject({ intent: 'add_account', entities: { group: 'Capital Account', accountName: 'Hussain Drawings' } });
    // money messages are not mistaken for account creation
    expect(r('add advance 5000 to Ravi')?.intent).not.toBe('add_account');
    expect(r('add cash 2000')?.intent).not.toBe('add_account');
    expect(r('add expense 500 for tea')?.intent).not.toBe('add_account');
    expect(r('paid 500 to AM Motors')!.intent).toBe('payment_out');
  });

  it('understands common ways of saying money came in or went out', () => {
    expect(ruleClassify('received 5000 from Ravi Traders by upi')).toMatchObject({ intent: 'payment_in', entities: { amount: 5000, party: 'Ravi Traders', paymentMode: 'upi' } });
    expect(ruleClassify('got 2k from shop 24')).toMatchObject({ intent: 'payment_in', entities: { amount: 2000, party: 'Shop 24' } });
    expect(ruleClassify('Anil gave 1500')).toMatchObject({ intent: 'payment_in', entities: { amount: 1500, party: 'Anil' } });
    expect(ruleClassify('gave 800 to Suresh')).toMatchObject({ intent: 'payment_out', entities: { amount: 800, party: 'Suresh' } });
    expect(ruleClassify('gave 300 for auto fare')).toMatchObject({ intent: 'record_expense', entities: { amount: 300, description: 'auto fare' } });
    expect(ruleClassify('sold to Ravi for 5000')).toMatchObject({ intent: 'record_sale', entities: { amount: 5000, party: 'Ravi' } });
  });

  it('accepts AI replies that fill unused fields with empty values', () => {
    const out = parseIntent(JSON.stringify({ intent: 'add_party', confidence: 0.9, entities: { amount: 0, currency: '', party: 'AM Motors', description: '', date: '', paymentMode: '', report: '', question: '', kind: 'supplier', accountName: '' } }));
    expect(out).toEqual({ intent: 'add_party', confidence: 0.9, entities: { party: 'AM Motors', kind: 'supplier' } });
  });
});

describe('every everyday ERPNext transaction from a WhatsApp message', () => {
  const r = (text: string) => ruleClassify(text);

  it('money in: names may start with digits ("4L Fashion" is a name, not 4 lakh)', () => {
    expect(r('Received Rs 6300 from 4L fashion')).toMatchObject({ intent: 'payment_in', entities: { amount: 6300, currency: 'INR', party: '4L fashion' } });
    expect(r('received from 4L fashion 6300')).toMatchObject({ intent: 'payment_in', entities: { amount: 6300, party: '4L fashion' } });
    expect(r('6300 received from 4L Fashion')).toMatchObject({ intent: 'payment_in', entities: { amount: 6300, party: '4L Fashion' } });
    expect(r('4L Fashion paid 6300')).toMatchObject({ intent: 'payment_in', entities: { amount: 6300, party: '4L Fashion' } });
    expect(r('payment from 4L fashion rs 6300 by gpay')).toMatchObject({ intent: 'payment_in', entities: { amount: 6300, party: '4L fashion', paymentMode: 'upi' } });
    expect(r('received 6300 cash from 4L fashion')).toMatchObject({ intent: 'payment_in', entities: { amount: 6300, party: '4L fashion', paymentMode: 'cash' } });
    expect(r('credited 6300 by 24 Seven Mart')).toMatchObject({ intent: 'payment_in', entities: { amount: 6300, party: '24 Seven Mart' } });
    expect(r('received 5000 from ravi against invoice 12')).toMatchObject({ intent: 'payment_in', entities: { amount: 5000, party: 'Ravi', description: 'invoice 12' } });
    expect(r('received 50000 from Hussain as capital')).toMatchObject({ intent: 'payment_in', entities: { amount: 50000, party: 'Hussain', description: 'capital' } });
    expect(r('deposit 5000 from Ravi')).toMatchObject({ intent: 'payment_in', entities: { amount: 5000, party: 'Ravi' } });
    expect(r('received 4l from Ravi')).toMatchObject({ intent: 'payment_in', entities: { amount: 400000, party: 'Ravi' } });
  });

  it('money out: supplier payments, and salary/rent paid to a person as an expense', () => {
    expect(r('5000 paid to AM Motors by bank')).toMatchObject({ intent: 'payment_out', entities: { amount: 5000, party: 'AM Motors', paymentMode: 'bank' } });
    expect(r('payment to 4L fashion 3000')).toMatchObject({ intent: 'payment_out', entities: { amount: 3000, party: '4L fashion' } });
    expect(r('advance 2000 to Ravi')).toMatchObject({ intent: 'payment_out', entities: { amount: 2000, party: 'Ravi' } });
    expect(r('paid salary 25000 to Ajith')).toMatchObject({ intent: 'record_expense', entities: { amount: 25000, description: 'salary – Ajith' } });
    expect(r('rent paid 15000')).toMatchObject({ intent: 'record_expense', entities: { amount: 15000, description: 'rent' } });
    expect(r('petrol 500')).toMatchObject({ intent: 'record_expense', entities: { amount: 500, description: 'petrol' } });
    expect(r('electricity bill 3200')).toMatchObject({ intent: 'record_expense', entities: { amount: 3200 } });
    expect(r('paid 300 for 2 teas')!.entities.amount).toBe(300);
  });

  it('sales and purchases (Sales Invoice / Purchase Invoice)', () => {
    expect(r('sold goods worth 5000 to 4L Fashion on credit')).toMatchObject({ intent: 'record_sale', entities: { amount: 5000, party: '4L Fashion', paymentMode: 'credit' } });
    expect(r('sold 5 shirts for 2000 to Ravi')).toMatchObject({ intent: 'record_sale', entities: { amount: 2000, party: 'Ravi' } });
    expect(r('bill 3500 for Anil')).toMatchObject({ intent: 'record_sale', entities: { amount: 3500, party: 'Anil' } });
    expect(r('invoice Ravi 5000')).toMatchObject({ intent: 'record_sale', entities: { amount: 5000, party: 'Ravi' } });
    expect(r('Ravi bought goods worth 5000')).toMatchObject({ intent: 'record_sale', entities: { amount: 5000, party: 'Ravi' } });
    expect(r('cash sale 3000')).toMatchObject({ intent: 'record_sale', entities: { amount: 3000, paymentMode: 'cash' } });
    expect(r('bought cement for 12000 from AM Motors')).toMatchObject({ intent: 'record_purchase', entities: { amount: 12000, party: 'AM Motors', description: 'cement' } });
    expect(r('bought 2 tyres for 8000 from AM Motors by cash')).toMatchObject({ intent: 'record_purchase', entities: { amount: 8000, party: 'AM Motors', paymentMode: 'cash' } });
    expect(r('purchased 12000 from AM Motors')).toMatchObject({ intent: 'record_purchase', entities: { amount: 12000, party: 'AM Motors' } });
    expect(r('goods received from AM Motors 12000')).toMatchObject({ intent: 'record_purchase', entities: { amount: 12000, party: 'AM Motors' } });
    expect(r('purchase bill from 4L fashion 9000')).toMatchObject({ intent: 'record_purchase', entities: { amount: 9000, party: '4L fashion' } });
  });

  it('returns: credit notes and debit notes', () => {
    expect(r('Ravi returned goods worth 1500')).toMatchObject({ intent: 'sales_return', entities: { amount: 1500, party: 'Ravi' } });
    expect(r('sales return 1500 from Ravi')).toMatchObject({ intent: 'sales_return', entities: { amount: 1500, party: 'Ravi' } });
    expect(r('credit note 1500 to 4L Fashion')).toMatchObject({ intent: 'sales_return', entities: { amount: 1500, party: '4L Fashion' } });
    expect(r('goods returned by Ravi 1500')).toMatchObject({ intent: 'sales_return', entities: { amount: 1500, party: 'Ravi' } });
    expect(r('returned goods 1500 to AM Motors')).toMatchObject({ intent: 'purchase_return', entities: { amount: 1500, party: 'AM Motors' } });
    expect(r('purchase return 2000 AM Motors')).toMatchObject({ intent: 'purchase_return', entities: { amount: 2000, party: 'AM Motors' } });
    expect(r('debit note 2000 to AM Motors')).toMatchObject({ intent: 'purchase_return', entities: { amount: 2000, party: 'AM Motors' } });
  });

  it('cash ↔ bank transfers (Contra Entry)', () => {
    expect(r('deposited 10000 cash in bank')).toMatchObject({ intent: 'transfer', entities: { amount: 10000, description: 'deposit' } });
    expect(r('cash deposit 10000')).toMatchObject({ intent: 'transfer', entities: { amount: 10000, description: 'deposit' } });
    expect(r('put 20000 in HDFC bank')).toMatchObject({ intent: 'transfer', entities: { amount: 20000, description: 'deposit' } });
    expect(r('withdrew 5000 from bank')).toMatchObject({ intent: 'transfer', entities: { amount: 5000, description: 'withdrawal' } });
    expect(r('atm withdrawal 2000')).toMatchObject({ intent: 'transfer', entities: { amount: 2000, description: 'withdrawal' } });
    expect(r('transferred 5000 from bank to cash')).toMatchObject({ intent: 'transfer', entities: { amount: 5000, description: 'withdrawal' } });
    expect(r('withdrew 5000 from bank for personal use')?.intent).not.toBe('transfer'); // drawings, not a transfer
  });
});

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
