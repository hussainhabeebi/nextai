'use client';

import { MessageCircle, UserPlus } from 'lucide-react';
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
type Member = { id: string; name: string; phone: string; email?: string | null; role: string; status: string };
type Invite = { text: string; whatsappLink: string; sentByNextAi?: boolean };

export default function SettingsPage() {
  const { setLang } = useI18n();
  const { me } = useAuth();
  const isOwner = me?.user?.role === 'owner';
  const { data } = useApi<SettingsDto>('/v1/settings');
  const team = useApi<{ items: Member[] }>('/v1/team');
  const [form, setForm] = useState<SettingsDto | null>(null);
  const [msg, setMsg] = useState('');
  const [invite, setInvite] = useState({ name: '', phone: '', email: '', role: 'staff' });
  const [shareFor, setShareFor] = useState<{ name: string; invite: Invite } | null>(null);
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
          whatsappNumber: form.settings.whatsappNumber || undefined,
          taxRegime: form.settings.taxRegime,
          taxCalendar: form.settings.taxCalendar,
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
      const m = await api.post<Member & { invite: Invite }>('/v1/team', { ...invite, email: invite.email || undefined });
      setShareFor({ name: m.name, invite: m.invite });
      setInvite({ name: '', phone: '', email: '', role: 'staff' });
      await team.reload();
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };
  const showInvite = async (m: Member) => setShareFor({ name: m.name, invite: await api.get<Invite>(`/v1/team/${m.id}/invite`) });

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
          <Field label="NextAi WhatsApp number" hint="The number your team sends bills to. Shown in staff invites.">
            <Input inputMode="tel" value={s.whatsappNumber ?? ''} placeholder="+91 …" onChange={(e) => set({ whatsappNumber: e.target.value })} />
          </Field>
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
          <Toggle label="Daily briefing on WhatsApp" checked={s.dailySummary.enabled} onChange={(v) => set({ dailySummary: { ...s.dailySummary, enabled: v } })} />
          <Field label="Briefing time">
            <Select value={s.dailySummary.hourLocal} onChange={(e) => set({ dailySummary: { ...s.dailySummary, hourLocal: Number(e.target.value) } })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>)}
            </Select>
          </Field>
        </Card>
        <Card className="space-y-3">
          <h2 className="font-semibold">Tax deadlines</h2>
          <p className="text-sm text-muted">We warn you and your accountant 7 and 2 days before each filing, with what's still missing.</p>
          {form.country === 'IN' ? (
            <>
              <Field label="GST registration">
                <Select value={s.taxRegime} onChange={(e) => set({ taxRegime: e.target.value as TenantSettings['taxRegime'] })}>
                  <option value="gst_regular">Regular</option>
                  <option value="gst_composition">Composition</option>
                  <option value="none">Not registered</option>
                </Select>
              </Field>
              {s.taxRegime === 'gst_regular' && (
                <Field label="GST returns">
                  <Select value={s.taxCalendar.gstFiling} onChange={(e) => set({ taxCalendar: { ...s.taxCalendar, gstFiling: e.target.value as 'monthly' | 'quarterly' } })}>
                    <option value="monthly">Monthly (GSTR-1 by 11th, GSTR-3B by 20th)</option>
                    <option value="quarterly">Quarterly (QRMP)</option>
                  </Select>
                </Field>
              )}
              <Toggle label="We deduct TDS" checked={s.taxCalendar.tds} onChange={(v) => set({ taxCalendar: { ...s.taxCalendar, tds: v } })} />
              <Toggle label="Advance tax instalments" checked={s.taxCalendar.advanceTax} onChange={(v) => set({ taxCalendar: { ...s.taxCalendar, advanceTax: v } })} />
              <Toggle label="Accounts are audited (ITR due 31 Oct)" checked={s.taxCalendar.taxAudit} onChange={(v) => set({ taxCalendar: { ...s.taxCalendar, taxAudit: v } })} />
            </>
          ) : (
            <>
              <Field label="Tax registration">
                <Select value={s.taxRegime} onChange={(e) => set({ taxRegime: e.target.value as TenantSettings['taxRegime'] })}>
                  <option value="vat_ct">VAT and Corporate Tax</option>
                  <option value="vat">VAT only</option>
                  <option value="none">Not registered</option>
                </Select>
              </Field>
              <Field label="VAT return period">
                <Select value={s.taxCalendar.vatPeriod} onChange={(e) => set({ taxCalendar: { ...s.taxCalendar, vatPeriod: e.target.value as 'monthly' | 'quarterly' } })}>
                  <option value="quarterly">Quarterly</option>
                  <option value="monthly">Monthly</option>
                </Select>
              </Field>
              {s.taxCalendar.vatPeriod === 'quarterly' && (
                <Field label="Your VAT quarters end in" hint="As shown on your FTA certificate">
                  <Select value={s.taxCalendar.vatQuarterEnds[0]} onChange={(e) => { const f = Number(e.target.value); set({ taxCalendar: { ...s.taxCalendar, vatQuarterEnds: [f, f + 3, f + 6, f + 9] } }); }}>
                    <option value={1}>Jan, Apr, Jul, Oct</option>
                    <option value={2}>Feb, May, Aug, Nov</option>
                    <option value={3}>Mar, Jun, Sep, Dec</option>
                  </Select>
                </Field>
              )}
            </>
          )}
        </Card>
        {isOwner && <Button size="lg" onClick={() => void save()}>Save settings</Button>}
      </fieldset>
      {msg && <p role="status" className="mt-3 text-sm">{msg}</p>}

      <OnlinePayments isOwner={isOwner} />

      <Card className="mt-6 space-y-3">
        <h2 className="font-semibold">Team</h2>
        <ul className="divide-y divide-line text-sm">
          {team.data?.items.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                {m.name} <span className="text-muted">{m.phone}</span>
                {m.status === 'invited' && <span className="block text-xs text-muted">Invited: hasn&apos;t logged in or messaged yet</span>}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {isOwner && m.status === 'invited' && (
                  <Button variant="ghost" onClick={() => void showInvite(m)}>Invite</Button>
                )}
                <Badge tone={m.status === 'active' ? 'green' : m.status === 'disabled' ? 'red' : 'amber'}>{m.role === 'tenant_accountant' ? 'accountant' : m.role}</Badge>
              </span>
            </li>
          ))}
        </ul>
        {isOwner && (
          <div className="space-y-2 border-t border-line pt-3">
            <Input placeholder="Name" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
            <Input placeholder="WhatsApp number" inputMode="tel" value={invite.phone} onChange={(e) => setInvite({ ...invite, phone: e.target.value })} />
            <Input placeholder="Email (optional: for login codes until WhatsApp is connected)" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
            <Select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
              <option value="staff">Staff</option>
              <option value="tenant_accountant">Accountant</option>
            </Select>
            <Button variant="secondary" onClick={() => void addMember()} disabled={!invite.name || invite.phone.length < 8}>
              <UserPlus className="h-4 w-4" /> Add member
            </Button>
          </div>
        )}
        {shareFor && (
          <div className="space-y-2 rounded-xl bg-brand-light p-3 text-sm text-brand-dark" role="status">
            <p className="font-semibold">
              {shareFor.invite.sentByNextAi ? `Invite sent to ${shareFor.name} on WhatsApp ✅` : `Send ${shareFor.name} their invite from your WhatsApp:`}
            </p>
            <p className="whitespace-pre-line">{shareFor.invite.text}</p>
            <a href={shareFor.invite.whatsappLink} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand px-4 font-medium text-white">
              <MessageCircle className="h-4 w-4" /> Send on WhatsApp
            </a>
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

type Rzp = { available: boolean; connected: boolean; keyId: string | null; mode: 'live' | 'test' | null; webhookUrl: string; account: string | null; modeOfPayment: string | null };
type Connected = { webhook: { url: string; secret: string; events: string[] }; erp: { ledger: string; modeOfPayment: string | null; razorpaySettings: string } };

/** Razorpay: payment links on invoices and reminders; payments are recorded in ERPNext automatically. */
function OnlinePayments({ isOwner }: { isOwner: boolean }) {
  const { data, reload } = useApi<Rzp>('/v1/payments/razorpay');
  const [keys, setKeys] = useState({ keyId: '', keySecret: '' });
  const [done, setDone] = useState<Connected | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!data || !data.available) return null;
  const connect = async () => {
    setErr('');
    setBusy(true);
    try {
      setDone(await api.post<Connected>('/v1/payments/razorpay', keys));
      setKeys({ keyId: '', keySecret: '' });
      await reload();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!confirm('Stop adding payment links to invoices and reminders?')) return;
    await api.request('/v1/payments/razorpay', { method: 'DELETE' });
    setDone(null);
    await reload();
  };
  return (
    <Card className="mt-6 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Online payments (Razorpay)</h2>
        {data.connected && <Badge tone={data.mode === 'live' ? 'green' : 'amber'}>{data.mode === 'live' ? 'Live' : 'Test mode'}</Badge>}
      </div>
      <p className="text-sm text-muted">
        Customers get a UPI / card payment link with every invoice and reminder. When they pay, the payment is recorded against the invoice in your books and they get a receipt.
      </p>
      {done && (
        <div className="space-y-2 rounded-xl bg-brand-light p-3 text-sm text-brand-dark">
          <p className="font-semibold">Connected ✅ One more step in Razorpay:</p>
          <p>Razorpay → Account &amp; Settings → Webhooks → Add new webhook</p>
          <p>URL: <code className="break-all">{done.webhook.url}</code></p>
          <p>Secret: <code className="break-all">{done.webhook.secret}</code> (shown only now)</p>
          <p>Event: <code>payment_link.paid</code></p>
          <p className="pt-1">
            ERPNext: ledger <b>{done.erp.ledger}</b>{done.erp.modeOfPayment ? <>, mode of payment <b>{done.erp.modeOfPayment}</b></> : null}
            {done.erp.razorpaySettings === 'updated' ? ', Razorpay Settings filled in.' : '. (ERPNext\'s own Razorpay app isn\'t installed; NextAi handles the links.)'}
          </p>
        </div>
      )}
      {data.connected ? (
        <div className="space-y-2 text-sm">
          <p>Key: <code>{data.keyId}</code></p>
          {data.account && <p>Payments go to <b>{data.account}</b> until Razorpay settles them to your bank.</p>}
          {!done && <p className="text-muted">Webhook URL: <code className="break-all">{data.webhookUrl}</code></p>}
          {isOwner && <Button variant="secondary" onClick={() => void disconnect()}>Disconnect</Button>}
        </div>
      ) : isOwner ? (
        <div className="space-y-2">
          <Field label="Key ID" hint="Razorpay → Account & Settings → API Keys">
            <Input placeholder="rzp_live_…" value={keys.keyId} onChange={(e) => setKeys({ ...keys, keyId: e.target.value.trim() })} />
          </Field>
          <Field label="Key secret">
            <Input type="password" autoComplete="off" value={keys.keySecret} onChange={(e) => setKeys({ ...keys, keySecret: e.target.value.trim() })} />
          </Field>
          <Button onClick={() => void connect()} disabled={busy || keys.keyId.length < 8 || keys.keySecret.length < 8}>
            {busy ? 'Connecting…' : 'Connect Razorpay'}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted">Ask the owner to connect Razorpay.</p>
      )}
      {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
    </Card>
  );
}
