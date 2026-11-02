'use client';

import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Session } from './api';
import { syncQueue } from './offline-queue';

interface Me {
  user: { id: string; name: string; role: string; language: string } | null;
  tenant: { id: string; name: string; slug: string; country: 'IN' | 'AE'; currency: 'INR' | 'AED'; language: string; status: string };
}

const Ctx = createContext<{ session: Session | null; me: Me | null; switchTenant: (id: string) => Promise<void>; logout: () => Promise<void> }>({
  session: null,
  me: null,
  switchTenant: async () => {},
  logout: async () => {},
});

/** Guards the (app) group: restores the session from the refresh cookie or redirects to /login. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(api.current);
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(!!api.current);

  useEffect(() => {
    const off = api.onChange(setSession);
    return () => void off();
  }, []);
  useEffect(() => {
    // Read-only "view as tenant" from the admin console: token arrives in the URL fragment (never sent to servers).
    const m = window.location.hash.match(/^#imp=([\w-]+\.[\w-]+\.[\w-]+)$/);
    if (m) {
      const claims = JSON.parse(atob(m[1]!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { sub: string; tid: string };
      history.replaceState(null, '', window.location.pathname);
      api.setSession({ accessToken: m[1]!, tenantId: claims.tid, userId: claims.sub, memberships: [] });
      setReady(true);
      return;
    }
    if (api.current) return;
    void api.refresh().then((s) => {
      if (!s) router.replace('/login');
      setReady(true);
    });
  }, [router]);
  useEffect(() => {
    if (!session) return;
    void api.get<Me>('/v1/me').then(setMe);
    void syncQueue(session.tenantId);
    const onOnline = () => void syncQueue(session.tenantId);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [session]);

  const switchTenant = async (tenantId: string) => {
    const s = await api.post<Session>('/v1/auth/switch', { tenantId });
    api.setSession(s);
    router.refresh();
  };
  const logout = async () => {
    await api.post('/v1/auth/logout');
    api.setSession(null);
    router.replace('/login');
  };
  if (!ready || !session) return null;
  return <Ctx.Provider value={{ session, me, switchTenant, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
