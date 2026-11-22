'use client';

import { useState } from 'react';
import { EntryLayout, FieldGrid, Saved, useToday } from '@/components/entry';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { todayIso } from '@/lib/entries';
import { money } from '@/lib/format';

const KINDS = [
  { key: 'deposit', label: 'Cash deposit', hint: 'Cash → Bank' },
  { key: 'withdrawal', label: 'Cash withdrawal', hint: 'Bank → Cash' },
  { key: 'charges', label: 'Bank charges', hint: 'Fees debited by bank' },
] as const;

export default function BankEntry() {
  const { me } = useAuth();
  const today = useToday();
  const [kind, setKind] = useState<(typeof KINDS)[number]['key']>('deposit');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [remarks, setRemarks] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.post('/v1/bank-entries', { kind, amount: Number(amount), date, reference: reference || undefined, remarks: remarks || undefined });
      setSaved(`${KINDS.find((k) => k.key === kind)!.label} of ${money(Number(amount), me?.tenant.currency)} recorded.`);
      setAmount('');
      setReference('');
      setRemarks('');
      void today.reload();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EntryLayout title="Bank entry" kind="bank" today={today}>
      {saved && <Saved text={saved} onDismiss={() => setSaved('')} />}
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <div role="radiogroup" aria-label="Entry type" className="grid gap-2 sm:grid-cols-3">
          {KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              role="radio"
              aria-checked={kind === k.key}
              onClick={() => setKind(k.key)}
              className={cn('rounded-xl border px-3 py-2.5 text-start', kind === k.key ? 'border-brand bg-brand-light text-brand dark:bg-brand/20' : 'border-line hover:bg-bg')}
            >
              <span className="block text-sm font-semibold">{k.label}</span>
              <span className="block text-xs text-muted">{k.hint}</span>
            </button>
          ))}
        </div>
        <FieldGrid>
          <Field label="Amount">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Cheque / UTR / slip no. (optional)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label="Remarks (optional)">
            <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>
        </FieldGrid>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button size="lg" className="sm:w-auto" disabled={busy || !(Number(amount) > 0)}>
          {busy ? 'Saving…' : 'Save bank entry'}
        </Button>
        <p className="text-xs text-muted">Money from customers or to suppliers through the bank? Use Receipt or Payment so their balances update.</p>
      </form>
    </EntryLayout>
  );
}
