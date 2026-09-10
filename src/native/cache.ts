/**
 * RX Store — namespaced, account-scoped persistent cache.
 *
 * PROBLEM THIS SOLVES
 * The app previously scattered `localStorage` keys across contexts, and several
 * read paths fell back to a SHARED legacy key (`rx-store-installed`). That meant
 * account A's installed-app list could appear for account B after a user switch
 * on the same installation (a real leak on shared computers).
 *
 * DESIGN
 *   - Every key is namespaced:  rx:<ns>:<scope>:<account|anon>:<name>
 *   - `ns`      — one of the five state domains (below)
 *   - `scope`   — 'u' (account-scoped) or 'd' (device-scoped, survives logout)
 *   - `account` — the signed-in user id, or `anon` when signed out
 *
 * The five domains are kept SEPARATE so clearing one never destroys another:
 *   auth         — session/token metadata (never the token itself; see note)
 *   catalog      — the public app listing cache (not account-specific)
 *   device       — the stable device identity (DEVICE-scoped: survives logout)
 *   installation — this account's last-known installation state
 *   transaction  — in-flight install/update attempts (for crash recovery)
 *
 * NOTE ON TOKENS: access/refresh tokens remain in their existing keys
 * (`rx-store-token`, `rx-store-refresh-token`) because the API client and native
 * shells already depend on them; `clearAccountData()` removes them on logout so
 * a different account can never inherit them.
 */

export type CacheNamespace = 'auth' | 'catalog' | 'device' | 'installation' | 'transaction';
export type CacheScope = 'account' | 'device';

/** Duration hints (ms) — callers decide how strict to be. */
export const CACHE_TTL = {
  catalog: 24 * 60 * 60 * 1000,        // the public listing rarely changes
  devices: 5 * 60 * 1000,              // account device list
  installations: 5 * 60 * 1000,        // other-device last-known state
  transaction: 30 * 60 * 1000,         // an in-flight attempt older than this is stale
} as const;

const PREFIX = 'rx';
const ANON = 'anon';

/** Explicit namespace -> TTL map (kept separate from the exported CACHE_TTL so
 *  the singular namespace names can never silently miss a plural TTL key). */
const NAMESPACE_TTL: Record<CacheNamespace, number> = {
  auth: 0,
  catalog: CACHE_TTL.catalog,
  device: 0,
  installation: CACHE_TTL.installations,
  transaction: CACHE_TTL.transaction,
};

/** Keys that must survive logout (device identity, public catalog). */
const DEVICE_SCOPED: CacheNamespace[] = ['device', 'catalog'];

/** Raw storage access that never throws (private mode / quota / SSR). */
function store(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** The current account id from the cached profile, or null. */
export function currentAccountId(): string | null {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem('rx-store-user');
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u && typeof u.id === 'string' && u.id ? u.id : null;
  } catch {
    return null;
  }
}

/** Build a fully-qualified, namespaced key. */
export function cacheKey(ns: CacheNamespace, name: string, opts?: { accountId?: string | null; scope?: CacheScope }): string {
  const scope: CacheScope = opts?.scope || (DEVICE_SCOPED.includes(ns) ? 'device' : 'account');
  const account = scope === 'device' ? 'device' : (opts?.accountId ?? currentAccountId() ?? ANON);
  return `${PREFIX}:${ns}:${scope === 'device' ? 'd' : 'u'}:${account}:${name}`;
}

