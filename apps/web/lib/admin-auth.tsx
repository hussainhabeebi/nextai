'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { adminApi } from './api';

type AdminSession = { accessToken: string; role: 'super_admin' | 'reviewer' | 'support' };
const Ctx = createContext<{ role: AdminSession['role'] | null; logout: () => Promise<void> }>({ role: null, logout: async () => {} });

/** Separate session from the customer app: admin cookie on /admin/v1/auth, admin-audience JWT in memory. */
export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [role, setRole] = useState<AdminSession['role'] | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const off = adminApi.onChange((s) => setRole((s as unknown as AdminSession | null)?.role ?? null));
    if (path === '/admin/login') {
      setReady(true);
      return () => void off();
    }
    if (adminApi.current) {
      setRole((adminApi.current as unknown as AdminSession).role);
      setReady(true);
    } else
      void adminApi.refresh().then((s) => {
        if (!s) router.replace('/admin/login');
        setReady(true);
      });
    return () => void off();
  }, [path, router]);
  const logout = async () => {
    await adminApi.post('/admin/v1/auth/logout');
    adminApi.setSession(null);
    router.replace('/admin/login');
  };
  if (!ready) return null;
  return <Ctx.Provider value={{ role, logout }}>{children}</Ctx.Provider>;
}
export const useAdmin = () => useContext(Ctx);
