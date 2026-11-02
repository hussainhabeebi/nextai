'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LogoStacked } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { adminApi, ApiError, type Session } from '@/lib/api';

type LoginResp = { accessToken?: string; role?: string; totpSetupRequired?: boolean; otpauthUrl?: string; setupToken?: string };

export default function AdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [setup, setSetup] = useState<{ url: string; token: string } | null>(null);
  const [err, setErr] = useState('');

  const done = (r: LoginResp) => {
    adminApi.setSession(r as unknown as Session);
    router.replace('/admin');
  };
  const submit = async () => {
    setErr('');
    try {
      if (setup) return done(await adminApi.post<LoginResp>('/admin/v1/auth/totp/enroll', { setupToken: setup.token, totp }));
      const r = await adminApi.post<LoginResp>('/admin/v1/auth/login', { email, password, totp: needTotp ? totp : undefined });
      if (r.totpSetupRequired) setSetup({ url: r.otpauthUrl!, token: r.setupToken! });
      else done(r);
    } catch (e) {
      const ae = e as ApiError;
      if (ae.code === 'totp_required') setNeedTotp(true);
      else setErr(ae.message);
    }
  };
  const secret = setup ? new URL(setup.url).searchParams.get('secret') : null;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-5">
      <div className="flex justify-center"><LogoStacked /></div>
      <h1 className="text-center text-lg font-semibold">Platform admin</h1>
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
        {!setup && (
          <>
            <Field label="Email"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          </>
        )}
        {setup && (
          <div className="space-y-2 rounded-xl border border-line bg-card p-3 text-sm">
            <p className="font-medium">Set up two-factor authentication</p>
            <p className="text-muted">Add this key to your authenticator app, or open the link on your phone:</p>
            <code className="block break-all rounded bg-bg p-2 text-xs">{secret}</code>
            <a className="text-brand underline" href={setup.url}>Open in authenticator</a>
          </div>
        )}
        {(needTotp || setup) && (
          <Field label="6-digit code from your authenticator">
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} required />
          </Field>
        )}
        <Button size="lg">{setup ? 'Verify & continue' : 'Sign in'}</Button>
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
      </form>
    </main>
  );
}
