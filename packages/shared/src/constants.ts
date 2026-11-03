export const COUNTRIES = ['IN', 'AE'] as const;
export type Country = (typeof COUNTRIES)[number];

export const CURRENCIES = ['INR', 'AED', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const LANGUAGES = ['en', 'ml', 'ar'] as const;
export type Language = (typeof LANGUAGES)[number];
export const RTL_LANGUAGES: readonly Language[] = ['ar'];

export const TENANT_STATUSES = ['trial', 'active', 'past_due', 'suspended'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const USER_ROLES = ['owner', 'staff', 'tenant_accountant'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PLATFORM_ROLES = ['super_admin', 'reviewer', 'support'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const DRAFT_TYPES = ['purchase_invoice', 'journal_entry', 'sales_invoice', 'payment_in', 'payment_out'] as const;
export type DraftType = (typeof DRAFT_TYPES)[number];

export const DRAFT_STATUSES = [
  'pending',
  'confirmed',
  'posting',
  'posted',
  'cancelled',
  'needs_review',
  'failed',
] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const INTENTS = [
  'record_expense',
  'record_sale',
  'payment_in',
  'payment_out',
  'ask_books',
  'request_report',
  'send_reminder',
  'add_party',
  'help',
] as const;
export type Intent = (typeof INTENTS)[number];

export const PLAN_CODES = ['base', 'growth', 'pro'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const FEATURES = ['tax_centre', 'payroll', 'multi_currency', 'api_access', 'ask_books'] as const;
export type Feature = (typeof FEATURES)[number];

export const REPORT_NAMES = {
  receivables: 'Accounts Receivable',
  payables: 'Accounts Payable',
  profit_and_loss: 'Profit and Loss Statement',
  balance_sheet: 'Balance Sheet',
  general_ledger: 'General Ledger',
  cash_flow: 'Cash Flow',
} as const;
export type ReportKey = keyof typeof REPORT_NAMES;

export const QUEUES = {
  ocr: 'ocr.process',
  voice: 'voice.process',
  draftPost: 'draft.post',
  outboundInvoice: 'outbound.invoice',
  outboundReceipt: 'outbound.receipt',
  outboundReminder: 'outbound.reminder',
  scheduleReminders: 'schedule.reminders',
  scheduleDailySummary: 'schedule.daily_summary',
  usageRollup: 'usage.rollup',
  billingSync: 'billing.sync',
  healthErpnext: 'health.erpnext',
  deadLetter: 'dead-letter',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Confidence below which a draft is routed to human review. */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.8;
/** Small cash expenses below this (tenant currency) become Journal Entries instead of Purchase Invoices. */
export const SMALL_EXPENSE_THRESHOLD: Record<Currency, number> = { INR: 2000, AED: 100, USD: 25 };
export const CONVERSATION_TTL_SECONDS = 60 * 60 * 24;
export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_ATTEMPTS = 5;