/** Read + JSON-parse a namespaced value. Returns null when absent or malformed. */
export function cacheGet<T = any>(ns: CacheNamespace, name: string, opts?: { accountId?: string | null }): T | null {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(cacheKey(ns, name, opts));
    if (raw == null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Write a namespaced value. Never throws (quota / private mode are non-fatal). */
export function cacheSet(ns: CacheNamespace, name: string, value: unknown, opts?: { accountId?: string | null }): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(cacheKey(ns, name, opts), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function cacheRemove(ns: CacheNamespace, name: string, opts?: { accountId?: string | null }): void {
  const s = store();
  if (!s) return;
  try { s.removeItem(cacheKey(ns, name, opts)); } catch { /* ignore */ }
}

/**
 * Read a value with its timestamp wrapper `{ at, data }` and report staleness.
 * Used for "last known" semantics (other-device state, catalog).
 */
export function cacheGetWithAge<T = any>(ns: CacheNamespace, name: string, opts?: { accountId?: string | null }):
  { data: T; at: number; ageMs: number; stale: boolean } | null {
  const wrapped = cacheGet<{ at?: number; data?: T } | T>(ns, name, opts);
  if (wrapped == null) return null;
  const at = typeof (wrapped as any)?.at === 'number' ? (wrapped as any).at : 0;
  const data = at ? (wrapped as any).data as T : wrapped as T;
  const ageMs = at ? Date.now() - at : Number.MAX_SAFE_INTEGER;
  const ttl = NAMESPACE_TTL[ns] ?? 0;
  return { data, at, ageMs, stale: ttl > 0 ? ageMs > ttl : false };
}

/** Every key belonging to a namespace (any scope/account) — for clearing. */
export function keysForNamespace(ns: CacheNamespace): string[] {
  const s = store();
  if (!s) return [];
  const out: string[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(`${PREFIX}:${ns}:`)) out.push(k);
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * Clear one domain. `accountId` restricts to a single account (used on logout);
 * omit it to clear every account's data in that domain.
 */
export function clearNamespace(ns: CacheNamespace, opts?: { accountId?: string | null }): number {
  const s = store();
  if (!s) return 0;
  const scope: CacheScope = DEVICE_SCOPED.includes(ns) ? 'device' : 'account';
  const prefix = opts?.accountId
    ? cacheKey(ns, '', { accountId: opts.accountId }).replace(/:$/, '').split(':').slice(0, 5).join(':') + ':'
    : `${PREFIX}:${ns}:${scope === 'device' ? 'd' : 'u'}:`;
  let removed = 0;
  try {
    for (const k of keysForNamespace(ns)) {
      if (k.startsWith(prefix)) { s.removeItem(k); removed++; }
    }
  } catch { /* ignore */ }
  return removed;
}

/**
 * Remove ALL account-scoped data (auth/installation/transaction) for the given
 * account (or the current one). Device identity and the public catalog survive so
 * a returning user keeps the same device id and an offline catalog.
 *
 * This is the "prevent account A's state from appearing for account B" guard.
 */
export function clearAccountData(accountId?: string | null): void {
  const s = store();
  const id = accountId ?? currentAccountId();
  if (s) {
    // Namespaced domains (account-scoped only).
    clearNamespace('auth', id ? { accountId: id } : undefined);
    clearNamespace('installation', id ? { accountId: id } : undefined);
    clearNamespace('transaction', id ? { accountId: id } : undefined);
    // Session tokens + the cached profile are not namespaced (compat with the
    // existing API client / native shells) — remove them explicitly.
    try {
      s.removeItem('rx-store-token');
      s.removeItem('rx-store-refresh-token');
      s.removeItem('rx-store-user');
      // Legacy shared keys that could leak between accounts.
      s.removeItem('rx-store-installed');
      if (id) s.removeItem(`rx-store-installed-${id}`);
    } catch { /* ignore */ }
  }
}

/** A snapshot of what is cached (for diagnostics + tests). */
export interface CacheSnapshot {
  accountId: string | null;
  namespaces: Record<CacheNamespace, number>;
  deviceId: string | null;
  hasSession: boolean;
}

export function cacheSnapshot(): CacheSnapshot {
  const s = store();
  const namespaces: Record<CacheNamespace, number> = {
    auth: keysForNamespace('auth').length,
    catalog: keysForNamespace('catalog').length,
    device: keysForNamespace('device').length,
    installation: keysForNamespace('installation').length,
    transaction: keysForNamespace('transaction').length,
  };
  return {
    accountId: currentAccountId(),
    namespaces,
    deviceId: s ? s.getItem('rx-store-device-id') : null,
    hasSession: s ? !!s.getItem('rx-store-token') : false,
  };
}
