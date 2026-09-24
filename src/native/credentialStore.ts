/**
 * RX Store — long-lived authentication credential storage.
 *
 * THE CONTRACT
 *   Once a user signs in on a device, that device stays signed in until the
 *   user explicitly signs out (or the server revokes the session). The
 *   credential that makes this possible is the REFRESH token; the access token
 *   is a short-lived cache.
 *
 * WHERE IT LIVES
 *   - web / PWA : browser localStorage (per-origin; survives reloads, browser
 *                 restarts and new frontend deployments — the keys never move).
 *   - Electron  : the app:// origin's localStorage, which Chromium persists in
 *                 the user-data directory — OUTSIDE the installation
 *                 directory, so replacing binaries/resources during an update
 *                 never touches the session.
 *   - Android   : mirrored into native, Keystore-encrypted storage (the
 *                 SecureStore Capacitor plugin in android/app). The app's
 *                 private data directory survives APK updates, reboots and
 *                 process death; the native copy also protects against WebView
 *                 storage loss. localStorage stays as the synchronous working
 *                 copy the API client reads.
 *
 * VERSION MIGRATION (auth storage v1 → v2)
 *   v1 kept the credential only in localStorage. `hydrateCredentialStorage()`
 *   runs once at startup and reconciles BOTH copies in the safe order:
 *     1. read both,
 *     2. if localStorage lost it but native still has it → restore into
 *        localStorage (survives WebView storage clears),
 *     3. if localStorage has it but native does not (a v1 install updated to
 *        v2) → mirror it into native storage.
 *   The old copy is only ever removed AFTER the new copy exists (rotation
 *   replaces it wholesale, sign-out clears both). An application update NEVER
 *   clears this storage — updates and authentication are unrelated.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

export const ACCESS_TOKEN_KEY = 'rx-store-token';
export const REFRESH_TOKEN_KEY = 'rx-store-refresh-token';

export interface SecureStorePlugin {
  get(input: { key: string }): Promise<{ value: string | null }>;
  set(input: { key: string; value: string }): Promise<void>;
  remove(input: { key: string }): Promise<void>;
}

const SecureStore = registerPlugin<SecureStorePlugin>('SecureStore');

/** Test seam: when set, used instead of the Capacitor bridge (tests only). */
let testBridge: SecureStorePlugin | null = null;

/** Android native shell only — web/PWA/Electron use localStorage directly. */
function androidBridge(): SecureStorePlugin | null {
  if (testBridge) return testBridge;
  try {
    if (typeof window === 'undefined') return null;
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return null;
    return SecureStore;
  } catch {
    return null;
  }
}

// ---- synchronous localStorage working copy (never throws) --------------------

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota/private mode */ }
}
function lsRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// ---- public API ---------------------------------------------------------------

/** The short-lived access token (synchronous — used by the API client). */
export function getAccessToken(): string | null {
  return lsGet(ACCESS_TOKEN_KEY);
}

/** The long-lived refresh credential (synchronous localStorage copy). */
export function getRefreshTokenSync(): string | null {
  return lsGet(REFRESH_TOKEN_KEY);
}

/** The refresh credential, preferring the durable native copy on Android. */
export async function getRefreshToken(): Promise<string | null> {
  const bridge = androidBridge();
  if (bridge) {
    try {
      const res = await bridge.get({ key: REFRESH_TOKEN_KEY });
      if (res && typeof res.value === 'string' && res.value) return res.value;
    } catch { /* fall back to localStorage */ }
  }
  return lsGet(REFRESH_TOKEN_KEY);
}

/** Persist the access token (localStorage always; native mirror on Android). */
export function setAccessToken(token: string): void {
  lsSet(ACCESS_TOKEN_KEY, token);
  const bridge = androidBridge();
  if (bridge) void bridge.set({ key: ACCESS_TOKEN_KEY, value: token }).catch(() => {});
}

/**
 * Persist the refresh credential. localStorage is written synchronously (the
 * API client reads it immediately); the native copy is mirrored best-effort.
 */
export function setRefreshToken(token: string): void {
  lsSet(REFRESH_TOKEN_KEY, token);
  const bridge = androidBridge();
  if (bridge) void bridge.set({ key: REFRESH_TOKEN_KEY, value: token }).catch(() => {});
}

/** Remove BOTH credential copies (explicit sign-out / server rejection only). */
export async function clearCredentialStorage(): Promise<void> {
  lsRemove(ACCESS_TOKEN_KEY);
  lsRemove(REFRESH_TOKEN_KEY);
  const bridge = androidBridge();
  if (bridge) {
    await bridge.remove({ key: REFRESH_TOKEN_KEY }).catch(() => {});
    await bridge.remove({ key: ACCESS_TOKEN_KEY }).catch(() => {});
  }
}

/**
 * Startup reconciliation (see the version-migration note above). Runs BEFORE
 * anything reads credentials. No-op off Android, where localStorage is the
 * only copy. Never deletes a credential — it only copies a missing half so the
 * durable copy always wins.
 */
export async function hydrateCredentialStorage(): Promise<void> {
  const bridge = androidBridge();
  if (!bridge) return;
  const lsRefresh = lsGet(REFRESH_TOKEN_KEY);
  let nativeRefresh: string | null = null;
  try {
    const res = await bridge.get({ key: REFRESH_TOKEN_KEY });
    nativeRefresh = (res && typeof res.value === 'string' && res.value) || null;
  } catch { nativeRefresh = null; }

  if (!lsRefresh && nativeRefresh) {
    // WebView storage was cleared/lost — the native copy survives. Restore.
    lsSet(REFRESH_TOKEN_KEY, nativeRefresh);
    try {
      const res = await bridge.get({ key: ACCESS_TOKEN_KEY });
      const access = (res && typeof res.value === 'string' && res.value) || null;
      if (access) lsSet(ACCESS_TOKEN_KEY, access);
    } catch { /* access token is optional */ }
  } else if (lsRefresh && !nativeRefresh) {
    // v1 → v2 migration: an install that only knew localStorage was updated.
    // Mirror the credential into secure native storage; the localStorage copy
    // stays in place (it is replaced on rotation, never pre-deleted).
    try {
      await bridge.set({ key: REFRESH_TOKEN_KEY, value: lsRefresh });
      const access = lsGet(ACCESS_TOKEN_KEY);
      if (access) await bridge.set({ key: ACCESS_TOKEN_KEY, value: access });
    } catch { /* native unavailable — localStorage still works */ }
  }
}

// ---- internal / test seam ------------------------------------------------------

/** @internal test-only: substitute the native bridge (used by unit tests). */
export const _internal = {
  setTestBridge(bridge: SecureStorePlugin | null): void {
    testBridge = bridge;
  },
  activeBridge(): SecureStorePlugin | null {
    return androidBridge();
  },
};
