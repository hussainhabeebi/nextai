'use client';

import { useState } from 'react';
import { EntryLayout, FieldGrid, Saved, useToday } from '@/components/entry';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { MODES, todayIso } from '@/lib/entries';
import { money } from '@/lib/format';

/** Receipt (money in from a customer) or Payment (money out to a supplier). */
export function PaymentForm({ direction }: { direction: 'in' | 'out' }) {
  const { me } = useAuth();
  const today = useToday();
  const [party, setParty] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('bank');
  const [date, setDate] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const receipt = direction === 'in';

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.post('/v1/payments', {
        direction,
        party,
        amount: Number(amount),
        mode,
        date,
        reference: reference || undefined,
      });
      setSaved(
        `${receipt ? 'Received' : 'Paid'} ${money(Number(amount), me?.tenant.currency)} ${receipt ? 'from' : 'to'} ${party}.`,
      );
      setParty('');
      setAmount('');
      setReference('');
      void today.reload();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EntryLayout title={receipt ? 'Receipt' : 'Payment'} kind={receipt ? 'receipt' : 'payment'} today={today}>
      {saved && <Saved text={saved} onDismiss={() => setSaved('')} />}
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <FieldGrid>
          <Field label={receipt ? 'Received from (customer)' : 'Paid to (supplier)'}>
            <Input value={party} onChange={(e) => setParty(e.target.value)} required autoFocus />
          </Field>
          <Field label="Amount">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Mode">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </FieldGrid>
        <Field label="Reference — cheque / UTR / transaction ID (optional)">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button size="lg" className="sm:w-auto" disabled={busy || !party || !(Number(amount) > 0)}>
          {busy ? 'Saving…' : receipt ? 'Save receipt' : 'Save payment'}
        </Button>
      </form>
    </EntryLayout>
  );
}
