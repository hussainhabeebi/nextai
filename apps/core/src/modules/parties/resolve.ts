import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { logger } from '../../lib/logger.js';
import { normalizeName, similarity } from '../ocr/match.js';

export type PartyKind = 'Customer' | 'Supplier';

export interface PartyCandidate {
  /** ERPNext document name (the id used when posting). */
  name: string;
  /** What the user sees: "Orbit Travels" or "Orbit Travels (CUST-0007)". */
  label: string;
  score: number;
}

export type PartyResolution =
  /** One clear match in ERPNext — use `name`. */
  | { status: 'matched'; name: string; label: string }
  /** Several plausible matches (or one fuzzy one) — ask the user to pick. */
  | { status: 'ambiguous'; query: string; candidates: PartyCandidate[] }
  /** Nothing close in ERPNext — ask to add as new or retype. `candidates` are weak suggestions. */
  | { status: 'not_found'; query: string; candidates: PartyCandidate[] }
  /** ERPNext could not be reached — keep the typed name; posting will validate it. */
  | { status: 'unavailable'; query: string };

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE_TAIL = new RegExp(
  [
    `\\s+(?:on|dated|dt\\.?)\\s+.*$`, // "Orbit Travels on nov 18", "ABC dated 18/11"
    `\\s+(?:today|yesterday|tomorrow)$`,
    `\\s+${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?$`, // "ABC nov 18"
    `\\s+\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:\\s+\\d{4})?$`, // "ABC 18 nov"
    `\\s+\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?$`, // "ABC 18/11"
    `\\s+(?:by|via|in|through)\\s+(?:cash|bank|upi|gpay|card|cheque|check|neft|imps|transfer)$`,
  ].join('|'),
  'i',
);

/** Strip dates / payment modes the classifier sometimes leaves on the name ("Orbit Travels on nov 18"). */
export function cleanPartyName(raw: string): string {
  let s = raw.trim().replace(/[.,;:!]+$/, '');
  for (let i = 0; i < 3; i++) {
    const next = s.replace(DATE_TAIL, '').trim();
    if (next === s || !next) break;
    s = next;
  }
  return s;
}

function score(query: string, candidate: string): number {
  const q = normalizeName(query);
  const c = normalizeName(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  let s = similarity(query, candidate);
  // "orbit" → "Orbit Travels": every typed word starts a word of the candidate.
  const qt = q.split(' ');
  const ct = c.split(' ');
  if (qt.every((t) => ct.some((w) => w.startsWith(t)))) s = Math.max(s, 0.75 + 0.2 * (qt.length / ct.length));
  return Math.min(s, 0.99);
}

const FIELD: Record<PartyKind, string> = { Customer: 'customer_name', Supplier: 'supplier_name' };

/** Load the tenant's parties of one kind from ERPNext (enabled only). */
export async function listParties(c: Container, tenant: Tenant, kind: PartyKind): Promise<Array<{ name: string; display: string }>> {
  const rows = await c.erp(tenant).list<Record<string, unknown>>(kind, { fields: ['name', FIELD[kind], 'disabled'], limit: 5000 });
  return rows
    .filter((r) => !r.disabled)
    .map((r) => ({ name: String(r.name), display: String(r[FIELD[kind]] ?? r.name) }));
}

const labelOf = (p: { name: string; display: string }) => (p.display && p.display !== p.name ? `${p.display} (${p.name})` : p.name);

const STRONG = 0.9; // auto-pick when clearly ahead of the runner-up
const MARGIN = 0.08;
const PLAUSIBLE = 0.6; // offered as "did you mean"
const WEAK = 0.45; // offered as suggestions when nothing is plausible

/**
 * Resolve a typed party name against the ERPNext Customer/Supplier list.
 * Never silently invents a party: anything but a clear match comes back for the user to choose.
 */
export async function resolveParty(c: Container, tenant: Tenant, kind: PartyKind, typed: string): Promise<PartyResolution> {
  const query = cleanPartyName(typed);
  let parties: Array<{ name: string; display: string }>;
  try {
    parties = await listParties(c, tenant, kind);
  } catch (err) {
    logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'party list failed');
    return { status: 'unavailable', query };
  }

  const scored: PartyCandidate[] = parties
    .map((p) => ({ name: p.name, label: labelOf(p), score: Math.max(score(query, p.display), score(query, p.name)) }))
    .sort((a, b) => b.score - a.score);

  const exact = scored.filter((s) => s.score === 1);
  if (exact.length === 1) return { status: 'matched', name: exact[0]!.name, label: exact[0]!.label };
  if (exact.length > 1) return { status: 'ambiguous', query, candidates: exact.slice(0, 5) };

  const [top, second] = scored;
  if (top && top.score >= STRONG && (!second || top.score - second.score >= MARGIN)) {
    return { status: 'matched', name: top.name, label: top.label };
  }
  const plausible = scored.filter((s) => s.score >= PLAUSIBLE).slice(0, 5);
  if (plausible.length) return { status: 'ambiguous', query, candidates: plausible };
  return { status: 'not_found', query, candidates: scored.filter((s) => s.score >= WEAK).slice(0, 3) };
}

export const NEW_PARTY = '__new__';

/** Numbered options for the "which customer?" question: candidates, then "add new". */
export function partyChoices(res: { query: string; candidates: PartyCandidate[] }, kind: PartyKind) {
  return [
    ...res.candidates.map((cand) => ({ title: cand.label, value: cand.name })),
    { title: `➕ Add "${res.query}" as new ${kind.toLowerCase()}`, value: NEW_PARTY },
  ];
}

export function partyQuestion(res: Exclude<PartyResolution, { status: 'matched' } | { status: 'unavailable' }>, kind: PartyKind): string {
  const k = kind.toLowerCase();
  if (res.status === 'ambiguous') {
    return res.candidates.length === 1
      ? `🤔 I couldn't find "${res.query}" exactly. Did you mean this ${k}?`
      : `🤔 Which ${k} did you mean by "${res.query}"?`;
  }
  return res.candidates.length
    ? `🔍 "${res.query}" is not in your ${k} list. Did you mean one of these?`
    : `🔍 "${res.query}" is not in your ${k} list.`;
}
