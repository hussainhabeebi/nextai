'use client';

import { useState } from 'react';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

export default function Payments() {
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [party, setParty] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('bank');
  const [reference, setReference] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setMsg('');
    try {
      await api.post('/v1/payments', { direction, party, amount: Number(amount), mode, reference: reference || undefined });
      setMsg('Recorded ✅ It will appear in your books in a moment.');
      setParty('');
      setAmount('');
      setReference('');
    } catch (e) {
      setMsg((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="Payments" back="/more">
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-card p-1">
        {(['in', 'out'] as const).map((d) => (
          <button key={d} onClick={() => setDirection(d)} className={cn('min-h-11 rounded-lg text-sm font-medium', direction === d ? 'bg-brand text-white' : 'text-muted')}>
            {d === 'in' ? 'Received' : 'Paid'}
          </button>
        ))}
      </div>
      <Card>
        <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
          <Field label={direction === 'in' ? 'From customer' : 'To supplier'}>
            <Input value={party} onChange={(e) => setParty(e.target.value)} required />
          </Field>
          <Field label="Amount">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Mode">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="bank">Bank transfer</option>
              <option value="upi">UPI</option>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
            </Select>
          </Field>
          <Field label="Reference (optional)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Button size="lg" disabled={busy || !party || !(Number(amount) > 0)}>Record payment</Button>
        </form>
      </Card>
      {msg && <p role="status" className="mt-4 text-sm">{msg}</p>}
    </Page>
  );
}
