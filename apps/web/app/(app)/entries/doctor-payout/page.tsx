'use client';

import { useState } from 'react';
import { EntryLayout, FieldGrid, Saved, useToday } from '@/components/entry';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { MODES, todayIso } from '@/lib/entries';
import { money } from '@/lib/format';

const PREFIX = 'Doctor fee — ';

export default function DoctorPayout() {
  const { me } = useAuth();
  const today = useToday();
  const [doctor, setDoctor] = useState('');
  const [details, setDetails] = useState('');
  const [patients, setPatients] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('cash');
  const [date, setDate] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr('');
    const name = /^dr\b/i.test(doctor) ? doctor : `Dr ${doctor}`;
    const description = `${PREFIX}${name}${details ? `: ${details}` : ''}${patients ? ` (${patients} patients)` : ''}`;
    try {
      await api.post('/v1/expenses', {
        description,
        amount: Number(amount),
        category: 'doctor_fees',
        paymentMode: mode,
        date,
        reference: reference || undefined,
      });
      setSaved(`Paid ${money(Number(amount), me?.tenant.currency)} to ${name}.`);
      setDetails('');
      setPatients('');
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
    <EntryLayout
      title="Doctor payout"
      kind="expense"
      today={today}
      match={(e) => e.description.startsWith(PREFIX)}
      todayTitle="Today's doctor payouts"
    >
      {saved && <Saved text={saved} onDismiss={() => setSaved('')} />}
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <FieldGrid>
          <Field label="Doctor">
            <Input
              value={doctor}
              placeholder="Dr…"
              onChange={(e) => setDoctor(e.target.value)}
              required
              autoFocus
            />
          </Field>
          <Field label="For (optional)">
            <Input
              value={details}
              placeholder="e.g. OP share 1–15 Nov"
              onChange={(e) => setDetails(e.target.value)}
            />
          </Field>
          <Field label="Patients seen (optional)">
            <Input
              inputMode="numeric"
              value={patients}
              onChange={(e) => setPatients(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <Field label="Amount">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
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
        <Field label="Reference (optional)">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button size="lg" className="sm:w-auto" disabled={busy || !doctor || !(Number(amount) > 0)}>
          {busy ? 'Saving…' : 'Save payout'}
        </Button>
        <p className="text-xs text-muted">
          Booked to the doctor-fees account (Salary by default; your accountant can point it to another head).
        </p>
      </form>
    </EntryLayout>
  );
}
