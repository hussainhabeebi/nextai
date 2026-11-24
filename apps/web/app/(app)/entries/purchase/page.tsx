'use client';

import { useState } from 'react';
import { EntryLayout, FieldGrid, Saved, useToday } from '@/components/entry';
import { LineItems, cleanLines, emptyLine, lineTotal } from '@/components/line-items';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { MODES, todayIso } from '@/lib/entries';
import { money } from '@/lib/format';

export default function PurchaseEntry() {
  const { me } = useAuth();
  const today = useToday();
  const [supplier, setSupplier] = useState('');
  const [billNo, setBillNo] = useState('');
  const [date, setDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState('');
  const [mode, setMode] = useState('credit');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState([emptyLine()]);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const total = lineTotal(lines);

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.post('/v1/purchases', { supplier, billNo: billNo || undefined, date, dueDate: dueDate || undefined, paymentMode: mode, remarks: remarks || undefined, lines: cleanLines(lines) });
      setSaved(`Purchase from ${supplier} — ${money(total, me?.tenant.currency)} saved${mode === 'credit' ? ' (on credit)' : ' and marked paid'}.`);
      setSupplier('');
      setBillNo('');
      setDueDate('');
      setRemarks('');
      setLines([emptyLine()]);
      void today.reload();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EntryLayout title="Purchase bill" kind="purchase" today={today}>
      {saved && <Saved text={saved} onDismiss={() => setSaved('')} />}
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <FieldGrid>
          <Field label="Supplier">
            <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} required autoFocus />
          </Field>
          <Field label="Supplier bill no.">
            <Input value={billNo} onChange={(e) => setBillNo(e.target.value)} />
          </Field>
          <Field label="Bill date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Payment">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="credit">On credit (pay later)</option>
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  Paid — {m.label}
                </option>
              ))}
            </Select>
          </Field>
          {mode === 'credit' && (
            <Field label="Due date (optional)">
              <Input type="date" value={dueDate} min={date} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
          )}
        </FieldGrid>
        <LineItems lines={lines} onChange={setLines} currency={me?.tenant.currency} itemLabel="Item / expense" />
        <Field label="Remarks (optional)">
          <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button size="lg" className="sm:w-auto" disabled={busy || !supplier || total <= 0}>
          {busy ? 'Saving…' : 'Save purchase'}
        </Button>
        <p className="text-xs text-muted">Expense accounts are picked from each item&apos;s description; edit them later in ERPNext if needed. Have the paper bill? Use Capture to scan it instead.</p>
      </form>
    </EntryLayout>
  );
}
