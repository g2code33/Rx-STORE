/**
 * RX Store API Service
 * Central HTTP client with auth, fallback to mock, and typed endpoints.
 * Set VITE_API_URL to connect to real backend; defaults to mock mode.
 */

import { log, recordMetric } from '../native/logger.ts';

const API_URL = import.meta.env.VITE_API_URL?.replace(/\/$/, '') || '';

function getToken(): string | null {
  return localStorage.getItem('rx-store-token');
}

function setToken(token: string) {
  localStorage.setItem('rx-store-token', token);
}

/** Refresh token (rotated server-side). Only its presence is persisted. */
export function getRefreshToken(): string | null {
  return localStorage.getItem('rx-store-refresh-token');
}
export function setRefreshToken(token: string | null) {
  try {
    if (token) localStorage.setItem('rx-store-refresh-token', token);
    else localStorage.removeItem('rx-store-refresh-token');
  } catch { /* storage unavailable */ }
}

export function clearToken() {
  localStorage.removeItem('rx-store-token');
  try { localStorage.removeItem('rx-store-refresh-token'); } catch { /* ignore */ }
}

export const isApiConfigured = () => Boolean(API_URL);

/** The stable per-install device id (kept in sync with src/native/deviceIdentity). */
function currentDeviceId(): string | undefined {
  try { return localStorage.getItem('rx-store-device-id') || undefined; } catch { return undefined; }
}

/**
 * Single-flight refresh: rotates the refresh token and returns a new access
 * token. Concurrent callers share one in-flight request so we never replay a
 * (single-use) refresh token — replay would be rejected by the server.
 */
let refreshInFlight: Promise<string | null> | null = null;
export async function refreshAccessToken(): Promise<string | null> {
  if (!API_URL) return null;
  const rt = getRefreshToken();
  if (!rt) return null;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      const json = await res.json().catch(() => null);
      const payload = json?.data || json;
      if (!res.ok || !payload?.token) { clearToken(); return null; }
      setToken(payload.token);
      // Rotation returns a new refresh token; persist it.
      if (payload.refreshToken) setRefreshToken(payload.refreshToken);
      return payload.token as string;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

type ApiOptions = {
  auth?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

async function request<T>(
  path: string,
  options: RequestInit & ApiOptions = {},
): Promise<T> {
  if (!API_URL) throw new Error('API not configured');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (options.auth !== false) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  let res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    signal: options.signal,
  });

  // A 401 on an authenticated request may just mean the access token expired.
  // Refresh once (rotating the refresh token) and retry the original request.
  if (res.status === 401 && options.auth !== false && !(options as any)._retried) {
    const fresh = await refreshAccessToken();
    if (fresh) {
      headers['Authorization'] = `Bearer ${fresh}`;
      res = await fetch(`${API_URL}${path}`, { ...options, headers, signal: options.signal });
    }
  }

  const data = await res.json().catch(() => null);
  // Correlate client and server logs using the response's request id.
  const requestId = res.headers.get('X-Request-Id') || data?.error?.requestId || undefined;

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `Request failed (${res.status})`;
    const code = data?.error?.code;
    // Authentication failures are an observable category (Prompt 9 §6).
    if (res.status === 401 || res.status === 403) {
      recordMetric('auth_failure');
      log.warn('auth_failure', `Authentication rejected (${res.status})`, { requestId, state: code, path });
    } else {
      log.warn('request_failed', `Request failed (${res.status})`, { requestId, state: code, path });
    }
    const err: any = new Error(msg);
    err.code = code;
    err.requestId = requestId;
    err.status = res.status;
    throw err;
  }
  // API wraps in { success, data }
  if (data && typeof data === 'object' && 'data' in data && 'success' in data) {
    return data.data as T;
  }
  return data as T;
}

// ---- typed endpoints ----

export interface ApiApp {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  rating: number;
  downloadCount: number;
  platforms: string[];
  price: string;
  priceAmount?: number;
}

