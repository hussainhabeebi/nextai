'use client';

import { useState } from 'react';
import { EntryLayout, FieldGrid, Saved, useToday } from '@/components/entry';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { MODES, todayIso } from '@/lib/entries';
import { money } from '@/lib/format';

const CATEGORIES = [
  { key: 'auto', name: 'Auto-detect from description' },
  { key: 'travel', name: 'Travel & fuel' },
  { key: 'food', name: 'Food & refreshments' },
  { key: 'rent', name: 'Rent' },
  { key: 'utilities', name: 'Electricity, water, internet, phone' },
  { key: 'salary', name: 'Salary & wages' },
  { key: 'office', name: 'Office & stationery' },
  { key: 'postage', name: 'Courier & postage' },
  { key: 'marketing', name: 'Marketing & ads' },
  { key: 'misc', name: 'Miscellaneous' },
];

export default function ExpenseEntry() {
  const { me } = useAuth();
  const today = useToday();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('auto');
  const [mode, setMode] = useState('cash');
  const [date, setDate] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.post<{ payload: { expenseAccount?: string } }>('/v1/expenses', { description, amount: Number(amount), category, paymentMode: mode, date, reference: reference || undefined });
      setSaved(`${description} — ${money(Number(amount), me?.tenant.currency)} booked to ${r.payload.expenseAccount ?? 'expenses'}.`);
      setDescription('');
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
    <EntryLayout title="Expense" kind="expense" today={today}>
      {saved && <Saved text={saved} onDismiss={() => setSaved('')} />}
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Field label="What was it for?">
          <Input value={description} placeholder="e.g. Taxi to client office" onChange={(e) => setDescription(e.target.value)} required autoFocus />
        </Field>
        <FieldGrid>
          <Field label="Amount">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Paid by">
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
        <Field label="Reference / voucher no. (optional)">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button size="lg" className="sm:w-auto" disabled={busy || !description || !(Number(amount) > 0)}>
          {busy ? 'Saving…' : 'Save expense'}
        </Button>
        <p className="text-xs text-muted">For a supplier bill with GST/VAT, use Purchase instead so input tax is claimed.</p>
      </form>
    </EntryLayout>
  );
}
