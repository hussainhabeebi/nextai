/** Fuzzy party name matching (normalised Levenshtein + token overlap). */

const STOP = /\b(pvt|private|ltd|limited|llp|llc|fze|fzco|co|company|and|&|the|trading|traders|enterprises|est|establishment|l\.?l\.?c)\b/g;

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,'"()-]/g, ' ')
    .replace(STOP, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length]!;
}

export function similarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const lev = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  const tx = new Set(x.split(' '));
  const ty = new Set(y.split(' '));
  const inter = [...tx].filter((t) => ty.has(t)).length;
  const jac = inter / new Set([...tx, ...ty]).size;
  return Math.max(lev, jac);
}

export function bestMatch(name: string, candidates: string[], threshold = 0.82): { name: string; score: number } | undefined {
  let best: { name: string; score: number } | undefined;
  for (const c of candidates) {
    const score = similarity(name, c);
    if (!best || score > best.score) best = { name: c, score };
  }
  return best && best.score >= threshold ? best : undefined;
}
