import type { PlanCode, PlanLimits } from '@nextai/shared';

/**
 * Plans as published on nextaierp.com (UAE monthly pricing: Base AED 99 / 1 user, Growth AED 299 /
 * 4 users, Pro AED 599 / 10 users). INR prices are placeholders until India pricing is confirmed.
 */
export const DEFAULT_PLANS: Array<{ code: PlanCode; name: string; priceMonthly: Record<string, number>; limits: PlanLimits }> = [
  {
    code: 'base',
    name: 'Base',
    priceMonthly: { AED: 99, INR: 999 },
    limits: { users: 1, ocrPagesPerMonth: 100, invoicesSentPerMonth: 50, messagesPerMonth: 1000, features: [] },
  },
  {
    code: 'growth',
    name: 'Growth',
    priceMonthly: { AED: 299, INR: 2499 },
    limits: { users: 4, ocrPagesPerMonth: 500, invoicesSentPerMonth: 300, messagesPerMonth: 5000, features: ['tax_centre', 'ask_books'] },
  },
  {
    code: 'pro',
    name: 'Pro',
    priceMonthly: { AED: 599, INR: 5999 },
    limits: {
      users: 10,
      ocrPagesPerMonth: 2000,
      invoicesSentPerMonth: 2000,
      messagesPerMonth: 20000,
      features: ['tax_centre', 'ask_books', 'multi_currency', 'api_access'],
    },
  },
];

export const DEFAULT_TEMPLATES = [
  { key: 'otp', name: 'nextai_otp', language: 'en', params: ['code'], category: 'AUTHENTICATION' },
  { key: 'invoice', name: 'nextai_invoice', language: 'en', params: ['party', 'business', 'invoice_no', 'amount', 'due_date'], category: 'UTILITY' },
  { key: 'receipt', name: 'nextai_receipt', language: 'en', params: ['party', 'business', 'amount', 'ref'], category: 'UTILITY' },
  { key: 'reminder', name: 'nextai_payment_reminder', language: 'en', params: ['party', 'business', 'amount', 'invoice_no', 'due_date'], category: 'UTILITY' },
  { key: 'daily_summary', name: 'nextai_daily_summary', language: 'en', params: ['sales', 'expenses', 'cash', 'pending'], category: 'UTILITY' },
  { key: 'billing_notice', name: 'nextai_billing_notice', language: 'en', params: ['business', 'link'], category: 'UTILITY' },
  { key: 'draft_review', name: 'nextai_draft_ready', language: 'en', params: ['summary'], category: 'UTILITY' },
];
