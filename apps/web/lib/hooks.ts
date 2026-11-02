'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ApiClient } from './api';

/** Tiny SWR-like hook: load, reload, error; keeps previous data while refreshing. */
export function useApi<T>(path: string | null, client: ApiClient = api) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await client.get<T>(path));
      setError(undefined);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [path, client]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Pull-to-refresh for the mobile shell. */
export function usePullToRefresh(onRefresh: () => Promise<unknown> | void) {
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  useEffect(() => {
    const onStart = (e: TouchEvent) => {
      startY.current = window.scrollY <= 0 ? e.touches[0]!.clientY : null;
    };
    const onMove = (e: TouchEvent) => {
      if (startY.current === null) return;
      setPull(Math.max(0, Math.min(90, e.touches[0]!.clientY - startY.current)));
    };
    const onEnd = async () => {
      if (pull > 70) await onRefresh();
      startY.current = null;
      setPull(0);
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
  }, [onRefresh, pull]);
  return pull;
}

export function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
