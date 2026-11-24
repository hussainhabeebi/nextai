import type { AppStyle, AppView } from '@nextai/shared';
import { Building2, HandCoins, Pill, PackagePlus, Stethoscope, type LucideIcon } from 'lucide-react';
import { useAuth } from './auth';
import { ENTRY_ACTIONS, KIND_LABEL, type EntryAction, type EntryKind } from './entries';

/**
 * App views ("industry layouts"). The General view is the original app and must stay unchanged;
 * Clinic and Pharmacy swap in their own entry menu, wording and screens on top of the same books.
 */
export interface ViewMeta {
  label: string;
  description: string;
  icon: LucideIcon;
  /** Style suggested when the owner picks this view */
  suggestedStyle: AppStyle;
}
export const VIEWS: Record<AppView, ViewMeta> = {
  general: {
    label: 'General business',
    description: 'Sales, purchases, expenses, bank, receipts and payments.',
    icon: Building2,
    suggestedStyle: 'teal',
  },
  clinic: {
    label: 'Clinic',
    description: 'Patient bills (consultation, procedures, lab), doctor payouts, daily collection.',
    icon: Stethoscope,
    suggestedStyle: 'blue',
  },
  pharmacy: {
    label: 'Pharmacy',
    description: 'Counter sales with batch & expiry, distributor purchases, daily sales.',
    icon: Pill,
    suggestedStyle: 'green',
  },
};

/** RGB triplets for the --brand CSS variables. Teal is the original NextAi colour. */
export const STYLES: Record<AppStyle, { label: string; brand: string; dark: string; light: string }> = {
  teal: { label: 'Teal', brand: '14 122 107', dark: '10 94 82', light: '230 243 241' },
  blue: { label: 'Medical blue', brand: '29 100 196', dark: '22 76 150', light: '231 240 252' },
  green: { label: 'Pharmacy green', brand: '22 135 74', dark: '17 104 57', light: '231 246 237' },
  violet: { label: 'Violet', brand: '109 74 196', dark: '84 56 153', light: '240 235 251' },
  rose: { label: 'Rose', brand: '190 52 85', dark: '148 38 65', light: '252 235 239' },
  slate: { label: 'Slate', brand: '51 65 85', dark: '30 41 59', light: '236 239 244' },
};

const tone = (k: EntryKind) => ENTRY_ACTIONS.find((a) => a.kind === k)!.tone;
const base = (k: EntryKind | 'daily', patch: Partial<EntryAction> = {}): EntryAction => ({
  ...ENTRY_ACTIONS.find((a) => a.kind === k)!,
  ...patch,
});

const ACTIONS: Record<AppView, EntryAction[]> = {
  general: ENTRY_ACTIONS,
  clinic: [
    {
      kind: 'sale',
      href: '/entries/patient-bill',
      label: 'Patient bill',
      hint: 'Consultation, procedure, lab',
      icon: Stethoscope,
      tone: tone('sale'),
    },
    base('receipt', { label: 'Patient receipt', hint: 'Advance / dues collected' }),
    {
      kind: 'expense',
      href: '/entries/doctor-payout',
      label: 'Doctor payout',
      hint: 'Visiting doctor fees',
      icon: HandCoins,
      tone: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200',
    },
    base('purchase', { label: 'Supplies purchase', hint: 'Medicines, consumables' }),
    base('expense'),
    base('bank'),
    base('payment', { hint: 'Paid to suppliers' }),
    base('daily', { label: 'Daily collection', hint: "Today's bills & cash" }),
  ],
  pharmacy: [
    {
      kind: 'sale',
      href: '/entries/counter-sale',
      label: 'Counter sale',
      hint: 'Medicines with batch & expiry',
      icon: Pill,
      tone: tone('sale'),
    },
    {
      kind: 'purchase',
      href: '/entries/stock-purchase',
      label: 'Stock purchase',
      hint: 'Distributor bill',
      icon: PackagePlus,
      tone: tone('purchase'),
    },
    base('receipt', { hint: 'Credit customer paid' }),
    base('payment', { label: 'Distributor payment', hint: 'Paid to distributor' }),
    base('expense'),
    base('bank'),
    base('daily', { label: 'Daily sales report', hint: "Today's sales & cash" }),
  ],
};

const KIND_OVERRIDES: Record<AppView, Partial<Record<EntryKind, string>>> = {
  general: {},
  clinic: { sale: 'Patient bill' },
  pharmacy: { sale: 'Counter sale', purchase: 'Stock purchase' },
};

export interface ViewLabels {
  /** Sidebar link to the invoice list */
  salesList: string;
  parties: string;
  dailyReport: string;
  /** Phone bottom-bar "Sales" tab */
  salesTab: { label: string; href: string } | null;
}
const LABELS: Record<AppView, ViewLabels> = {
  general: {
    salesList: 'Sales invoices',
    parties: 'Customers & suppliers',
    dailyReport: 'Daily report',
    salesTab: null,
  },
  clinic: {
    salesList: 'Bills & invoices',
    parties: 'Patients & suppliers',
    dailyReport: 'Daily collection',
    salesTab: { label: 'Bill', href: '/entries/patient-bill' },
  },
  pharmacy: {
    salesList: 'Sales bills',
    parties: 'Customers & distributors',
    dailyReport: 'Daily sales report',
    salesTab: { label: 'Sale', href: '/entries/counter-sale' },
  },
};

export const viewOf = (v: string | undefined | null): AppView =>
  v === 'clinic' || v === 'pharmacy' ? v : 'general';

export function viewConfig(view: AppView) {
  return {
    view,
    meta: VIEWS[view],
    actions: ACTIONS[view],
    labels: LABELS[view],
    kindLabel: (k: EntryKind) => KIND_OVERRIDES[view][k] ?? KIND_LABEL[k],
  };
}

/** The signed-in tenant's view. Falls back to General until /v1/me has loaded. */
export function useView() {
  const { me } = useAuth();
  return viewConfig(viewOf(me?.tenant.appView));
}
