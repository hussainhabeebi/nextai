import type { ReactNode } from 'react';

export function Table<T>({ rows, cols, empty = 'Nothing here.' }: { rows: T[] | undefined; cols: Array<{ h: string; c: (r: T) => ReactNode; className?: string }>; empty?: string }) {
  if (!rows) return <div className="h-32 animate-pulse rounded-xl bg-line/60" />;
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-card">
      <table className="w-full text-sm">
        <thead className="bg-bg text-xs text-muted">
          <tr>{cols.map((c) => <th key={c.h} className="whitespace-nowrap px-3 py-2 text-start font-medium">{c.h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-bg/60">
              {cols.map((c) => <td key={c.h} className={`px-3 py-2 ${c.className ?? ''}`}>{c.c(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const Stat = ({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) => (
  <div className="rounded-xl border border-line bg-card p-4">
    <p className="text-xs text-muted">{label}</p>
    <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
    {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
  </div>
);

export const H1 = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="mb-5 flex items-center justify-between gap-3">
    <h1 className="text-2xl font-bold">{children}</h1>
    {action}
  </div>
);
