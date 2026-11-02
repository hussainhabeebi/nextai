'use client';

import { UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Language, TenantSettings } from '@nextai/shared';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Badge, Card, Skeleton } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';

type SettingsDto = { name: string; country: string; currency: string; language: Language; settings: TenantSettings };
type Member = { id: string; name: string; phone: string; role: string; status: string };

export default function SettingsPage() {
  const { setLang } = useI18n();
  const { me } = useAuth();
  const isOwner = me?.user?.role === 'owner';
  const { data } = useApi<SettingsDto>('/v1/settings');
  const team = useApi<{ items: Member[] }>('/v1/team');
  const [form, setForm] = useState<SettingsDto | null>(null);
  const [msg, setMsg] = useState('');
  const [invite, setInvite] = useState({ name: '', phone: '', role: 'staff' });
  useEffect(() => setForm(data ?? null), [data]);

  const save = async () => {
    if (!form) return;
    setMsg('');
    try {
      await api.patch('/v1/settings', {
        name: form.name,
        language: form.language,
        settings: {
          autoPost: form.settings.autoPost,
          autoSendInvoices: form.settings.autoSendInvoices,
          taxId: form.settings.taxId || undefined,
          invoiceTemplate: form.settings.invoiceTemplate || undefined,
          bank: form.settings.bank,
          reminders: form.settings.reminders,
          dailySummary: form.settings.dailySummary,
        },
      });
      setLang(form.language);
      setMsg('Saved ✅');
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };
  const addMember = async () => {
    try {
      await api.post('/v1/team', invite);
      setInvite({ name: '', phone: '', role: 'staff' });
      await team.reload();
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };

  if (!form) return <Page title="Settings" back="/more"><Skeleton className="h-96" /></Page>;
  const s = form.settings;
  const set = (patch: Partial<TenantSettings>) => setForm({ ...form, settings: { ...s, ...patch } });
  return (
    <Page title="Settings" back="/more">
      <fieldset disabled={!isOwner} className="space-y-4">
        <Card className="space-y-4">
          <h2 className="font-semibold">Business profile</h2>
          <Field label="Business name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={form.country === 'IN' ? 'GSTIN' : 'TRN'}><Input value={s.taxId ?? ''} onChange={(e) => set({ taxId: e.target.value.toUpperCase() })} /></Field>
          <Field label="Language">
            <Select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value as Language })}>
              <option value="en">English</option>
              <option value="ml">മലയാളം (Malayalam)</option>
              <option value="ar">العربية (Arabic)</option>
            </Select>
          </Field>
          <Field label="Invoice design (print format)" hint="Ask your accountant to add your logo to the print format.">
            <Input value={s.invoiceTemplate ?? ''} placeholder="Standard" onChange={(e) => set({ invoiceTemplate: e.target.value })} />
          </Field>
        </Card>
        <Card className="space-y-3">
          <h2 className="font-semibold">Bank details (on invoices)</h2>
          <Input placeholder="Bank name" value={s.bank?.name ?? ''} onChange={(e) => set({ bank: { ...s.bank, name: e.target.value } })} />
          <Input placeholder="Account number" value={s.bank?.accountNo ?? ''} onChange={(e) => set({ bank: { ...s.bank, accountNo: e.target.value } })} />
          <Input placeholder={form.country === 'IN' ? 'IFSC' : 'IBAN'} value={s.bank?.ifscOrIban ?? ''} onChange={(e) => set({ bank: { ...s.bank, ifscOrIban: e.target.value } })} />
        </Card>
        <Card className="space-y-3">
          <h2 className="font-semibold">Automation</h2>
          <Toggle label="Post confirmed-quality bills automatically (skip approval)" checked={s.autoPost} onChange={(v) => set({ autoPost: v })} />
          <Toggle label="Send invoices to customers on WhatsApp" checked={s.autoSendInvoices} onChange={(v) => set({ autoSendInvoices: v })} />
          <Toggle label="Payment reminders" checked={s.reminders.enabled} onChange={(v) => set({ reminders: { ...s.reminders, enabled: v } })} />
          <Toggle label="Evening summary on WhatsApp" checked={s.dailySummary.enabled} onChange={(v) => set({ dailySummary: { ...s.dailySummary, enabled: v } })} />
        </Card>
        {isOwner && <Button size="lg" onClick={() => void save()}>Save settings</Button>}
      </fieldset>
      {msg && <p role="status" className="mt-3 text-sm">{msg}</p>}

      <Card className="mt-6 space-y-3">
        <h2 className="font-semibold">Team</h2>
        <ul className="divide-y divide-line text-sm">
          {team.data?.items.map((m) => (
            <li key={m.id} className="flex items-center justify-between py-2">
              <span>{m.name} <span className="text-muted">{m.phone}</span></span>
              <Badge tone={m.status === 'active' ? 'green' : m.status === 'disabled' ? 'red' : 'amber'}>{m.role?.replace('_', ' ')}</Badge>
            </li>
          ))}
        </ul>
        {isOwner && (
          <div className="space-y-2 border-t border-line pt-3">
            <Input placeholder="Name" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
            <Input placeholder="WhatsApp number" inputMode="tel" value={invite.phone} onChange={(e) => setInvite({ ...invite, phone: e.target.value })} />
            <Select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
              <option value="staff">Staff</option>
              <option value="tenant_accountant">Accountant</option>
            </Select>
            <Button variant="secondary" onClick={() => void addMember()} disabled={!invite.name || invite.phone.length < 8}>
              <UserPlus className="h-4 w-4" /> Add member
            </Button>
          </div>
        )}
      </Card>
    </Page>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <input type="checkbox" className="h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-full bg-line transition before:block before:h-6 before:w-6 before:rounded-full before:bg-white before:shadow before:transition checked:bg-brand checked:before:translate-x-5 rtl:checked:before:-translate-x-5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
