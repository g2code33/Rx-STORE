/**
 * RX Store API Service
 * Central HTTP client with auth and typed endpoints.
 * Requires VITE_API_URL (the deployed backend origin). Without it every call
 * fails clearly with "API not configured" — there is NO silent mock fallback,
 * and production builds refuse to compile without it (vite.config.ts guard).
 */

import { log, recordMetric } from '../native/logger.ts';
import {
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
  clearCredentialStorage,
} from '../native/credentialStore.ts';

// import.meta.env exists in Vite builds; guard for non-bundler runtimes (Node tests).
const API_URL = ((import.meta as any).env?.VITE_API_URL || '').replace(/\/$/, '');

function getToken(): string | null {
  return getAccessToken();
}

export { getRefreshToken, setRefreshToken } from '../native/credentialStore.ts';

export function clearToken() {
  clearCredentialStorage();
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
 *
 * Failure classification (why this exists): a deployed frontend / Worker blip
 * (5xx, maintenance mode, gateway timeout) or an OFFLINE device must NEVER
 * sign the user out. Only an EXPLICIT server rejection (revoked / invalid /
 * expired session → 401/403 with INVALID_TOKEN / TOKEN_EXPIRED / AUTH_REQUIRED)
 * clears the stored credentials. Everything else keeps them, so the next
 * launch (or reconnect) restores the session silently.
 */
export type RefreshAttempt = 'ok' | 'rejected' | 'network';

let refreshInFlight: Promise<RefreshAttempt> | null = null;
export async function attemptRefresh(): Promise<RefreshAttempt> {
  if (!API_URL) return 'network'; // unconfigured API is not a session rejection
  const rt = await getRefreshToken();
  if (!rt) return 'rejected'; // no credential at all → nothing to keep
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
      if (res.ok && payload?.token) {
        setAccessToken(payload.token);
        // Rotation returns a new refresh token; persist it (this replaces the
        // old credential only after the new one is in hand — never before).
        if (payload.refreshToken) setRefreshToken(payload.refreshToken);
        return 'ok' as RefreshAttempt;
      }
      const code = payload?.error?.code || payload?.code;
      const rejected =
        res.status === 401 || res.status === 403 ||
        code === 'INVALID_TOKEN' || code === 'TOKEN_EXPIRED' || code === 'AUTH_REQUIRED';
      if (rejected) {
        // The server explicitly ended this session (sign-out elsewhere, "sign
        // out all devices", password reset, admin revocation). Credentials are
        // genuinely dead — clear them.
        clearCredentialStorage();
        return 'rejected' as RefreshAttempt;
      }
      // 5xx / maintenance / deployment blip — keep credentials, retry later.
      return 'network' as RefreshAttempt;
    } catch {
      return 'network' as RefreshAttempt;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * Back-compat wrapper: the new access token on success, null otherwise.
 * Credentials are cleared ONLY when the server explicitly rejected them.
 */
export async function refreshAccessToken(): Promise<string | null> {
  const outcome = await attemptRefresh();
  return outcome === 'ok' ? getAccessToken() : null;
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

  const isForm = typeof FormData !== 'undefined' && (options.body instanceof FormData);
  const headers: Record<string, string> = {
    ...(isForm ? {} : { 'Content-Type': 'application/json' }),
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
      // Persist the session (access token + PERSISTENT refresh credential —
      // the device stays signed in until the user signs out).
      setAccessToken(data.token);
      if (data.refreshToken) setRefreshToken(data.refreshToken);
      return data;
    },
    async register(name: string, email: string, password: string, phone?: string) {
      const data = await request<{ user: any; token: string; refreshToken?: string }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, phone, deviceId: currentDeviceId() }),
        auth: false,
      });
      setAccessToken(data.token);
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
        const refreshToken = await getRefreshToken();
        await request('/auth/logout', {
          method: 'POST',
          body: JSON.stringify({ refreshToken, allDevices: opts?.allDevices === true }),
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
    // ---- OAuth (secondary auth: Google / GitHub) ----
    /** Public: which OAuth providers are configured on this deployment. */
    async oauthProviders() {
      return request<{ google: boolean; github: boolean }>('/auth/oauth/providers', { method: 'GET', auth: false });
    },
    /** Exchange the one-time completion code (OAuth callback / sign-in code) for a normal session. */
    async oauthComplete(code: string) {
      const data = await request<{ user: any; token: string; refreshToken: string; status?: string; redirect?: string }>('/auth/oauth/complete', {
        method: 'POST',
        body: JSON.stringify({ code, deviceId: currentDeviceId() }),
        auth: false,
      });
      setAccessToken(data.token);
      if (data.refreshToken) setRefreshToken(data.refreshToken);
      return data;
    },
    /** Start CONNECTING a provider to the signed-in account → { url } to open. */
    async oauthLinkStart(provider: 'google' | 'github') {
      return request<{ url: string }>('/auth/oauth/link-start', {
        method: 'POST',
        body: JSON.stringify({ provider }),
      });
    },
    /** Confirm linking a provider identity to an existing account (password proof). */
    async oauthLinkConfirm(token: string, password: string) {
      const data = await request<{ user: any; token: string; refreshToken: string; status?: string; redirect?: string }>('/auth/oauth/link/confirm', {
        method: 'POST',
        body: JSON.stringify({ token, password, deviceId: currentDeviceId() }),
        auth: false,
      });
      setAccessToken(data.token);
      if (data.refreshToken) setRefreshToken(data.refreshToken);
      return data;
    },
    /** Issue a one-time sign-in code usable on another device/shell. */
    async oauthPairingCode() {
      return request<{ code: string; expiresInMinutes: number }>('/auth/oauth/pairing-code', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    /** Connected authentication methods (Account Security). */
    async authMethods() {
      return request<any>('/auth/methods', { method: 'GET' });
    },
    /** Disconnect a linked provider (never the last usable method). */
    async oauthDisconnect(provider: 'google' | 'github') {
      return request<{ success: boolean; disconnected: string }>(`/auth/oauth/${provider}/disconnect`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    /** Set an RX Store password for a social-only account. */
    async setPassword(password: string) {
      return request<{ success: boolean; message: string }>('/auth/set-password', {
        method: 'POST',
        body: JSON.stringify({ password }),
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

    /** The user's REAL download history (Phase 16 — honest "most used" data). */
    async appHistory() {
      return request<{ history: Array<{ appId: string; appSlug: string; appName: string; downloads: number; lastDownloadAt?: string }> }>('/users/me/app-history', { method: 'GET' });
    },
  },

  // ---- Developer Platform (Phase 11) ----
  developers: {
    /** One call for routing: application status + org summary + role. */
    async status() {
      return request<{ status: string; application: any; developer: any }>('/developers/me', { method: 'GET' });
    },
    /** Create/update the application draft. */
    async saveApplication(body: Record<string, unknown>) {
      return request<{ application: { id: string; status: string } }>('/developers/apply', { method: 'POST', body: JSON.stringify(body) });
    },
    async submitApplication() {
      return request<{ application: { id: string; status: string } }>('/developers/application/submit', { method: 'POST', body: '{}' });
    },
    /** Organization + real marketplace data (apps, releases, reviews, stats). */
    async organization() {
      return request<{ organization: any; apps: any[]; releases: any[]; reviews: any[]; stats: any }>('/developers/organization', { method: 'GET' });
    },
    async updateProfile(body: Record<string, unknown>) {
      return request<{ success: boolean }>('/developers/profile', { method: 'PATCH', body: JSON.stringify(body) });
    },
    async team() {
      return request<{ role: string; permissions: string[]; members: any[]; invitations: any[] }>('/developers/team', { method: 'GET' });
    },
    /** Returns inviteToken exactly once — only its hash is stored server-side. */
    async inviteMember(body: { email: string; role: string }) {
      return request<{ invitation: any; inviteToken: string }>('/developers/team/invite', { method: 'POST', body: JSON.stringify(body) });
    },
    async changeRole(userId: string, role: string) {
      return request<{ success: boolean }>('/developers/team/role', { method: 'PATCH', body: JSON.stringify({ userId, role }) });
    },
    async removeMember(userId: string) {
      return request<{ success: boolean }>(`/developers/team/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    },
    async cancelInvitation(invitationId: string) {
      return request<{ success: boolean }>(`/developers/team/invitations/${encodeURIComponent(invitationId)}/cancel`, { method: 'POST' });
    },
    async acceptInvitation(token: string) {
      return request<{ success: boolean; developerId: string; role: string }>('/developers/invitations/accept', { method: 'POST', body: JSON.stringify({ token }) });
    },
    async audit() {
      return request<{ events: any[] }>('/developers/audit', { method: 'GET' });
    },
    async threads() {
      return request<{ threads: any[] }>('/developers/communications', { method: 'GET' });
    },
    async createThread(body: { subject: string; message: string; relatedAppId?: string }) {
      return request<{ thread: any }>('/developers/communications/threads', { method: 'POST', body: JSON.stringify(body) });
    },
    async thread(threadId: string) {
      return request<{ thread: any; messages: any[] }>(`/developers/communications/${encodeURIComponent(threadId)}`, { method: 'GET' });
    },
    async sendMessage(threadId: string, message: string) {
      return request<{ success: boolean }>(`/developers/communications/${encodeURIComponent(threadId)}/messages`, { method: 'POST', body: JSON.stringify({ message }) });
    },
    // ---- App & release management (Phase 12) ----
    apps: {
      async list() {
        return request<{ apps: any[] }>('/developers/apps', { method: 'GET' });
      },
      async create(body: Record<string, unknown>) {
        return request<{ app: { id: string; slug: string; status: string } }>('/developers/apps', { method: 'POST', body: JSON.stringify(body) });
      },
      async get(id: string) {
        return request<{ app: any; releases: any[]; thread: any; myRole: string; permissions: string[] }>(`/developers/apps/${encodeURIComponent(id)}`, { method: 'GET' });
      },
      async update(id: string, body: Record<string, unknown>) {
        return request<{ success: boolean }>(`/developers/apps/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      },
      async submit(id: string) {
        return request<any>(`/developers/apps/${encodeURIComponent(id)}/submit`, { method: 'POST', body: '{}' });
      },
      async createRelease(appId: string, body: Record<string, unknown>) {
        return request<{ release: any }>(`/developers/apps/${encodeURIComponent(appId)}/releases`, { method: 'POST', body: JSON.stringify(body) });
      },
      async getRelease(releaseId: string) {
        return request<{ release: any; packages: any[]; app: any; thread: any }>(`/developers/releases/${encodeURIComponent(releaseId)}`, { method: 'GET' });
      },
      async updateRelease(releaseId: string, body: Record<string, unknown>) {
        return request<{ success: boolean }>(`/developers/releases/${encodeURIComponent(releaseId)}`, { method: 'PATCH', body: JSON.stringify(body) });
      },
      async submitRelease(releaseId: string) {
        return request<any>(`/developers/releases/${encodeURIComponent(releaseId)}/submit`, { method: 'POST', body: '{}' });
      },
      async withdrawRelease(releaseId: string) {
        return request<any>(`/developers/releases/${encodeURIComponent(releaseId)}/withdraw`, { method: 'POST', body: '{}' });
      },
      /** Upload with real progress (XHR). onProgress receives 0-100. */
      uploadPackage(releaseId: string, file: File, platform: string, architecture: string, onProgress?: (pct: number) => void): Promise<any> {
        return new Promise((resolve, reject) => {
          const form = new FormData();
          form.append('file', file);
          form.append('platform', platform);
          form.append('architecture', architecture);
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `${API_URL}/developers/releases/${encodeURIComponent(releaseId)}/packages`);
          const token = getToken();
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
          xhr.onload = () => {
            try {
              const j = JSON.parse(xhr.responseText);
              if (xhr.status >= 200 && xhr.status < 300) resolve(j?.data ?? j);
              else reject(new Error(j?.error?.message || j?.message || `Upload failed (${xhr.status})`));
            } catch { reject(new Error(`Upload failed (${xhr.status})`)); }
          };
          xhr.onerror = () => reject(new Error('Upload failed — network error'));
          xhr.send(form);
        });
      },
      async setDeploymentUrl(releaseId: string, url: string, platform: string) {
        return request<any>(`/developers/releases/${encodeURIComponent(releaseId)}/deployment-url`, { method: 'POST', body: JSON.stringify({ url, platform }) });
      },
    },

    /** PUBLIC developer profile (no auth needed at the HTTP level). */
    async publicProfile(developerId: string) {
      return request<{ developer: any; apps: any[] }>(`/developers/public/${encodeURIComponent(developerId)}`, { method: 'GET', auth: false });
    },

    // ---- Admin (admin token required) ----
    admin: {
      async applications(status?: string) {
        return request<{ applications: any[] }>(`/admin/developers/applications${status ? `?status=${encodeURIComponent(status)}` : ''}`, { method: 'GET' });
      },
      async application(id: string) {
        return request<{ application: any; organization: any }>(`/admin/developers/applications/${encodeURIComponent(id)}`, { method: 'GET' });
      },
      async startReview(id: string) {
        return request<any>(`/admin/developers/applications/${encodeURIComponent(id)}/review`, { method: 'POST', body: '{}' });
      },
      async approve(id: string) {
        return request<any>(`/admin/developers/applications/${encodeURIComponent(id)}/approve`, { method: 'POST', body: '{}' });
      },
      async reject(id: string, reason: string) {
        return request<any>(`/admin/developers/applications/${encodeURIComponent(id)}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
      },
      async requestChanges(id: string, reason: string) {
        return request<any>(`/admin/developers/applications/${encodeURIComponent(id)}/request-changes`, { method: 'POST', body: JSON.stringify({ reason }) });
      },
      async developers() {
        return request<{ developers: any[] }>('/admin/developers', { method: 'GET' });
      },
      async developer(id: string) {
        return request<{ developer: any }>(`/admin/developers/${encodeURIComponent(id)}`, { method: 'GET' });
      },
      async suspend(id: string, reason: string) {
        return request<any>(`/admin/developers/${encodeURIComponent(id)}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) });
      },
      async reinstate(id: string) {
        return request<any>(`/admin/developers/${encodeURIComponent(id)}/reinstate`, { method: 'POST', body: '{}' });
      },
      async threads() {
        return request<{ threads: any[] }>('/admin/developers/communications', { method: 'GET' });
      },
      async thread(threadId: string) {
        return request<{ thread: any; messages: any[] }>(`/admin/developers/communications/${encodeURIComponent(threadId)}`, { method: 'GET' });
      },
      async sendMessage(threadId: string, message: string) {
        return request<{ success: boolean }>(`/admin/developers/communications/${encodeURIComponent(threadId)}/messages`, { method: 'POST', body: JSON.stringify({ message }) });
      },
      // ---- App & release review (Phase 12) ----
      async devApps(status?: string) {
        return request<{ apps: any[] }>(`/admin/developers/apps${status ? `?status=${encodeURIComponent(status)}` : ''}`, { method: 'GET' });
      },
      async devApp(id: string) {
        return request<{ app: any; publisher: any; releases: any[] }>(`/admin/developers/apps/${encodeURIComponent(id)}`, { method: 'GET' });
      },
      async devAppAction(id: string, action: 'review' | 'approve' | 'reject' | 'request-changes' | 'suspend' | 'reinstate', reason?: string) {
        return request<any>(`/admin/developers/apps/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) });
      },
      async devReleases(status?: string) {
        return request<{ releases: any[] }>(`/admin/developers/releases${status ? `?status=${encodeURIComponent(status)}` : ''}`, { method: 'GET' });
      },
      async devRelease(id: string) {
        return request<{ release: any; packages: any[]; app: any }>(`/admin/developers/releases/${encodeURIComponent(id)}`, { method: 'GET' });
      },
      async devReleaseAction(id: string, action: 'review' | 'approve' | 'reject' | 'request-changes', reason?: string) {
        return request<any>(`/admin/developers/releases/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) });
      },
    },

    // ---- Analytics, revenue & payouts (Phase 19) ----
    finance: {
      /** Aggregated org analytics (analytics.view). Zero customer PII. */
      async analytics() {
        return request<{ totals: any; apps: any[]; revenue: any }>('/developers/analytics', { method: 'GET' });
      },
      /** Financial detail — billing.manage only (OWNER/ADMIN). */
      async revenue() {
        return request<{ revenue: any; perAppRevenue: any[]; payouts: any[]; billing: any }>('/developers/revenue', { method: 'GET' });
      },
      async requestPayout() {
        return request<{ payout: any }>('/developers/payouts/request', { method: 'POST', body: '{}' });
      },
      async updateBilling(body: { payoutDestination?: string; payoutNotes?: string; minPayoutMinor?: number }) {
        return request<{ billing: any }>('/developers/billing', { method: 'PATCH', body: JSON.stringify(body) });
      },
    },

    // ---- Review responses (Phase 17) ----
    async respondToReview(reviewId: string, response: string) {
      return request<{ success: boolean }>(`/developers/reviews/${encodeURIComponent(reviewId)}/respond`, { method: 'POST', body: JSON.stringify({ response }) });
    },

    // ---- Package security (Phase 13) ----
    security: {
      async packages(filter?: { state?: string; overall?: string }) {
        const q = new URLSearchParams();
        if (filter?.state) q.set('state', filter.state);
        if (filter?.overall) q.set('overall', filter.overall);
        const qs = q.toString();
        return request<{ packages: any[] }>(`/admin/security/packages${qs ? `?${qs}` : ''}`, { method: 'GET' });
      },
      async package(id: string) {
        return request<{ package: any; checks: any[]; history: any[]; overrides: any[] }>(`/admin/security/packages/${encodeURIComponent(id)}`, { method: 'GET' });
      },
      async override(id: string, reason: string) {
        return request<any>(`/admin/security/packages/${encodeURIComponent(id)}/override`, { method: 'POST', body: JSON.stringify({ reason }) });
      },
      async rescan(id: string) {
        return request<any>(`/admin/security/packages/${encodeURIComponent(id)}/rescan`, { method: 'POST', body: '{}' });
      },
      /** Manual security review queue (packages automated verification could not conclude on). */
      async reviewQueue() {
        return request<{ queue: any[] }>('/admin/security/review-queue', { method: 'GET' });
      },
      /** APPROVE / REJECT a pending manual review (audited decision; notes required). */
      async manualReview(id: string, decision: 'APPROVE' | 'REJECT', notes: string) {
        return request<any>(`/admin/security/packages/${encodeURIComponent(id)}/manual-review`, {
          method: 'POST',
          body: JSON.stringify({ decision, notes }),
        });
      },
    },
  },

  // Marketplace payments (Phase 18)
  payments: {
    /** Start a purchase: returns the provider's hosted authorization URL
     *  (card/mobile-money details are entered ONLY on the provider's page). */
    async initialize(appId: string) {
      return request<{ purchase: any; authorizationUrl?: string; simulated?: boolean; alreadyOwned?: boolean; entitlement?: any }>('/payments/initialize', { method: 'POST', body: JSON.stringify({ appId }) });
    },
    /** Server-side verification after returning from the provider checkout. */
    async verify(reference: string) {
      return request<{ purchase: any; entitlement?: any }>(`/payments/verify/${encodeURIComponent(reference)}`, { method: 'GET' });
    },
    async history() {
      return request<{ purchases: any[] }>('/payments/history', { method: 'GET' });
    },
    async entitlements() {
      return request<{ entitlements: any[] }>('/payments/entitlements', { method: 'GET' });
    },
  },

  // Admin developer finance (Phase 19)
  adminFinance: {
    async developerRevenue() {
      return request<{ feePercent: number; developers: any[] }>('/admin/finance/developers', { method: 'GET' });
    },
    async payouts(status?: string) {
      return request<{ payouts: any[] }>(`/admin/finance/payouts${status ? `?status=${encodeURIComponent(status)}` : ''}`, { method: 'GET' });
    },
    async processPayout(id: string, status: string, body: { reason?: string; reference?: string } = {}) {
      return request<any>(`/admin/finance/payouts/${encodeURIComponent(id)}/process`, { method: 'POST', body: JSON.stringify({ status, ...body }) });
    },
    async reconciliation() {
      return request<any>('/admin/finance/reconciliation', { method: 'GET' });
    },
  },

  // Admin payments (Phase 18)
  // ---- Admin inbox (direct-to-admin messaging) ----
  inbox: {
    /** Public: send a message straight to the admin portal inbox. */
    async submit(input: {
      type: 'ad_booking' | 'contact' | 'support' | 'sponsor';
      name: string; email: string; subject: string; message: string;
      payload?: Record<string, string>; notifySender?: boolean;
    }) {
      return request<{ id: string; adminNotified: string; senderAcknowledged: string; message: string }>('/inbox/submit', {
        method: 'POST',
        body: JSON.stringify(input),
        auth: false,
      });
    },
    list(status?: string) {
      return request<{ messages: any[]; counts: Record<string, number> }>(`/admin/inbox${status ? `?status=${encodeURIComponent(status)}` : ''}`, { method: 'GET' });
    },
    templates() {
      return request<{ templates: Array<{ id: string; label: string; subject: string }> }>('/admin/inbox/templates', { method: 'GET' });
    },
    setStatus(id: string, status: string, note?: string) {
      return request<{ success: boolean }>(`/admin/inbox/${encodeURIComponent(id)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, note }),
      });
    },
    reply(id: string, template: string, custom: string) {
      return request<{ success: boolean; delivery: string; note: string }>(`/admin/inbox/${encodeURIComponent(id)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ template, custom }),
      });
    },
  },

  adminPayments: {
    /** LIVE payment configuration state (booleans + counters, never secrets). */
    async status() {
      return request<any>('/admin/payments/status', { method: 'GET' });
    },
    async transactions(status?: string) {
      return request<{ transactions: any[] }>(`/admin/payments/transactions${status ? `?status=${encodeURIComponent(status)}` : ''}`, { method: 'GET' });
    },
    async entitlements(status?: string) {
      return request<{ entitlements: any[] }>(`/admin/payments/entitlements${status ? `?status=${encodeURIComponent(status)}` : ''}`, { method: 'GET' });
    },
    async refund(purchaseId: string) {
      return request<any>(`/admin/payments/${encodeURIComponent(purchaseId)}/refund`, { method: 'POST', body: '{}' });
    },
    async revoke(entitlementId: string, reason: string) {
      return request<any>(`/admin/payments/entitlements/${encodeURIComponent(entitlementId)}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) });
    },
  },

  // Ratings & reviews (Phase 17)
  reviews: {
    async list(slug: string, page = 1, limit = 10) {
      return request<{ reviews: any[]; summary: any; pagination: any }>(`/apps/${encodeURIComponent(slug)}/reviews?page=${page}&limit=${limit}`, { method: 'GET', auth: false });
    },
    /** Create or edit the caller's single review for the app. */
    async submit(slug: string, body: { rating: number; title?: string; comment: string; platform?: string }) {
      return request<{ review: any; edited: boolean }>(`/apps/${encodeURIComponent(slug)}/reviews`, { method: 'POST', body: JSON.stringify(body) });
    },
    async report(reviewId: string, reason: string, details?: string) {
      return request<{ report: any }>(`/reviews/${encodeURIComponent(reviewId)}/report`, { method: 'POST', body: JSON.stringify({ reason, details }) });
    },
  },

  // Developer-side package security (Phase 13 §13)
  developerSecurity: {
    async package(packageId: string) {
      return request<{ package: any; checks: any[]; overridden: boolean; overrideReason: string | null }>(`/developers/security/packages/${encodeURIComponent(packageId)}`, { method: 'GET' });
    },
  },

  // Developer community (Phase 20)
  community: {
    async categories() {
      return request<{ categories: any[] }>('/community/categories', { method: 'GET', auth: false });
    },
    async discussions(category?: string, page = 1) {
      const q = new URLSearchParams({ page: String(page) });
      if (category) q.set('category', category);
      return request<{ discussions: any[]; pagination: any }>(`/community/discussions?${q}`, { method: 'GET', auth: false });
    },
    async discussion(id: string) {
      return request<{ discussion: any; replies: any[] }>(`/community/discussions/${encodeURIComponent(id)}`, { method: 'GET', auth: false });
    },
    async createDiscussion(categoryId: string, title: string, body: string) {
      return request<{ discussion: any }>('/community/discussions', { method: 'POST', body: JSON.stringify({ categoryId, title, body }) });
    },
    async createReply(discussionId: string, body: string) {
      return request<{ reply: any }>(`/community/discussions/${encodeURIComponent(discussionId)}/replies`, { method: 'POST', body: JSON.stringify({ body }) });
    },
    async report(targetType: 'discussion' | 'reply', targetId: string, reason: string, details?: string) {
      return request<{ report: any }>('/community/reports', { method: 'POST', body: JSON.stringify({ targetType, targetId, reason, details }) });
    },
  },

  // Developer API tokens (Phase 20)
  developerTokens: {
    async list() {
      return request<{ tokens: any[] }>('/developers/tokens', { method: 'GET' });
    },
    async create(name: string, scopes: string[]) {
      return request<{ token: any; secret: string; note: string }>('/developers/tokens', { method: 'POST', body: JSON.stringify({ name, scopes }) });
    },
    async revoke(id: string) {
      return request<{ success: boolean }>(`/developers/tokens/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: '{}' });
    },
  },

  // Admin community moderation (Phase 20)
  adminCommunity: {
    async reports(status = 'open') {
      return request<{ reports: any[] }>(`/admin/community/reports?status=${encodeURIComponent(status)}`, { method: 'GET' });
    },
    async moderate(targetType: 'discussion' | 'reply', targetId: string, action: 'hide' | 'restore' | 'remove', reason: string) {
      return request<any>(`/admin/community/${targetType}/${encodeURIComponent(targetId)}/moderate`, { method: 'POST', body: JSON.stringify({ action, reason }) });
    },
  },

  // Storefront (Phase 15)
  storefront: {
    async home() {
      return request<{ hero: any; sections: Record<string, { title: string; apps: any[] }>; categories: any[] }>('/storefront/home', { method: 'GET', auth: false });
    },
    async related(slug: string) {
      return request<{ apps: any[] }>(`/apps/related/${encodeURIComponent(slug)}`, { method: 'GET', auth: false });
    },
  },

  // Admin review moderation (Phase 17)
  adminReviews: {
    async reports(status = 'open') {
      return request<{ reports: any[] }>(`/admin/reviews/reports?status=${encodeURIComponent(status)}`, { method: 'GET' });
    },
    async reviews(status?: string) {
      return request<{ reviews: any[] }>(`/admin/reviews${status ? `?status=${encodeURIComponent(status)}` : ''}`, { method: 'GET' });
    },
    async moderate(reviewId: string, action: 'hide' | 'restore' | 'remove', reason: string) {
      return request<any>(`/admin/reviews/${encodeURIComponent(reviewId)}/moderate`, { method: 'POST', body: JSON.stringify({ action, reason }) });
    },
  },

  // Admin storefront configuration (Phase 15)
  adminStorefront: {
    async get() {
      return request<{ hero: any; featured: any[] }>('/admin/storefront', { method: 'GET' });
    },
    async saveFeatured(body: Record<string, unknown>) {
      return request<any>('/admin/storefront/featured', { method: 'POST', body: JSON.stringify(body) });
    },
    async deleteFeatured(id: string) {
      return request<any>(`/admin/storefront/featured/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async saveHero(body: Record<string, unknown>) {
      return request<any>('/admin/storefront/hero', { method: 'PUT', body: JSON.stringify(body) });
    },
    async searchApps(q: string) {
      return request<{ apps: any[] }>(`/admin/storefront/apps?q=${encodeURIComponent(q)}`, { method: 'GET' });
    },
  },

  // Developer submissions (Phase 14)
  submissions: {
    async list() {
      return request<{ submissions: any[] }>('/developers/submissions', { method: 'GET' });
    },
    async get(id: string) {
      return request<any>(`/developers/submissions/${encodeURIComponent(id)}`, { method: 'GET' });
    },
    async resubmit(id: string, message?: string) {
      return request<any>(`/developers/submissions/${encodeURIComponent(id)}/resubmit`, { method: 'POST', body: JSON.stringify(message ? { message } : {}) });
    },
    /** Upload a private attachment to a communication thread (multipart). */
    uploadAttachment(threadId: string, file: File, message?: string): Promise<any> {
      return new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('file', file);
        if (message) form.append('message', message);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_URL}/developers/communications/${encodeURIComponent(threadId)}/attachments`);
        const token = getToken();
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.onload = () => {
          try {
            const j = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300) resolve(j?.data ?? j);
            else reject(new Error(j?.error?.message || j?.message || `Upload failed (${xhr.status})`));
          } catch { reject(new Error(`Upload failed (${xhr.status})`)); }
        };
        xhr.onerror = () => reject(new Error('Upload failed — network error'));
        xhr.send(form);
      });
    },
    attachmentUrl(attachmentId: string): string {
      return `${API_URL}/developers/attachments/${encodeURIComponent(attachmentId)}`;
    },
  },

  // Admin submission review (Phase 14)
  adminSubmissions: {
    async list(status?: string) {
      return request<{ submissions: any[] }>(`/admin/submissions${status ? `?status=${encodeURIComponent(status)}` : ''}`, { method: 'GET' });
    },
    async get(id: string) {
      return request<any>(`/admin/submissions/${encodeURIComponent(id)}`, { method: 'GET' });
    },
    async action(id: string, action: 'assign' | 'review' | 'approve' | 'reject' | 'request-changes' | 'suspend' | 'resume', body: Record<string, unknown> = {}) {
      return request<any>(`/admin/submissions/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
    },
    uploadAttachment(threadId: string, file: File, message?: string): Promise<any> {
      return new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('file', file);
        if (message) form.append('message', message);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_URL}/admin/developers/communications/${encodeURIComponent(threadId)}/attachments`);
        const token = getToken();
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.onload = () => {
          try {
            const j = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300) resolve(j?.data ?? j);
            else reject(new Error(j?.error?.message || j?.message || `Upload failed (${xhr.status})`));
          } catch { reject(new Error(`Upload failed (${xhr.status})`)); }
        };
        xhr.onerror = () => reject(new Error('Upload failed — network error'));
        xhr.send(form);
      });
    },
    attachmentUrl(attachmentId: string): string {
      return `${API_URL}/admin/developers/attachments/${encodeURIComponent(attachmentId)}`;
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
