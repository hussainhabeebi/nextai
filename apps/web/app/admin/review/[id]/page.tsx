'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { H1 } from '@/components/admin/table';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { adminApi, ApiError } from '@/lib/api';
import { TYPE_LABEL, type DraftDto } from '@/lib/drafts';
import { useApi } from '@/lib/hooks';

type Detail = DraftDto & { tenant: { name: string; country: string }; extracted: Record<string, unknown> | null; conversationId: number | null };

export default function ReviewItem() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: d } = useApi<Detail>(`/admin/v1/review-queue/${id}`, adminApi);
  const [p, setP] = useState<Record<string, string>>({});
  const [type, setType] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!d) return;
    setType(d.type);
    setP({ partyName: d.payload.partyName ?? '', partyTaxId: d.payload.partyTaxId ?? '', billNo: d.payload.billNo ?? '', date: d.payload.date, total: String(d.payload.total), expenseAccount: d.payload.expenseAccount ?? '', taxTemplate: d.payload.taxTemplate ?? '', paymentMode: d.payload.paymentMode ?? '' });
  }, [d]);
  if (!d) return <div className="h-96 animate-pulse rounded-xl bg-line/60" />;

  const save = async () => {
    const total = Number(p.total);
    const lines = d.payload.lines.length <= 1 ? [{ description: d.payload.lines[0]?.description ?? 'Item', qty: 1, rate: total, amount: total }] : undefined;
    await adminApi.patch(`/admin/v1/review-queue/${id}`, { ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== '')), total, ...(lines ? { lines } : {}) });
  };
  const doAct = async (what: 'post' | 'return') => {
    setMsg('');
    try {
      await save();
      await adminApi.post(`/admin/v1/review-queue/${id}/${what}`);
      router.push('/admin/review');
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };
  return (
    <div>
      <H1>{TYPE_LABEL[type]} · {d.tenant.name}</H1>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-line bg-card p-2">
          {d.documentUrl ? <img src={d.documentUrl} alt="Bill" className="max-h-[75vh] w-full object-contain" /> : <p className="p-8 text-center text-sm text-muted">No document (typed / voice entry)</p>}
        </div>
        <div className="space-y-4">
          {d.payload.validationIssues.length > 0 && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">⚠️ {d.payload.validationIssues.join(' · ')}</p>}
          {d.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">{d.error}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.keys(p).map((k) => (
              <Field key={k} label={k}>
                <Input value={p[k]} onChange={(e) => setP({ ...p, [k]: e.target.value })} type={k === 'date' ? 'date' : 'text'} />
              </Field>
            ))}
            <Field label="type (read-only)"><Select value={type} disabled><option>{type}</option></Select></Field>
          </div>
          {d.extracted && (
            <details className="rounded-xl border border-line bg-card p-3 text-xs">
              <summary className="cursor-pointer font-medium">Raw extraction</summary>
              <pre className="mt-2 overflow-x-auto">{JSON.stringify(d.extracted, null, 2)}</pre>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void doAct('post')}>Save & post to ERPNext</Button>
            <Button variant="secondary" disabled={!d.conversationId} onClick={() => void doAct('return')}>Save & return to bot</Button>
            <Button variant="ghost" onClick={() => void save().then(() => setMsg('Saved'))}>Save only</Button>
          </div>
          {msg && <p className="text-sm">{msg}</p>}
        </div>
      </div>
    </div>
  );
}
