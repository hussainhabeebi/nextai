import type { PlanCode, PlanLimits } from '@nextai/shared';

/**
 * Plans as published on nextaierp.com, per month: Base AED 99 / ₹799 (1 user), Growth AED 299 / ₹1,999
 * (4 users), Pro AED 599 / ₹4,999 (10 users). INR prices exclude 18% GST. Keep apps/landing/src/config.ts in step.
 *
 * These are the values for a NEW database only: the seed never overwrites an existing plan, so edits made in
 * Admin → Plans survive redeploys. Change live plans in Admin → Plans (or with a data migration).
 * `ocrPagesPerMonth` is the bill-entry limit: one per bill photo (one per page for PDFs).
 */
export const DEFAULT_PLANS: Array<{ code: PlanCode; name: string; priceMonthly: Record<string, number>; limits: PlanLimits }> = [
  {
    code: 'base',
    name: 'Base',
    priceMonthly: { AED: 99, INR: 799 },
    limits: { users: 1, ocrPagesPerMonth: 200, invoicesSentPerMonth: 50, messagesPerMonth: 1000, features: ['e_invoicing'] },
  },
  {
    code: 'growth',
    name: 'Growth',
    priceMonthly: { AED: 299, INR: 1999 },
    limits: { users: 4, ocrPagesPerMonth: 1000, invoicesSentPerMonth: 300, messagesPerMonth: 5000, features: ['tax_centre', 'ask_books', 'e_invoicing', 'cash_forecast'] },
  },
  {
    code: 'pro',
    name: 'Pro',
    priceMonthly: { AED: 599, INR: 4999 },
    limits: {
      users: 10,
      ocrPagesPerMonth: 5000,
      invoicesSentPerMonth: 2000,
      messagesPerMonth: 20000,
      features: ['tax_centre', 'ask_books', 'multi_currency', 'api_access', 'e_invoicing', 'cash_forecast', 'audit_copilot'],
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
  // New templates: create them in Meta with these names and parameters, then mark them approved in Admin → Templates.
  // Until then messages use the approved template above (and include the link whenever plain text is allowed).
  { key: 'invoice_pay', name: 'nextai_invoice_pay', language: 'en', params: ['party', 'business', 'invoice_no', 'amount', 'due_date', 'pay_link'], category: 'UTILITY', approved: false },
  { key: 'reminder_pay', name: 'nextai_payment_reminder_pay', language: 'en', params: ['party', 'business', 'amount', 'invoice_no', 'due_date', 'pay_link'], category: 'UTILITY', approved: false },
  { key: 'staff_invite', name: 'nextai_staff_invite', language: 'en', params: ['name', 'business', 'app_link'], category: 'UTILITY', approved: false },
  { key: 'tax_deadline', name: 'nextai_tax_deadline', language: 'en', params: ['business', 'what', 'due_date', 'days_left'], category: 'UTILITY', approved: false },
];
