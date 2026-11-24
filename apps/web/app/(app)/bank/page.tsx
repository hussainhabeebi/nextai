'use client';

import { Upload } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Badge, Card, Empty, Skeleton } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';

type Line = { id: string; date: string; amount: number; direction: 'in' | 'out'; description: string; reference?: string; source: string; status: string; matchType?: string; matchName?: string };

/** Bank matching: upload a statement; lines that need an answer are listed (and asked on WhatsApp via "bank"). */
export default function Bank() {
  const { me } = useAuth();
  const { data, loading, reload } = useApi<{ items: Line[]; waitingApproval: number; matched: number }>('/v1/bank/lines');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const currency = me?.tenant.currency ?? 'INR';

  const upload = async (file: File) => {
    setBusy(true);
    setMsg('');
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await api.request<{ text: string }>('/v1/bank/statement', { method: 'POST', body: form });
      setMsg(r.text);
      await reload();
    } catch (e) {
      setMsg((e as ApiError).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const ignore = async (id: string) => {
    await api.post(`/v1/bank/lines/${id}/ignore`);
    await reload();
  };

  return (
    <Page title="Bank matching" back="/more" onRefresh={reload}>
      <Card className="mb-4 space-y-3">
        <p className="text-sm text-muted">
          Upload your bank statement (CSV from net banking works best, PDF also works) or forward bank SMS to NextAi on WhatsApp. We match each line with your invoices and bills and only ask about the rest.
        </p>
        <input ref={input} type="file" accept=".csv,text/csv,application/pdf,image/*" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <Button onClick={() => input.current?.click()} disabled={busy}>
          <Upload className="h-4 w-4" /> {busy ? 'Reading statement…' : 'Upload statement'}
        </Button>
        {msg && <p role="status" className="whitespace-pre-line rounded-xl bg-brand-light p-3 text-sm text-brand-dark">{msg}</p>}
        {data && (
          <p className="text-sm">
            {data.matched} matched · {data.waitingApproval > 0 ? <Link className="text-brand underline" href="/approvals">{data.waitingApproval} waiting for approval</Link> : '0 waiting for approval'} · {data.items.length} need you
          </p>
        )}
      </Card>
      {loading && !data && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="mb-3 h-20" />)}
      {data?.items.length === 0 && <Empty>Nothing needs you. 🎉</Empty>}
      <ul className="space-y-3">
        {data?.items.map((l) => (
          <li key={l.id}>
            <Card>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{l.description}</p>
                  <p className="text-xs text-muted">{l.date}{l.reference ? ` · ref ${l.reference}` : ''} · {l.source === 'sms' ? 'SMS' : 'statement'}</p>
                </div>
                <p className={`shrink-0 font-bold tabular-nums ${l.direction === 'in' ? 'text-brand' : ''}`}>{l.direction === 'in' ? '+' : '−'}{money(l.amount, currency)}</p>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                {l.matchName ? <Badge tone="amber">Maybe {l.matchName}</Badge> : <Badge tone="red">Needs an answer</Badge>}
                <Button variant="ghost" onClick={() => void ignore(l.id)}>Not business / ignore</Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-center text-xs text-muted">Reply &quot;bank&quot; on WhatsApp to sort these one by one.</p>
    </Page>
  );
}
