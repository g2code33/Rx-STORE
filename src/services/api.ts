/**
 * RX Store API Service
 * Central HTTP client with auth, fallback to mock, and typed endpoints.
 * Set VITE_API_URL to connect to real backend; defaults to mock mode.
 */

const API_URL = import.meta.env.VITE_API_URL?.replace(/\/$/, '') || '';

function getToken(): string | null {
  return localStorage.getItem('rx-store-token');
}

function setToken(token: string) {
  localStorage.setItem('rx-store-token', token);
}

export function clearToken() {
  localStorage.removeItem('rx-store-token');
}

export const isApiConfigured = () => Boolean(API_URL);

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

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    signal: options.signal,
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `Request failed (${res.status})`;
    throw new Error(msg);
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
        body: JSON.stringify({ email, password, identifier: email }),
        auth: false,
      });
      setToken(data.token);
      return data;
    },
    async register(name: string, email: string, password: string, phone?: string) {
      const data = await request<{ user: any; token: string }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, phone }),
        auth: false,
      });
      setToken(data.token);
      return data;
    },
    async logout() {
      try {
        await request('/auth/logout', { method: 'POST' });
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
