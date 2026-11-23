'use client';

import { Download, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Badge, Card, Empty, Skeleton } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { API_URL, api, type ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Run {
  id: string;
  status: 'running' | 'completed' | 'failed';
  periodFrom: string;
  periodTo: string;
  txnCount: number;
  totalValue: number;
  evidenceHash: string | null;
  startedAt: string;
  error: string | null;
  summary: { narrative?: string; bySeverity?: Record<string, number>; exposure?: number; population?: Record<string, number>; carriedDecisions?: number };
}
interface Finding {
  id: string;
  rule: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  detail: string;
  amount: number | null;
  status: 'open' | 'resolved' | 'dismissed';
  resolution: string | null;
  evidence: { transactions: Array<{ doctype: string; name: string; date: string; amount: number; party?: string }> };
}

const TONE = { critical: 'red', high: 'red', medium: 'amber', low: 'neutral' } as const;

export default function AuditPage() {
  const { me, session } = useAuth();
  const cur = me?.tenant.currency;
  const runs = useApi<{ items: Run[] }>('/v1/audit/runs');
  const latest = runs.data?.items.find((r) => r.status !== 'running') ?? runs.data?.items[0];
  const detail = useApi<{ run: Run; findings: Finding[] }>(latest ? `/v1/audit/runs/${latest.id}` : null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const running = runs.data?.items.some((r) => r.status === 'running');

  const reloadRuns = runs.reload;
  const reloadDetail = detail.reload;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reloadRuns(), 3000);
    return () => clearInterval(t);
  }, [running, reloadRuns]);
  useEffect(() => {
    if (!running) void reloadDetail();
  }, [running, reloadDetail]);

  if ((runs.error as ApiError | undefined)?.status === 402)
    return (
      <Page title="Audit Copilot" back="/more">
        <Card className="space-y-3 text-center">
          <ShieldCheck className="mx-auto h-8 w-8 text-brand" aria-hidden="true" />
          <p>Audit Copilot tests every transaction for duplicates, fraud patterns and tax-law breaches. It is part of the Pro plan.</p>
          <Link href="/billing"><Button>Upgrade</Button></Link>
        </Card>
      </Page>
    );

  const start = async () => {
    setBusy(true);
    setMsg('');
    try {
      await api.post('/v1/audit/runs', {});
      await runs.reload();
    } catch (e) {
      setMsg((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const decide = async (f: Finding, status: Finding['status']) => {
    try {
      await api.patch(`/v1/audit/findings/${f.id}`, { status, note: notes[f.id] || undefined });
      await detail.reload();
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };
  const download = async () => {
    if (!latest || !session) return;
    const res = await fetch(`${API_URL}/v1/audit/runs/${latest.id}/workpaper?format=csv`, { headers: { authorization: `Bearer ${session.accessToken}` }, credentials: 'include' });
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: `audit-${latest.periodFrom}-${latest.periodTo}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const run = detail.data?.run;
  const findings = (detail.data?.findings ?? []).filter((f) => filter === 'all' || f.status === 'open');
  const sev = run?.summary.bySeverity ?? {};
  return (
    <Page title="Audit Copilot" back="/more">
      <Card className="mb-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-muted">Tests 100% of your transactions, not a sample.</p>
            {run && run.status === 'completed' && (
              <p className="mt-1 text-sm">
                {run.txnCount} transactions · {money(run.totalValue, cur)} · {run.periodFrom} → {run.periodTo}
              </p>
            )}
          </div>
          <Button onClick={() => void start()} disabled={busy || running}>{running ? 'Testing…' : 'Run audit'}</Button>
        </div>
        {running && <Skeleton className="h-2" />}
        {run?.status === 'failed' && <p className="text-sm text-red-600">Last run failed: {run.error}</p>}
        {run?.summary.narrative && <p className="whitespace-pre-line rounded-xl bg-brand-light p-3 text-sm text-fg dark:bg-brand/20">{run.summary.narrative}</p>}
        {run?.status === 'completed' && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {(['critical', 'high', 'medium', 'low'] as const).map((s) => (
              <Badge key={s} tone={TONE[s]}>{sev[s] ?? 0} {s}</Badge>
            ))}
            {!!run.summary.exposure && <span className="text-muted">Exposure {money(run.summary.exposure, cur)}</span>}
            <button className="ms-auto inline-flex min-h-8 items-center gap-1 text-brand" onClick={() => void download()}><Download className="h-4 w-4" /> Workpaper</button>
          </div>
        )}
        {run?.evidenceHash && <p className="break-all font-mono text-[10px] text-muted" title="Evidence fingerprint, chained to the previous run">Evidence {run.evidenceHash.slice(0, 16)}…</p>}
        {msg && <p role="status" className="text-sm text-red-600">{msg}</p>}
      </Card>

      {run?.status === 'completed' && (
        <div className="mb-3 flex gap-2 text-sm">
          {(['open', 'all'] as const).map((k) => (
            <button key={k} onClick={() => setFilter(k)} className={`min-h-9 rounded-full px-3 ${filter === k ? 'bg-brand text-white' : 'border border-line'}`}>{k === 'open' ? 'Needs review' : 'All findings'}</button>
          ))}
        </div>
      )}
      {detail.loading && !detail.data && latest && <Skeleton className="h-40" />}
      {!latest && !runs.loading && <Empty>No audits yet. Run your first one above.</Empty>}
      {run?.status === 'completed' && findings.length === 0 && <Empty>{filter === 'open' ? 'Nothing needs review 🎉' : 'No exceptions found.'}</Empty>}
      <ul className="space-y-3">
        {findings.map((f) => (
          <li key={f.id}>
            <Card className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold">{f.title}</p>
                <Badge tone={TONE[f.severity]}>{f.severity}</Badge>
              </div>
              <p className="text-sm text-muted">{f.detail}</p>
              {f.amount ? <p className="text-sm tabular-nums">At stake: {money(f.amount, cur)}</p> : null}
              <details className="text-xs">
                <summary className="cursor-pointer text-brand">Evidence ({f.evidence.transactions.length} document{f.evidence.transactions.length === 1 ? '' : 's'})</summary>
                <ul className="mt-1 space-y-0.5 tabular-nums">
                  {f.evidence.transactions.map((t) => (
                    <li key={`${t.doctype}:${t.name}`}>{t.doctype} {t.name} · {t.date} · {t.party ?? ''} · {money(t.amount, cur)}</li>
                  ))}
                </ul>
              </details>
              {f.status === 'open' ? (
                <div className="space-y-2 border-t border-line pt-2">
                  <Input placeholder="Note (required to dismiss)" value={notes[f.id] ?? ''} onChange={(e) => setNotes({ ...notes, [f.id]: e.target.value })} />
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => void decide(f, 'resolved')}>Fixed</Button>
                    <Button variant="ghost" disabled={!notes[f.id]} onClick={() => void decide(f, 'dismissed')}>Not an issue</Button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted">
                  {f.status === 'resolved' ? 'Resolved' : 'Dismissed'}{f.resolution ? ` — ${f.resolution}` : ''}{' '}
                  <button className="text-brand" onClick={() => void decide(f, 'open')}>Reopen</button>
                </p>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </Page>
  );
}
