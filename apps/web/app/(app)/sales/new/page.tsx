'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';

export default function NewInvoice() {
  const router = useRouter();
  const { me } = useAuth();
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [lines, setLines] = useState([{ description: '', qty: '1', rate: '' }]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const total = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.rate || 0), 0);

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.post('/v1/invoices', {
        customer,
        customerPhone: phone || undefined,
        lines: lines.filter((l) => l.description && Number(l.rate) >= 0).map((l) => ({ description: l.description, qty: Number(l.qty), rate: Number(l.rate) })),
      });
      router.push('/sales');
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="New invoice" back="/sales">
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Field label="Customer">
          <Input value={customer} onChange={(e) => setCustomer(e.target.value)} required />
        </Field>
        <Field label="Customer WhatsApp (to send the invoice)">
          <Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        {lines.map((l, i) => (
          <Card key={i} className="space-y-2">
            <Input placeholder="Item / service" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} required />
            <div className="grid grid-cols-[1fr_2fr_auto] gap-2">
              <Input inputMode="decimal" aria-label="Qty" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              <Input inputMode="decimal" aria-label="Rate" placeholder="Rate" value={l.rate} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} required />
              <Button type="button" variant="ghost" size="icon" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))} disabled={lines.length === 1}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </Card>
        ))}
        <Button type="button" variant="secondary" onClick={() => setLines([...lines, { description: '', qty: '1', rate: '' }])}>
          <Plus className="h-4 w-4" /> Add line
        </Button>
        <p className="text-end text-lg font-bold">Total {money(total, me?.tenant.currency)}</p>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button size="lg" disabled={busy || !customer || total <= 0}>Create & send</Button>
      </form>
    </Page>
  );
}
