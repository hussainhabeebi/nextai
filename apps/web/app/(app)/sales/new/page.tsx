'use client';

import { useState } from 'react';
import { EntryLayout, FieldGrid, Saved, useToday } from '@/components/entry';
import { LineItems, cleanLines, emptyLine, lineTotal } from '@/components/line-items';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { todayIso } from '@/lib/entries';
import { money } from '@/lib/format';

export default function NewInvoice() {
  const { me } = useAuth();
  const today = useToday();
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [date, setDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState([emptyLine()]);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const total = lineTotal(lines);

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.post('/v1/invoices', { customer, customerPhone: phone || undefined, date, dueDate: dueDate || undefined, lines: cleanLines(lines) });
      setSaved(`Invoice for ${customer} — ${money(total, me?.tenant.currency)} saved and being posted.${phone ? ' It will be sent on WhatsApp.' : ''}`);
      setCustomer('');
      setPhone('');
      setDueDate('');
      setLines([emptyLine()]);
      void today.reload();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EntryLayout title="Sales invoice" kind="sale" today={today}>
      {saved && <Saved text={saved} onDismiss={() => setSaved('')} />}
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <FieldGrid>
          <Field label="Customer">
            <Input value={customer} onChange={(e) => setCustomer(e.target.value)} required autoFocus />
          </Field>
          <Field label="Customer WhatsApp" hint="Optional — we send the invoice PDF here">
            <Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="Invoice date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Due date (optional)">
            <Input type="date" value={dueDate} min={date} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </FieldGrid>
        <LineItems lines={lines} onChange={setLines} currency={me?.tenant.currency} />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button size="lg" className="sm:w-auto" disabled={busy || !customer || total <= 0}>
          {busy ? 'Saving…' : phone ? 'Save & send' : 'Save invoice'}
        </Button>
      </form>
    </EntryLayout>
  );
}
