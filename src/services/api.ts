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
      const data = await request<{ user: any; token: string; refreshToken: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        auth: false,
      });
      setToken(data.token);
      return data;
    },
    async register(name: string, email: string, password: string) {
      const data = await request<{ user: any; token: string }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, password }),
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