export const api = {
  auth: {
    async login(email: string, password: string) {
      // email param can be email or phone — backend handles both
      const data = await request<{ user: any; token: string; refreshToken: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, identifier: email, deviceId: currentDeviceId() }),
        auth: false,
      });
      setToken(data.token);
      if (data.refreshToken) setRefreshToken(data.refreshToken);
      return data;
    },
    async register(name: string, email: string, password: string, phone?: string) {
      const data = await request<{ user: any; token: string; refreshToken?: string }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, phone, deviceId: currentDeviceId() }),
        auth: false,
      });
      setToken(data.token);
      if (data.refreshToken) setRefreshToken(data.refreshToken);
      return data;
    },
    /** Rotate the refresh token and issue a new access token. */
    async refresh() {
      const token = await refreshAccessToken();
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      return { token };
    },
    async logout(opts?: { allDevices?: boolean }) {
      try {
        await request('/auth/logout', {
          method: 'POST',
          body: JSON.stringify({ refreshToken: getRefreshToken(), allDevices: opts?.allDevices === true }),
        });
      } finally {
        clearToken();
      }
    },
    async me() {
      return request<{ user: any }>('/users/me', { method: 'GET' });
    },
    async updateProfile(updates: { name?: string; email?: string; preferences?: Record<string, boolean> }) {
      return request<{ user: any }>('/users/me', {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
    },
    async forgotPassword(email: string) {
      return request<{ success: boolean; message: string; resetToken?: string }>('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }), auth: false });
    },
    async resetPassword(token: string, password: string) {
      return request<any>('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }), auth: false });
    },
  },

  apps: {
    async list(params?: { category?: string; search?: string; sort?: string; page?: number; limit?: number }) {
      const qs = new URLSearchParams();
      if (params?.category) qs.set('category', params.category);
      if (params?.search) qs.set('search', params.search);
      if (params?.sort) qs.set('sort', params.sort);
      if (params?.page) qs.set('page', String(params.page));
      if (params?.limit) qs.set('limit', String(params.limit));
      const q = qs.toString() ? `?${qs}` : '';
      return request<{ apps: ApiApp[]; pagination: any }>(`/apps${q}`, { method: 'GET', auth: false });
    },
    async detail(slug: string) {
      return request<any>(`/apps/${slug}`, { method: 'GET', auth: false });
    },
    async reviews(slug: string) {
      return request<any[]>(`/apps/${slug}/reviews`, { method: 'GET', auth: false });
    },
    async categories() {
      return request<any[]>('/categories', { method: 'GET', auth: false });
    },
  },

  ai: {
    async chat(message: string, context?: any, signal?: AbortSignal, provider?: string) {
      return request<{ response: string; suggestions?: string[]; provider?: string }>('/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ message, context, provider }),
        signal,
      });
    },
    // Streaming chat — SSE from the Worker. onDelta receives the full text-so-far
    // on every token; resolves with the final text. Feels instant vs one slow blob.
    async chatStream(message: string, onDelta: (fullText: string) => void, signal?: AbortSignal): Promise<string> {
      if (!API_URL) throw new Error('API not configured');
      const res = await fetch(`${API_URL}/ai/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, stream: true }),
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`Stream failed: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let full = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') { try { await reader.cancel(); } catch {} continue; }
          try {
            const j = JSON.parse(payload);
            const d = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
            if (d) { full += d; onDelta(full); }
          } catch { /* keep-alive / partial chunks */ }
        }
      }
      if (!full.trim()) throw new Error('Empty stream');
      return full;
    },
    async recommend(payload: any) {
      return request<{ recommendations: any[] }>('/ai/recommend', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    async providers() {
      return request<{ active: string; providers: any[] }>('/ai/providers', { method: 'GET', auth: false });
    },
    async updateAISettings(provider: string, model?: string, apiKey?: string) {
      return request<any>('/admin/ai/settings', { method: 'PUT', body: JSON.stringify({ provider, model, apiKey }) });
    },
  },

  payments: {
    async initialize(payload: any) {
      return request<any>('/payments/initialize', { method: 'POST', body: JSON.stringify(payload) });
    },
    async verify(reference: string) {
      return request<any>(`/payments/verify/${reference}`, { method: 'GET' });
    },
  },

  devices: {
    /** Register/upsert the current device for the signed-in user (idempotent). */
    async register(device: {
      deviceId: string; deviceName: string; platform?: string; deviceType?: string; osVersion?: string; rxStoreVersion?: string; appVersion?: string;
    }) {
      return request<{ device: any }>('/devices/register', { method: 'POST', body: JSON.stringify(device) });
    },
    /** Update `last_seen_at` (and version) for the current device. */
    async heartbeat(deviceId: string, rxStoreVersion?: string, appVersion?: string) {
      return request<{ updated: boolean }>('/devices/heartbeat', { method: 'POST', body: JSON.stringify({ deviceId, rxStoreVersion, appVersion }) });
    },
    /** List the user's own devices; `currentDeviceId` flags the current device. */
    async list(currentDeviceId?: string) {
      const q = currentDeviceId ? `?currentDeviceId=${encodeURIComponent(currentDeviceId)}` : '';
      return request<{ devices: any[]; currentDeviceId?: string }>(`/devices${q}`, { method: 'GET' });
    },
    /** Revoke one of the user's devices (does NOT uninstall its applications). */
    async revoke(deviceId: string) {
      return request<{ revoked: boolean; deviceId: string }>(`/devices/${deviceId}/revoke`, { method: 'POST' });
    },
    /** Report the current device's installation state for a single app. */
    async reportInstallation(payload: {
      deviceId: string; appSlug: string; installed: boolean; installedVersion?: string; status?: string; detectionSource?: string; platform?: string;
    }) {
      return request<{ installation: any }>('/devices/installations', { method: 'POST', body: JSON.stringify(payload) });
    },
    /** List the user's installations across all their devices. */
    async listInstallations() {
      return request<{ installations: any[] }>('/devices/installations', { method: 'GET' });
    },
  },
};

export { API_URL };

// ---- Public site settings (Admin → Settings toggles) ----
let settingsCache: { at: number; data: Record<string, string> } | null = null;

/** Public-safe settings from GET /settings. Never throws; cached 30s. */
export async function getPublicSettings(force = false): Promise<Record<string, string>> {
  if (!isApiConfigured()) return {};
  if (!force && settingsCache && Date.now() - settingsCache.at < 30_000) return settingsCache.data;
  try {
    const res = await fetch(`${API_URL}/settings`);
    const j = await res.json();
    const data = (j?.data && typeof j.data === 'object') ? j.data : {};
    settingsCache = { at: Date.now(), data };
    return data;
  } catch {
    return settingsCache?.data || {};
  }
}

/** Call after an admin saves settings so storefront consumers re-fetch. */
export function invalidatePublicSettings() { settingsCache = null; }
