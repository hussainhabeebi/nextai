import type { PlanLimits } from '@nextai/shared';

export const DEFAULT_PLANS: Array<{ code: 'starter' | 'business' | 'pro'; name: string; priceMonthly: Record<string, number>; limits: PlanLimits }> = [
  {
    code: 'starter',
    name: 'Starter',
    priceMonthly: { INR: 999, AED: 49 },
    limits: { users: 2, ocrPagesPerMonth: 100, invoicesSentPerMonth: 50, messagesPerMonth: 1000, features: [] },
  },
  {
    code: 'business',
    name: 'Business',
    priceMonthly: { INR: 2499, AED: 129 },
    limits: { users: 5, ocrPagesPerMonth: 500, invoicesSentPerMonth: 300, messagesPerMonth: 5000, features: ['tax_centre', 'ask_books'] },
  },
  {
    code: 'pro',
    name: 'Pro',
    priceMonthly: { INR: 5999, AED: 299 },
    limits: {
      users: 15,
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
