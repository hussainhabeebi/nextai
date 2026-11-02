import type { Language } from '../constants.js';
import { RTL_LANGUAGES } from '../constants.js';
import { ar } from './ar.js';
import { en, type MessageKey } from './en.js';
import { ml } from './ml.js';

export type { MessageKey };
export const dictionaries: Record<Language, Partial<Record<MessageKey, string>>> = { en, ml, ar };

/** Translate with {var} interpolation; falls back to English. */
export function t(lang: Language, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template = dictionaries[lang]?.[key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export const isRtl = (lang: Language): boolean => RTL_LANGUAGES.includes(lang);
