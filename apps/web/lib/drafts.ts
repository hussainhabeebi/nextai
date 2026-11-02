import type { DraftPayload } from '@nextai/shared';

export interface DraftDto {
  id: string;
  type: string;
  status: string;
  payload: DraftPayload;
  confidence: number | null;
  error: string | null;
  erpName: string | null;
  createdAt: string;
  documentUrl?: string | null;
}

export const TYPE_LABEL: Record<string, string> = {
  purchase_invoice: 'Purchase bill',
  journal_entry: 'Expense',
  sales_invoice: 'Sales invoice',
  payment_in: 'Payment received',
  payment_out: 'Payment made',
};
export const statusTone = (s: string) => (s === 'posted' ? 'green' : s === 'needs_review' || s === 'failed' ? 'red' : 'amber') as 'green' | 'red' | 'amber';

