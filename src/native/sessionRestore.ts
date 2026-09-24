/**
 * RX Store — startup session restoration.
 *
 * The order of operations on every launch (web, PWA, Electron, Android):
 *
 *   1. (caller) reconcile credential storage (hydrateCredentialStorage) so the
 *      durable copy (Android native / localStorage) is available.
 *   2. If an access token exists → try /users/me with it.
 *   3. If that fails (expired / invalid / rejected) → explicitly attempt a
 *      refresh (single-flight, rotating the credential).
 *   4. Refresh OK → load the profile with the fresh access token.
 *   5. Credentials are cleared ONLY when the server explicitly rejected them
 *      (revoked session / invalid credential). An expired ACCESS token is
 *      never a sign-out condition; a network failure is never a sign-out
 *      condition — the app reports `offline` and retries when connectivity
 *      returns, because the persistent refresh session is still valid.
 *
 * This module is deliberately free of React and of the API client so the whole
 * decision tree is unit-testable (see sessionRestore.test.ts, which also
 * covers the "app updated → still signed in" regressions).
 */

export type RefreshOutcome = 'ok' | 'rejected' | 'network';

export type RestoreResult =
  | { status: 'authenticated'; user: any }
  | { status: 'signed-out' }
  | { status: 'offline' };

export interface RestoreDeps {
  /** True when a (possibly expired) access token is stored. */
  hasAccessToken(): boolean;
  /** True when the long-lived refresh credential is stored. */
  hasRefreshToken(): boolean;
  /** GET the current profile; throws on failure (error may carry .status). */
  fetchMe(): Promise<any>;
  /** Single-flight, classified refresh attempt. */
  attemptRefresh(): Promise<RefreshOutcome>;
  /** Remove stored credentials (called ONLY on explicit server rejection). */
  clearCredentials(): void;
  /** True when an error is a connectivity/transient failure (not a rejection). */
  isNetworkError(e: any): boolean;
}

/**
 * Attempt to restore the authenticated session from persisted credentials.
 * Never throws — every failure maps to a typed outcome.
 */
export async function restoreSession(deps: RestoreDeps): Promise<RestoreResult> {
  // No credentials stored → nothing to restore. (First launch / signed out.)
  if (!deps.hasAccessToken() && !deps.hasRefreshToken()) {
    return { status: 'signed-out' };
  }

  // 1. Fast path: the stored access token may still be valid.
  if (deps.hasAccessToken()) {
    try {
      const me = await deps.fetchMe();
      const user = me?.user || me;
      if (user?.id) return { status: 'authenticated', user };
    } catch {
      /* expired / invalid / rejected — fall through to refresh */
    }
  }

  // 2. The access token is missing, expired or was rejected. That is NOT a
  //    sign-out: present the persistent refresh credential.
  const refresh = await deps.attemptRefresh();
  if (refresh === 'rejected') {
    // The server explicitly ended this session (sign-out on another surface,
    // "sign out all devices", password reset, admin revocation, or the
    // credential is genuinely invalid). Local credentials are dead — clear.
    deps.clearCredentials();
    return { status: 'signed-out' };
  }
  if (refresh === 'network') {
    // Offline / transient server failure (deploy blip, maintenance). KEEP the
    // credentials — the session is still valid server-side; retry later.
    return { status: 'offline' };
  }

  // 3. Refresh succeeded (credentials rotated + persisted by the caller's
  //    refresh implementation). Load the profile with the fresh access token.
  try {
    const me = await deps.fetchMe();
    const user = me?.user || me;
    if (user?.id) return { status: 'authenticated', user };
    deps.clearCredentials();
    return { status: 'signed-out' };
  } catch (e: any) {
    if (deps.isNetworkError(e)) return { status: 'offline' };
    // A fresh, server-issued access token that /users/me still rejects means
    // the session is genuinely invalid (e.g. account deleted) — clear.
    deps.clearCredentials();
    return { status: 'signed-out' };
  }
}
