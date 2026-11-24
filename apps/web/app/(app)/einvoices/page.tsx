'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Badge, Card, Empty, Skeleton } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { api, type ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface EInvoiceRow {
  id: string;
  scheme: string;
  invoiceName: string;
  status: 'pending' | 'invalid' | 'submitted' | 'accepted' | 'rejected' | 'cancelled' | 'failed';
  irn: string | null;
  ackNo: string | null;
  ackDate: string | null;
  total: number;
  taxTotal: number;
  buyerTaxId: string | null;
  errors: Array<{ field: string; message: string }>;
  createdAt: string;
}
interface Summary {
  enabled: boolean;
  scheme: string;
  gateway: string;
  counts: Record<string, number>;
  needsAction: number;
  reported: { invoices: number; value: number; tax: number };
}

const SCHEME = { in_irp: 'GST IRP (India)', ae_peppol: 'Peppol PINT AE (UAE FTA)', sa_zatca: 'ZATCA FATOORA (KSA)' } as Record<string, string>;
const TONE: Record<EInvoiceRow['status'], 'green' | 'amber' | 'red' | 'neutral'> = { accepted: 'green', pending: 'amber', submitted: 'amber', invalid: 'red', rejected: 'red', failed: 'red', cancelled: 'neutral' };
const LABEL: Record<EInvoiceRow['status'], string> = { accepted: 'Registered', pending: 'Submitting', submitted: 'Submitted', invalid: 'Fix needed', rejected: 'Rejected', failed: 'Retrying', cancelled: 'Cancelled' };

export default function EInvoicesPage() {
  const { me } = useAuth();
  const cur = me?.tenant.currency;
  const [status, setStatus] = useState('');
  const { data, error, loading, reload } = useApi<{ items: EInvoiceRow[]; summary: Summary }>(`/v1/einvoices${status ? `?status=${status}` : ''}`);
  const [msg, setMsg] = useState('');

  if ((error as ApiError | undefined)?.status === 402)
    return (
      <Page title="E-invoices" back="/more">
        <Card className="space-y-3 text-center">
          <p>E-invoicing is not on your plan.</p>
          <Link href="/billing"><Button>See plans</Button></Link>
        </Card>
      </Page>
    );

  const resubmit = async (r: EInvoiceRow) => {
    setMsg('');
    try {
      await api.post('/v1/einvoices/submit', { invoiceName: r.invoiceName });
      setMsg(`${r.invoiceName} queued for submission.`);
      setTimeout(() => void reload(), 2500);
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };
  const cancel = async (r: EInvoiceRow) => {
    if (!confirm(`Cancel the IRN for ${r.invoiceName}? This is reported to the GST portal.`)) return;
    try {
      await api.post(`/v1/einvoices/${r.id}/cancel`, { reason: 'data_entry_mistake' });
      await reload();
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };

  const s = data?.summary;
  return (
    <Page title="E-invoices" back="/more">
      {s && (
        <Card className="mb-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold">{SCHEME[s.scheme] ?? s.scheme}</p>
            <Badge tone={s.enabled ? 'green' : 'neutral'}>{s.enabled ? 'On' : 'Off'}</Badge>
          </div>
          <p className="text-sm tabular-nums">
            {s.reported.invoices} registered · {money(s.reported.value, cur)} · tax {money(s.reported.tax, cur)}
          </p>
          {s.needsAction > 0 && <p className="text-sm text-red-600">{s.needsAction} invoice(s) need attention before they can be issued.</p>}
          {!s.enabled && <p className="text-sm text-muted">Turn it on in <Link href="/settings" className="text-brand">Settings → E-invoicing</Link>. Add your business address first.</p>}
          {s.gateway === 'sandbox' && <p className="text-xs text-muted">Sandbox mode: documents are validated and simulated, not reported to the authority.</p>}
        </Card>
      )}
      <div className="mb-3">
        <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          <option value="invalid">Fix needed</option>
          <option value="rejected">Rejected</option>
          <option value="failed">Retrying</option>
          <option value="accepted">Registered</option>
          <option value="cancelled">Cancelled</option>
        </Select>
      </div>
      {msg && <p role="status" className="mb-3 text-sm">{msg}</p>}
      {loading && !data && <Skeleton className="h-40" />}
      {data?.items.length === 0 && <Empty>No e-invoices yet.</Empty>}
      <ul className="space-y-3">
        {data?.items.map((r) => (
          <li key={r.id}>
            <Card className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{r.invoiceName}</span>
                <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
              </div>
              <p className="text-sm tabular-nums text-muted">{money(r.total, cur)} · tax {money(r.taxTotal, cur)}{r.buyerTaxId ? ` · ${r.buyerTaxId}` : ''}</p>
              {r.status === 'accepted' && r.irn && (
                <p className="break-all font-mono text-[11px] text-muted">{r.scheme === 'in_irp' ? 'IRN' : 'UUID'} {r.irn}{r.ackNo ? ` · Ack ${r.ackNo}` : ''}</p>
              )}
              {r.errors.length > 0 && (
                <ul className="list-disc ps-5 text-sm text-red-700 dark:text-red-300">
                  {r.errors.map((e, i) => <li key={i}>{e.message}</li>)}
                </ul>
              )}
              <div className="flex gap-2 pt-1">
                {['invalid', 'rejected', 'failed'].includes(r.status) && <Button variant="secondary" onClick={() => void resubmit(r)}>Resubmit</Button>}
                {r.status === 'accepted' && r.scheme === 'in_irp' && r.ackDate && Date.now() - Date.parse(r.ackDate) < 24 * 3600_000 && (
                  <Button variant="ghost" onClick={() => void cancel(r)}>Cancel IRN</Button>
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </Page>
  );
}
