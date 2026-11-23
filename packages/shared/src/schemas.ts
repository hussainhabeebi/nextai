import { z } from 'zod';
import {
  COUNTRIES,
  CURRENCIES,
  DRAFT_STATUSES,
  DRAFT_TYPES,
  FEATURES,
  INTENTS,
  LANGUAGES,
  PLAN_CODES,
} from './constants.js';

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const money = z.number().finite();

export const reminderScheduleSchema = z.object({
  enabled: z.boolean().default(true),
  /** days relative to due date, negative = before due */
  offsetsDays: z.array(z.number().int().min(-30).max(90)).default([-3, 0, 7, 14]),
  hourLocal: z.number().int().min(0).max(23).default(10),
});

export const EINVOICE_SCHEMES = ['in_irp', 'ae_peppol', 'sa_zatca'] as const;
export type EInvoiceScheme = (typeof EINVOICE_SCHEMES)[number];

export const eInvoicingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Defaults by country: IN → in_irp, AE → ae_peppol. */
  scheme: z.enum(EINVOICE_SCHEMES).optional(),
  /** Submit automatically when a sales invoice is posted / submitted in ERPNext. */
  autoSubmit: z.boolean().default(true),
  /** IN: B2C invoices are exempt from IRP (only B2B/export). */
  includeB2C: z.boolean().default(false),
  /** Peppol participant id of the seller, e.g. "0235:100123456700003". */
  peppolId: z.string().optional(),
});

export const auditPolicySchema = z.object({
  /** Single cash payment above this is a policy breach (IN default: Sec 40A(3) ₹10,000). */
  maxCashPayment: z.number().positive().optional(),
  /** Cash received from one party in one day above this (IN default: Sec 269ST ₹2,00,000). */
  maxCashReceiptPerDay: z.number().positive().optional(),
  /** Transactions at or above this need a second approver. */
  approvalThreshold: z.number().positive().optional(),
  /** Purchases above this must carry the supplier's GSTIN/TRN. */
  taxIdRequiredAbove: z.number().nonnegative().optional(),
  /** Robust z-score above which an amount is an outlier. */
  outlierZ: z.number().min(2).max(10).default(3.5),
  /** Day window for near-duplicate detection. */
  duplicateWindowDays: z.number().int().min(0).max(30).default(3),
  flagWeekends: z.boolean().default(true),
  weeklyRun: z.boolean().default(true),
});
export type AuditPolicy = z.infer<typeof auditPolicySchema>;

export const forecastSettingsSchema = z.object({
  /** Annual inflation applied to run-rate expenses (macro signal). Defaults by country. */
  inflationPct: z.number().min(-20).max(100).optional(),
  /** Expected annual demand growth applied to run-rate sales (macro signal). */
  demandGrowthPct: z.number().min(-100).max(500).optional(),
  /** Cash balance below which a low-cash alert is raised. */
  minCashBuffer: z.number().nonnegative().default(0),
});

