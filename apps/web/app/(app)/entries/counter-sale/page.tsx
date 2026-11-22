'use client';

import { useState } from 'react';
import { EntryLayout, FieldGrid, Saved, useToday } from '@/components/entry';
import {
  BillSummary,
  MedicineLines,
  emptyMed,
  medAmount,
  monthsToExpiry,
  type MedLine,
} from '@/components/medicine-lines';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { MODES, modeLabel, todayIso } from '@/lib/entries';
import { money } from '@/lib/format';

export default function CounterSale() {
  const { me } = useAuth();
  const cur = me?.tenant.currency;
  const today = useToday();
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [doctor, setDoctor] = useState('');
  const [date, setDate] = useState(todayIso());
  const [mode, setMode] = useState('cash');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<MedLine[]>([emptyMed()]);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  const mrpTotal = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.rate || 0), 0);
  const net = lines.reduce((s, l) => s + medAmount(l, 'sale'), 0);
  const expired = lines.filter((l) => (monthsToExpiry(l.expiry) ?? 1) < 0);
  const applyDiscountToAll = (pct: string) => setLines(lines.map((l) => ({ ...l, disc: pct })));

  const submit = async () => {
    if (
      expired.length &&
      !window.confirm(
        `${expired.map((l) => l.description).join(', ')} ${expired.length > 1 ? 'are' : 'is'} past expiry. Sell anyway?`,
      )
    )
      return;
    setBusy(true);
    setErr('');
    try {
      const r = await api.post<{ total: number }>('/v1/quick-sales', {
        kind: 'counter_sale',
        party: customer || undefined,
        phone: phone || undefined,
        doctor: doctor || undefined,
        date,
        paymentMode: mode,
        reference: reference || undefined,
        lines: lines
          .filter((l) => l.description)
          .map((l) => ({
            description: l.description,
            qty: Number(l.qty),
            rate: Number(l.rate),
            discountPct: Number(l.disc) || undefined,
            batch: l.batch || undefined,
            expiry: l.expiry || undefined,
          })),
      });
      setSaved(
        `Sale to ${customer || 'walk-in customer'} — ${money(r.total, cur)} · ${mode === 'credit' ? 'on credit' : `paid by ${modeLabel(mode)}`}.`,
      );
      setCustomer('');
      setPhone('');
      setDoctor('');
      setReference('');
      setLines([emptyMed()]);
      void today.reload();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EntryLayout title="Counter sale" kind="sale" today={today} panel="below">
      {saved && <Saved text={saved} onDismiss={() => setSaved('')} />}
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <FieldGrid cols={3}>
          <Field label="Customer">
            <Input
              value={customer}
              placeholder="Walk-in customer"
              onChange={(e) => setCustomer(e.target.value)}
            />
          </Field>
          <Field label="Mobile (optional)" hint="Bill is sent on WhatsApp">
            <Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="Prescribed by (optional)">
            <Input value={doctor} placeholder="Dr…" onChange={(e) => setDoctor(e.target.value)} />
          </Field>
        </FieldGrid>
        <MedicineLines lines={lines} onChange={setLines} mode="sale" currency={cur} />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-4 sm:grid-cols-3">
            <Field label="Discount % on all">
              <Input
                inputMode="decimal"
                placeholder="e.g. 10"
                onChange={(e) => applyDiscountToAll(e.target.value)}
              />
            </Field>
            <Field label="Payment">
              <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
                <option value="credit">Credit (pay later)</option>
              </Select>
            </Field>
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>
            {mode !== 'cash' && mode !== 'credit' && (
              <Field label="Transaction ref (optional)">
                <Input value={reference} onChange={(e) => setReference(e.target.value)} />
              </Field>
            )}
          </div>
          <BillSummary
            currency={cur}
            rows={[
              ['MRP total', mrpTotal],
              ['Discount', mrpTotal - net],
              ['Net payable', net, true],
            ]}
          />
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button
          size="lg"
          className="sm:w-auto"
          disabled={busy || net <= 0 || !lines.some((l) => l.description)}
        >
          {busy ? 'Saving…' : `Save sale · ${money(net, cur)}`}
        </Button>
      </form>
    </EntryLayout>
  );
}
