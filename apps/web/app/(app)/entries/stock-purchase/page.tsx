'use client';

import { useState } from 'react';
import { EntryLayout, FieldGrid, Saved, useToday } from '@/components/entry';
import { BillSummary, MedicineLines, emptyMed, medAmount, type MedLine } from '@/components/medicine-lines';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { MODES, todayIso } from '@/lib/entries';
import { money } from '@/lib/format';

/** "Paracetamol 500 · Batch B12 · Exp 03/27 · MRP 25 · Free 2" — keeps batch details on the ERPNext bill line. */
const describe = (l: MedLine) =>
  [
    l.description,
    l.batch && `Batch ${l.batch}`,
    l.expiry && `Exp ${l.expiry.slice(5)}/${l.expiry.slice(2, 4)}`,
    l.mrp && `MRP ${l.mrp}`,
    Number(l.free) > 0 && `Free ${l.free}`,
  ]
    .filter(Boolean)
    .join(' · ');

export default function StockPurchase() {
  const { me } = useAuth();
  const cur = me?.tenant.currency;
  const today = useToday();
  const [supplier, setSupplier] = useState('');
  const [billNo, setBillNo] = useState('');
  const [date, setDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState('');
  const [mode, setMode] = useState('credit');
  const [lines, setLines] = useState<MedLine[]>([emptyMed()]);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  const total = lines.reduce((s, l) => s + medAmount(l, 'purchase'), 0);
  const mrpValue = lines.reduce(
    (s, l) => s + (Number(l.qty || 0) + Number(l.free || 0)) * Number(l.mrp || 0),
    0,
  );

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.post('/v1/purchases', {
        supplier,
        billNo: billNo || undefined,
        date,
        dueDate: mode === 'credit' && dueDate ? dueDate : undefined,
        paymentMode: mode,
        itemsAccount: 'stock',
        lines: lines
          .filter((l) => l.description)
          .map((l) => ({ description: describe(l), qty: Number(l.qty), rate: Number(l.rate) })),
      });
      setSaved(
        `Stock bill from ${supplier} — ${money(total, cur)} saved${mode === 'credit' ? ' (on credit)' : ' and marked paid'}.`,
      );
      setSupplier('');
      setBillNo('');
      setDueDate('');
      setLines([emptyMed()]);
      void today.reload();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EntryLayout title="Stock purchase" kind="purchase" today={today} panel="below">
      {saved && <Saved text={saved} onDismiss={() => setSaved('')} />}
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <FieldGrid cols={3}>
          <Field label="Distributor">
            <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} required autoFocus />
          </Field>
          <Field label="Distributor invoice no.">
            <Input value={billNo} onChange={(e) => setBillNo(e.target.value)} />
          </Field>
          <Field label="Invoice date">
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
        <MedicineLines lines={lines} onChange={setLines} mode="purchase" currency={cur} />
        <BillSummary
          currency={cur}
          rows={[
            ['Stock value at MRP', mrpValue],
            ['Bill amount', total, true],
          ]}
        />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button size="lg" className="sm:w-auto" disabled={busy || !supplier || total <= 0}>
          {busy ? 'Saving…' : 'Save stock purchase'}
        </Button>
        <p className="text-xs text-muted">
          Booked as cost of goods. Batch, expiry, MRP and free quantity are kept on each bill line.
        </p>
      </form>
    </EntryLayout>
  );
}
