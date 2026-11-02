'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LogoStacked } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { api, ApiError, type Session } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function LoginPage() {
  const router = useRouter();
  const { t, lang, setLang } = useI18n();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code' | 'pick'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState<Session | null>(null);

  const request = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ sent: boolean; devCode?: string }>('/v1/auth/otp/request', { phone });
      if (r.devCode) setCode(r.devCode); // development only
      setStep('code');
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    setError('');
    try {
      const s = await api.post<Session>('/v1/auth/otp/verify', { phone, code });
      api.setSession(s);
      if (s.memberships.length > 1) {
        setSession(s);
        setStep('pick');
      } else router.replace('/');
    } catch {
      setError('That code is not right or has expired.');
    } finally {
      setBusy(false);
    }
  };
  const pick = async (tenantId: string) => {
    if (tenantId !== session?.tenantId) api.setSession(await api.post<Session>('/v1/auth/switch', { tenantId }));
    router.replace('/');
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-8 px-5 py-10">
      <div className="flex justify-center">
        <LogoStacked />
      </div>
      {step === 'phone' && (
        <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void request())}>
          <Field label={t('auth.phone')} hint="We will send a 6-digit code to your WhatsApp.">
            <Input inputMode="tel" autoComplete="tel" placeholder="+91 98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} required minLength={8} />
          </Field>
          <Button size="lg" disabled={busy || phone.length < 8}>
            {t('auth.sendOtp')}
          </Button>
        </form>
      )}
      {step === 'code' && (
        <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void verify())}>
          <Field label={t('auth.code')}>
            <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required className="text-center text-2xl tracking-[0.5em]" />
          </Field>
          <Button size="lg" disabled={busy || code.length !== 6}>
            {t('auth.verify')}
          </Button>
          <button type="button" className="min-h-11 w-full text-sm text-muted" onClick={() => setStep('phone')}>
            Change number
          </button>
        </form>
      )}
      {step === 'pick' && session && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Choose a business</h2>
          {session.memberships.map((m) => (
            <Button key={m.tenantId} variant="secondary" size="lg" onClick={() => void pick(m.tenantId)}>
              {m.name}
            </Button>
          ))}
        </div>
      )}
      {error && <p role="alert" className="text-center text-sm text-red-600">{error}</p>}
      <div className="flex justify-center gap-2 text-sm">
        {(['en', 'ml', 'ar'] as const).map((l) => (
          <button key={l} onClick={() => setLang(l)} className={`min-h-11 rounded-lg px-3 ${lang === l ? 'bg-brand text-white' : 'text-muted'}`}>
            {l === 'en' ? 'English' : l === 'ml' ? 'മലയാളം' : 'العربية'}
          </button>
        ))}
      </div>
    </main>
  );
}
