'use client';

import { Check, Pencil, X } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Badge, Card, Skeleton } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { TYPE_LABEL, statusTone, type DraftDto } from '@/lib/drafts';

export default function DraftDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const { data: d, setData } = useApi<DraftDto>(`/v1/drafts/${id}`);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ partyName: '', total: '', date: '', billNo: '', expenseAccount: '' });
  const [err, setErr] = useState('');
  useEffect(() => {
    if (d) setForm({ partyName: d.payload.partyName ?? '', total: String(d.payload.total), date: d.payload.date, billNo: d.payload.billNo ?? '', expenseAccount: d.payload.expenseAccount ?? '' });
  }, [d]);

  const act = async (fn: () => Promise<DraftDto>) => {
    setErr('');
    try {
      const r = await fn();
      setData({ ...d!, ...r });
      return r;
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };
  const save = () =>
    act(() =>
      api.patch<DraftDto>(`/v1/drafts/${id}`, {
        partyName: form.partyName || undefined,
        total: Number(form.total),
        date: form.date,
        billNo: form.billNo || undefined,
        expenseAccount: form.expenseAccount || undefined,
      }),
    ).then((r) => r && setEdit(false));

  const editable = d && ['pending', 'needs_review', 'failed'].includes(d.status);
  return (
    <Page title={d ? TYPE_LABEL[d.type]! : '…'} back="/approvals">
      {!d ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-4">
          {d.documentUrl && (
            <Card className="overflow-hidden p-0">
              <img src={d.documentUrl} alt="Bill" className="max-h-[50vh] w-full bg-black/5 object-contain" />
            </Card>
          )}
          <Card className="space-y-2">
            <div className="flex items-center justify-between">
              <Badge tone={statusTone(d.status)}>{d.status.replace('_', ' ')}</Badge>
              {d.confidence !== null && <span className="text-xs text-muted">Confidence {Math.round(d.confidence * 100)}%</span>}
            </div>
            {edit ? (
              <div className="space-y-3">
                <Field label="Party">
                  <Input value={form.partyName} onChange={(e) => setForm({ ...form, partyName: e.target.value })} />
                </Field>
                <Field label="Total">
                  <Input inputMode="decimal" value={form.total} onChange={(e) => setForm({ ...form, total: e.target.value })} />
                </Field>
                <Field label="Date">
                  <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
                </Field>
                <Field label="Bill no">
                  <Input value={form.billNo} onChange={(e) => setForm({ ...form, billNo: e.target.value })} />
                </Field>
                <Field label="Expense account" hint="NextAi remembers this for the supplier next time.">
                  <Input value={form.expenseAccount} onChange={(e) => setForm({ ...form, expenseAccount: e.target.value })} />
                </Field>
                <Button size="lg" onClick={() => void save()}>Save</Button>
              </div>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted">Party</dt>
                <dd>{d.payload.partyName ?? '—'}</dd>
                <dt className="text-muted">Date</dt>
                <dd>{d.payload.date}</dd>
                {d.payload.billNo && (
                  <>
                    <dt className="text-muted">Bill no</dt>
                    <dd>{d.payload.billNo}</dd>
                  </>
                )}
                <dt className="text-muted">Total</dt>
                <dd className="text-lg font-bold">{money(d.payload.total, d.payload.currency)}</dd>
                {d.payload.expenseAccount && (
                  <>
                    <dt className="text-muted">Account</dt>
                    <dd>{d.payload.expenseAccount}</dd>
                  </>
                )}
                {d.erpName && (
                  <>
                    <dt className="text-muted">Reference</dt>
                    <dd>{d.erpName}</dd>
                  </>
                )}
              </dl>
            )}
            {d.payload.lines.length > 0 && !edit && (
              <ul className="mt-2 divide-y divide-line border-t border-line text-sm">
                {d.payload.lines.map((l, i) => (
                  <li key={i} className="flex justify-between py-2">
                    <span className="truncate">{l.qty} × {l.description}</span>
                    <span className="tabular-nums">{money(l.amount, d.payload.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
            {d.payload.validationIssues.length > 0 && <p className="text-sm text-amber-700 dark:text-amber-300">⚠️ {d.payload.validationIssues.join(' · ')}</p>}
            {d.error && <p className="text-sm text-red-600">{d.error}</p>}
          </Card>
          {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
          {editable && !edit && (
            <div className="safe-bottom fixed inset-x-0 bottom-14 z-20 border-t border-line bg-card p-3">
              <div className="mx-auto grid max-w-[640px] grid-cols-[1fr_auto_auto] gap-2">
                <Button size="lg" onClick={() => void act(() => api.post<DraftDto>(`/v1/drafts/${id}/confirm`))}>
                  <Check className="h-5 w-5" /> {t('action.confirm')}
                </Button>
                <Button size="icon" variant="secondary" className="h-14 w-14" aria-label={t('action.edit')} onClick={() => setEdit(true)}>
                  <Pencil className="h-5 w-5" />
                </Button>
                <Button size="icon" variant="secondary" className="h-14 w-14" aria-label={t('action.reject')} onClick={() => void act(() => api.post<DraftDto>(`/v1/drafts/${id}/cancel`)).then(() => router.push('/approvals'))}>
                  <X className="h-5 w-5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Page>
  );
}
