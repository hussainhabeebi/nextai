'use client';

import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EntryLayout, FieldGrid, Saved, useToday } from '@/components/entry';
import { LineItems, cleanLines, emptyLine, lineTotal, type Line } from '@/components/line-items';
import { BillSummary } from '@/components/medicine-lines';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { MODES, modeLabel, todayIso } from '@/lib/entries';
import { money } from '@/lib/format';

const SERVICES = [
  'Consultation',
  'Review visit',
  'Procedure',
  'Injection',
  'Dressing',
  'Lab test',
  'ECG',
  'Nebulisation',
  'Medicines',
];
const DOCTOR_KEY = 'nextai.clinic.doctor';

export default function PatientBill() {
  const { me } = useAuth();
  const cur = me?.tenant.currency;
  const today = useToday();
  const [patient, setPatient] = useState('');
  const [phone, setPhone] = useState('');
  const [doctor, setDoctor] = useState('');
  const [date, setDate] = useState(todayIso());
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [discount, setDiscount] = useState('');
  const [mode, setMode] = useState('cash');
  const [reference, setReference] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  // Most clinics bill for the same doctor all day: remember the last one on this device.
  useEffect(() => {
    try {
      setDoctor(localStorage.getItem(DOCTOR_KEY) ?? '');
    } catch {
      /* storage unavailable */
    }
  }, []);

  const subtotal = lineTotal(lines);
  const disc = Math.min(Number(discount) || 0, subtotal);
  const net = subtotal - disc;

  const addService = (name: string) => {
    const empty = lines.findIndex((l) => !l.description);
    if (empty >= 0) setLines(lines.map((l, i) => (i === empty ? { ...l, description: name } : l)));
    else setLines([...lines, { ...emptyLine(), description: name }]);
  };

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.post<{ total: number }>('/v1/quick-sales', {
        kind: 'patient_bill',
        party: patient,
        phone: phone || undefined,
        doctor: doctor || undefined,
        date,
        discount: disc,
        paymentMode: mode,
        reference: reference || undefined,
        lines: cleanLines(lines),
      });
      try {
        if (doctor) localStorage.setItem(DOCTOR_KEY, doctor);
      } catch {
        /* storage unavailable */
      }
      setSaved(
        `Bill for ${patient} — ${money(r.total, cur)} · ${mode === 'credit' ? 'due from patient' : `paid by ${modeLabel(mode)}`}.`,
      );
      setPatient('');
      setPhone('');
      setDiscount('');
      setReference('');
      setLines([emptyLine()]);
      void today.reload();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EntryLayout title="Patient bill" kind="sale" today={today}>
      {saved && <Saved text={saved} onDismiss={() => setSaved('')} />}
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <FieldGrid>
          <Field label="Patient name">
            <Input value={patient} onChange={(e) => setPatient(e.target.value)} required autoFocus />
          </Field>
          <Field label="Mobile (optional)" hint="Bill is sent on WhatsApp">
            <Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="Doctor">
            <Input value={doctor} placeholder="Dr…" onChange={(e) => setDoctor(e.target.value)} />
          </Field>
          <Field label="Visit date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </FieldGrid>

        <div>
          <p className="mb-2 text-sm font-medium">Quick add</p>
          <div className="flex flex-wrap gap-2">
            {SERVICES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => addService(s)}
                className="inline-flex min-h-9 items-center gap-1 rounded-full border border-line bg-bg px-3 text-sm hover:border-brand hover:text-brand"
              >
                <Plus className="h-3.5 w-3.5" /> {s}
              </button>
            ))}
          </div>
        </div>

        <LineItems lines={lines} onChange={setLines} currency={cur} itemLabel="Service / item" />

        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-4 sm:grid-cols-2">
            <Field label="Discount (amount)">
              <Input
                inputMode="decimal"
                placeholder="0"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </Field>
            <Field label="Payment">
              <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
                <option value="credit">Due — patient pays later</option>
              </Select>
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
              ['Subtotal', subtotal],
              ['Discount', disc],
              ['Net payable', net, true],
            ]}
          />
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button size="lg" className="sm:w-auto" disabled={busy || !patient || net <= 0}>
          {busy ? 'Saving…' : `Save bill · ${money(net, cur)}`}
        </Button>
      </form>
    </EntryLayout>
  );
}
