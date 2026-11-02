'use client';

import { api } from './api';

/** IndexedDB queue for captures taken offline; synced when back online. */
const DB = 'nextai-offline';
const STORE = 'captures';

export interface QueuedCapture {
  id?: number;
  tenantId: string;
  files: Array<{ name: string; type: string; data: Blob }>;
  createdAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const enqueueCapture = (c: Omit<QueuedCapture, 'id'>) => tx('readwrite', (s) => s.add(c));
export const listQueued = () => tx<QueuedCapture[]>('readonly', (s) => s.getAll() as IDBRequest<QueuedCapture[]>);
const remove = (id: number) => tx('readwrite', (s) => s.delete(id));

export async function uploadCapture(files: Array<{ name: string; type: string; data: Blob }>) {
  const form = new FormData();
  for (const f of files) form.append('file', f.data, f.name);
  return api.request<{ items: Array<{ documentId?: string; duplicate?: boolean }> }>('/v1/capture', { method: 'POST', body: form });
}

/** Upload everything queued for the current tenant. Returns number synced. */
export async function syncQueue(tenantId: string): Promise<number> {
  if (typeof indexedDB === 'undefined' || !navigator.onLine) return 0;
  let n = 0;
  for (const q of await listQueued()) {
    if (q.tenantId !== tenantId) continue; // never upload one business's capture into another
    try {
      await uploadCapture(q.files);
      await remove(q.id!);
      n++;
    } catch {
      break;
    }
  }
  return n;
}
