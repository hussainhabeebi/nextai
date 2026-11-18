import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  Landmark,
  ReceiptText,
  ShoppingCart,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

export type EntryKind = 'sale' | 'purchase' | 'expense' | 'bank' | 'receipt' | 'payment';

export interface EntryAction {
  kind: EntryKind | 'daily';
  href: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Tailwind classes for the icon chip */
  tone: string;
}

/** The manual-entry vouchers, in the order an accountant works through a day. */
export const ENTRY_ACTIONS: EntryAction[] = [
  {
    kind: 'sale',
    href: '/sales/new',
    label: 'Sales',
    hint: 'Invoice a customer',
    icon: ReceiptText,
    tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200',
  },
  {
    kind: 'purchase',
    href: '/entries/purchase',
    label: 'Purchase',
    hint: 'Supplier bill',
    icon: ShoppingCart,
    tone: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200',
  },
  {
    kind: 'expense',
    href: '/entries/expense',
    label: 'Expense',
    hint: 'Rent, travel, tea…',
    icon: Wallet,
    tone: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200',
  },
  {
    kind: 'bank',
    href: '/entries/bank',
    label: 'Bank entry',
    hint: 'Deposit / withdrawal',
    icon: Landmark,
    tone: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200',
  },
  {
    kind: 'receipt',
    href: '/entries/receipt',
    label: 'Receipt',
    hint: 'Money received',
    icon: ArrowDownLeft,
    tone: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-200',
  },
  {
    kind: 'payment',
    href: '/entries/payment',
    label: 'Payment',
    hint: 'Money paid out',
    icon: ArrowUpRight,
    tone: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200',
  },
  {
    kind: 'daily',
    href: '/reports/daily',
    label: 'Daily report',
    hint: "Today's day book",
    icon: CalendarDays,
    tone: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  },
];

export const KIND_LABEL: Record<EntryKind, string> = {
  sale: 'Sale',
  purchase: 'Purchase',
  expense: 'Expense',
  bank: 'Bank',
  receipt: 'Receipt',
  payment: 'Payment',
};

export interface DailyEntry {
  id: string;
  kind: EntryKind;
  party: string | null;
  description: string;
  amount: number;
  mode: string | null;
  reference: string | null;
  erpName: string | null;
  status: string;
  createdAt: string;
}

export interface DailyReport {
  date: string;
  currency: string;
  totals: Record<
    'sales' | 'purchases' | 'expenses' | 'bank' | 'receipts' | 'payments' | 'cashIn' | 'cashOut',
    number
  >;
  netCashFlow: number;
  grossProfit: number;
  entries: DailyEntry[];
}

/** Local calendar date (not UTC) as YYYY-MM-DD. */
export const todayIso = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

export const shiftDay = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const MODES = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
] as const;

/** "upi" → "UPI", "bank" → "Bank transfer", "credit" → "On credit". */
export const modeLabel = (m: string | null | undefined) =>
  !m ? '' : m === 'credit' ? 'On credit' : (MODES.find((x) => x.value === m)?.label ?? m);
