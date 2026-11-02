'use client';

import { isRtl, t as translate, type Language, type MessageKey } from '@nextai/shared';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const Ctx = createContext<{ lang: Language; setLang: (l: Language) => void; t: (k: MessageKey, v?: Record<string, string | number>) => string }>({
  lang: 'en',
  setLang: () => {},
  t: (k) => translate('en', k),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>('en');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('nx-lang') as Language | null;
      if (saved) setLangState(saved);
    } catch {
      /* storage unavailable */
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = isRtl(lang) ? 'rtl' : 'ltr';
  }, [lang]);
  const setLang = (l: Language) => {
    setLangState(l);
    try {
      localStorage.setItem('nx-lang', l);
    } catch {
      /* ignore */
    }
  };
  return <Ctx.Provider value={{ lang, setLang, t: (k, v) => translate(lang, k, v) }}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
