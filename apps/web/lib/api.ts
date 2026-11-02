'use client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8090';

export interface Membership {
  tenantId: string;
  name: string;
  role: string | null;
}
export interface Session {
  accessToken: string;
  tenantId: string;
  userId: string;
  memberships: Membership[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Listener = (s: Session | null) => void;

/**
 * Access token lives in memory only; the refresh token is an httpOnly cookie scoped to /v1/auth
 * (or /admin/v1/auth for the admin client). On 401 we refresh once and retry.
 */
export class ApiClient {
  private session: Session | null = null;
  private refreshing: Promise<Session | null> | null = null;
  private listeners = new Set<Listener>();

  constructor(private readonly authBase: '/v1/auth' | '/admin/v1/auth') {}

  get current() {
    return this.session;
  }
  onChange(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  setSession(s: Session | null) {
    this.session = s;
    this.listeners.forEach((l) => l(s));
  }

  refresh(): Promise<Session | null> {
    this.refreshing ??= fetch(`${API_URL}${this.authBase}/refresh`, { method: 'POST', credentials: 'include' })
      .then(async (r) => (r.ok ? ((await r.json()) as Session) : null))
      .catch(() => null)
      .then((s) => {
        this.setSession(s);
        this.refreshing = null;
        return s;
      });
    return this.refreshing;
  }

  async request<T>(path: string, init: RequestInit & { json?: unknown; raw?: boolean } = {}, retry = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.session) headers.set('Authorization', `Bearer ${this.session.accessToken}`);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(init.json);
    }
    const res = await fetch(`${API_URL}${path}`, { ...init, body, headers, credentials: 'include' });
    if (res.status === 401 && retry && !path.includes('/auth/')) {
      const s = await this.refresh();
      if (s) return this.request<T>(path, init, false);
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string; details?: unknown };
      throw new ApiError(res.status, err.error ?? 'error', err.message ?? res.statusText, err.details);
    }
    if (init.raw) return res as unknown as T;
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  get<T>(path: string) {
    return this.request<T>(path);
  }
  post<T>(path: string, json?: unknown) {
    return this.request<T>(path, { method: 'POST', json: json ?? {} });
  }
  patch<T>(path: string, json: unknown) {
    return this.request<T>(path, { method: 'PATCH', json });
  }
}

export const api = new ApiClient('/v1/auth');
export const adminApi = new ApiClient('/admin/v1/auth');
