import { tenantSettingsSchema } from '@nextai/shared';
import { describe, expect, it } from 'vitest';
import { findLedger, guessExpenseAccount, matchExpenseRule, moneyAccount, toErpDoc, type ErpContext } from '../src/modules/erpnext/mappers.js';

const ctx = (accounts: Record<string, string> = {}, defaultBankAccount?: string): ErpContext => ({
  company: 'Aiingo Technologies India LLP',
  abbr: 'ATL',
  country: 'IN',
  settings: tenantSettingsSchema.parse({ accounts, defaultBankAccount }),
});

describe('money accounts: cash unless a bank-type mode is mentioned', () => {
  it('defaults to cash', () => {
    expect(moneyAccount(ctx(), undefined)).toMatchObject({ account: 'Cash - ATL', voucherType: 'Cash Entry', kind: 'cash' });
    expect(moneyAccount(ctx(), 'unknown').kind).toBe('cash');
  });
  it('uses the bank for bank, UPI, transfer, cheque', () => {
    for (const m of ['bank', 'upi', 'transfer', 'cheque', 'neft']) expect(moneyAccount(ctx({}, 'HDFC - ATL'), m)).toMatchObject({ account: 'HDFC - ATL', kind: 'bank' });
  });
  it('a card uses the card account when set, otherwise cash (not the bank)', () => {
    expect(moneyAccount(ctx({}, 'HDFC - ATL'), 'card')).toMatchObject({ account: 'Cash - ATL', kind: 'cash' });
    expect(moneyAccount(ctx({ card: 'HDFC Credit Card - ATL' }), 'card')).toMatchObject({ account: 'HDFC Credit Card - ATL', voucherType: 'Credit Card Entry', modeOfPayment: 'Credit Card', kind: 'card' });
  });
  it('a card expense journal credits the card account', () => {
    const je = toErpDoc('journal_entry', { date: '2026-11-15', currency: 'INR', total: 1876.73, paymentMode: 'card', lines: [], validationIssues: [] }, ctx({ card: 'HDFC Credit Card - ATL' }));
    expect(je).toMatchObject({ voucher_type: 'Credit Card Entry' });
    expect((je.accounts as Array<{ account: string }>)[1]!.account).toBe('HDFC Credit Card - ATL');
  });
});

describe('expense account from the real chart, not always Miscellaneous', () => {
  const ledgers = ['Entertainment Expenses - ATL', 'Miscellaneous Expenses - ATL', 'Office Rent - ATL', 'Software Subscriptions - ATL', 'Telephone Expenses - ATL', 'Travel Expenses - ATL'];
  it('keyword rules pick an existing ledger, preferring specific custom ones', () => {
    expect(matchExpenseRule(ctx(), 'google gemini api charges', ledgers)).toEqual({ account: 'Software Subscriptions - ATL' });
    expect(matchExpenseRule(ctx(), 'airtel broadband', ledgers)).toEqual({ account: 'Telephone Expenses - ATL' });
    expect(matchExpenseRule(ctx(), 'office rent november', ledgers)).toEqual({ account: 'Office Rent - ATL' });
    // whole words only
    expect(matchExpenseRule(ctx(), 'team outing', ledgers)).toBeUndefined(); // not "tea"
    expect(matchExpenseRule(ctx(), 'business cards', ledgers)).toBeUndefined(); // not "bus"
    expect(matchExpenseRule(ctx(), 'flights to dubai', ledgers)).toEqual({ account: 'Travel Expenses - ATL' }); // plural ok
  });
  it('without a matching ledger the rule falls through (to the AI pick, then Miscellaneous)', () => {
    expect(matchExpenseRule(ctx(), 'google gemini api charges', ['Miscellaneous Expenses - ATL'])).toBeUndefined();
    expect(guessExpenseAccount(ctx(), 'something odd', ledgers)).toBe('Miscellaneous Expenses - ATL');
  });
  it('finds what the owner typed in an edit ("account software")', () => {
    expect(findLedger('software', ledgers)).toBe('Software Subscriptions - ATL');
    expect(findLedger('Office Rent', ledgers)).toBe('Office Rent - ATL');
    expect(findLedger('travel', ledgers)).toBe('Travel Expenses - ATL');
    expect(findLedger('yacht', ledgers)).toBeUndefined();
  });
});

describe('returns and cash ↔ bank transfers', () => {
  const base = { date: '2026-11-18', currency: 'INR' as const, validationIssues: [] };
  it('a sales return is a credit note: Sales Invoice with is_return and negative quantity', () => {
    const doc = toErpDoc('sales_invoice', { ...base, partyName: 'Ravi', isReturn: true, total: 1500, lines: [{ description: 'Goods returned', qty: 1, rate: 1500, amount: 1500 }] }, ctx());
    expect(doc).toMatchObject({ doctype: 'Sales Invoice', customer: 'Ravi', is_return: 1 });
    expect((doc.items as Array<Record<string, unknown>>)[0]).toMatchObject({ qty: -1, rate: 1500 });
  });
  it('a purchase return is a debit note and never marked paid', () => {
    const doc = toErpDoc('purchase_invoice', { ...base, partyName: 'AM Motors', isReturn: true, paymentMode: 'cash', total: 800, lines: [{ description: 'Goods returned', qty: 1, rate: 800, amount: 800 }] }, ctx());
    expect(doc).toMatchObject({ doctype: 'Purchase Invoice', supplier: 'AM Motors', is_return: 1 });
    expect(doc.is_paid).toBeUndefined();
    expect((doc.items as Array<Record<string, unknown>>)[0]).toMatchObject({ qty: -1 });
  });
  it('a cash deposit is a Contra Entry: bank debited, cash credited', () => {
    const doc = toErpDoc('journal_entry', { ...base, lines: [], total: 10000, direction: 'out', voucherType: 'Contra Entry', expenseAccount: 'Bank Account - ATL', paymentMode: 'cash' }, ctx());
    expect(doc).toMatchObject({ voucher_type: 'Contra Entry' });
    expect(doc.cheque_no).toBeTruthy();
    expect(doc.accounts).toEqual([
      { account: 'Bank Account - ATL', debit_in_account_currency: 10000, credit_in_account_currency: 0 },
      { account: 'Cash - ATL', debit_in_account_currency: 0, credit_in_account_currency: 10000 },
    ]);
  });
});