export const tenantSettingsSchema = z.object({
  taxRegime: z.enum(['gst_regular', 'gst_composition', 'vat', 'vat_ct', 'none']).default('gst_regular'),
  autoPost: z.boolean().default(false),
  timezone: z.string().default('Asia/Kolkata'),
  reminders: reminderScheduleSchema.default({}),
  dailySummary: z.object({ enabled: z.boolean().default(true), hourLocal: z.number().int().min(0).max(23).default(20) }).default({}),
  companyName: z.string().optional(),
  taxId: z.string().optional(),
  invoiceTemplate: z.string().optional(),
  bank: z
    .object({ name: z.string(), accountNo: z.string(), ifscOrIban: z.string() })
    .partial()
    .optional(),
  defaultCashAccount: z.string().optional(),
  defaultBankAccount: z.string().optional(),
  erpCompany: z.string().optional(),
  /** ERPNext company abbreviation used in account names, e.g. "Cash - AIL" */
  companyAbbr: z.string().optional(),
  /** Override default account / tax template names */
  accounts: z.record(z.string()).default({}),
  taxTemplates: z.record(z.string()).default({}),
  autoSendInvoices: z.boolean().default(true),
  featureFlags: z.record(z.boolean()).default({}),
  /** Registered business address (required on e-invoices). */
  address: z
    .object({
      line1: z.string(),
      line2: z.string(),
      city: z.string(),
      postalCode: z.string(),
      /** IN: 2-digit GST state code; AE: emirate code (DU, AZ, SH, AJ, UQ, RK, FU) */
      stateCode: z.string(),
    })
    .partial()
    .default({}),
  eInvoicing: eInvoicingSettingsSchema.default({}),
  auditPolicy: auditPolicySchema.default({}),
  forecast: forecastSettingsSchema.default({}),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export const planLimitsSchema = z.object({
  users: z.number().int(),
  ocrPagesPerMonth: z.number().int(),
  invoicesSentPerMonth: z.number().int(),
  messagesPerMonth: z.number().int(),
  features: z.array(z.enum(FEATURES)).default([]),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

// ---------------- Extraction (OCR) ----------------
export const extractedLineSchema = z.object({
  description: z.string(),
  qty: z.number().default(1),
  rate: z.number(),
  amount: z.number(),
  hsnSac: z.string().optional(),
  taxRate: z.number().optional(),
});

export const extractionSchema = z.object({
  docType: z.enum(['purchase_invoice', 'receipt', 'sales_invoice', 'bank_slip', 'other']),
  supplierName: z.string().nullable(),
  supplierTaxId: z.string().nullable(),
  invoiceNo: z.string().nullable(),
  date: isoDate.nullable(),
  currency: z.enum(CURRENCIES).nullable(),
  lines: z.array(extractedLineSchema).default([]),
  subtotal: z.number().nullable(),
  tax: z
    .object({
      cgst: z.number().default(0),
      sgst: z.number().default(0),
      igst: z.number().default(0),
      vat: z.number().default(0),
    })
    .default({}),
  total: z.number().nullable(),
  paymentMode: z.enum(['cash', 'bank', 'card', 'upi', 'credit', 'unknown']).default('unknown'),
  confidence: z.number().min(0).max(1),
});
export type Extraction = z.infer<typeof extractionSchema>;

// ---------------- Drafts ----------------
export const draftLineSchema = z.object({
  itemCode: z.string().optional(),
  description: z.string(),
  qty: z.number().positive(),
  rate: z.number(),
  amount: z.number(),
  account: z.string().optional(),
});

export const draftPayloadSchema = z.object({
  partyName: z.string().optional(),
  partyTaxId: z.string().optional(),
  partyPhone: z.string().optional(),
  billNo: z.string().optional(),
  date: isoDate,
  dueDate: isoDate.optional(),
  currency: z.enum(CURRENCIES),
  lines: z.array(draftLineSchema).default([]),
  taxTemplate: z.string().optional(),
  taxes: z.object({ cgst: z.number(), sgst: z.number(), igst: z.number(), vat: z.number() }).partial().optional(),
  total: z.number(),
  paymentMode: z.string().optional(),
  expenseAccount: z.string().optional(),
  paidFromAccount: z.string().optional(),
  paidToAccount: z.string().optional(),
  referenceNo: z.string().optional(),
  remarks: z.string().optional(),
  documentId: z.string().uuid().optional(),
  createParty: z.boolean().optional(),
  validationIssues: z.array(z.string()).default([]),
});
export type DraftPayload = z.infer<typeof draftPayloadSchema>;

export const draftTypeSchema = z.enum(DRAFT_TYPES);
export const draftStatusSchema = z.enum(DRAFT_STATUSES);

// ---------------- Intents ----------------
export const intentResultSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  entities: z
    .object({
      amount: z.number().optional(),
      currency: z.enum(CURRENCIES).optional(),
      party: z.string().optional(),
      description: z.string().optional(),
      date: isoDate.optional(),
      paymentMode: z.string().optional(),
      report: z.string().optional(),
      question: z.string().optional(),
    })
    .default({}),
});
export type IntentResult = z.infer<typeof intentResultSchema>;

// ---------------- API DTOs ----------------
export const otpRequestSchema = z.object({ phone: z.string().min(8).max(20) });
export const otpVerifySchema = z.object({
  phone: z.string().min(8).max(20),
  code: z.string().regex(/^\d{6}$/),
  tenantId: uuid.optional(),
});
export const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

export const tenantCreateSchema = z.object({
  name: z.string().min(2).max(200),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/),
  country: z.enum(COUNTRIES),
  currency: z.enum(CURRENCIES),
  language: z.enum(LANGUAGES).default('en'),
  planCode: z.enum(PLAN_CODES).default('base'),
  ownerPhone: z.string().min(8).max(20),
  ownerName: z.string().min(1),
  ownerEmail: z.string().email().optional(),
});
export type TenantCreate = z.infer<typeof tenantCreateSchema>;

// ---------------- Cash-flow what-if ----------------
export const forecastScenarioSchema = z.object({
  name: z.string().max(80).optional(),
  /** Extra days every customer takes to pay (negative = faster). */
  collectionDelayDays: z.number().int().min(-60).max(180).default(0),
  /** Extra days we take to pay suppliers. */
  payablesDelayDays: z.number().int().min(-60).max(180).default(0),
  /** Change in run-rate sales, percent. */
  salesChangePct: z.number().min(-100).max(500).default(0),
  /** Change in run-rate expenses, percent. */
  expenseChangePct: z.number().min(-100).max(500).default(0),
  /** Customers assumed never to pay (default / churn). */
  defaultingCustomers: z.array(z.string().max(140)).max(50).default([]),
  /** One-off inflows (+) or outflows (−), e.g. a loan, a capex purchase, a new hire's salary. */
  oneOffs: z
    .array(z.object({ date: isoDate, amount: z.number().finite(), label: z.string().max(80) }))
    .max(50)
    .default([]),
  /** Recurring monthly change (+/−), e.g. a new hire: −15000. */
  monthlyRecurring: z.array(z.object({ amount: z.number().finite(), label: z.string().max(80), startDate: isoDate.optional() })).max(20).default([]),
});
export type ForecastScenario = z.infer<typeof forecastScenarioSchema>;
