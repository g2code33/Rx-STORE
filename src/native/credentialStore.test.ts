/**
 * Unit tests for the long-lived credential store (auth persistence phase).
 *
 * Verifies the Android-relevant behaviour with a FAKE native SecureStore
 * bridge (the real one is Java, on-device — see SecureStorePlugin.java):
 *   - localStorage remains the synchronous working copy everywhere
 *   - on Android every write is mirrored into native secure storage
 *   - a WebView storage loss is recovered from the native copy
 *   - v1 → v2 storage migration (localStorage-only install updated to a
 *     version with native storage) mirrors WITHOUT deleting anything first
 *   - explicit sign-out clears both copies
 *   - the "app updated" path never clears anything
 *
 * Run: node --experimental-strip-types --test src/native/credentialStore.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---- In-memory localStorage polyfill (module-scoped) ----
function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    key(i: number) { return Array.from(store.keys())[i] ?? null; },
    removeItem(k: string) { store.delete(k); },
    setItem(k: string, v: string) { store.set(k, String(v)); },
  } as Storage;
}

// Install the polyfill BEFORE importing the module under test.
const storage = makeStorage();
(globalThis as any).localStorage = storage;
(globalThis as any).window = { localStorage: storage };

const {
  ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY,
  getAccessToken, getRefreshToken, getRefreshTokenSync, setAccessToken, setRefreshToken,
  clearCredentialStorage, hydrateCredentialStorage, _internal,
} = await import('./credentialStore.ts');

/** A fake Android Keystore-backed store: a Map that records every operation. */
function fakeNativeStore() {
  const map = new Map<string, string>();
  const ops: string[] = [];
  return {
    ops,
    async get({ key }: { key: string }) { ops.push(`get:${key}`); return { value: map.get(key) ?? null }; },
    async set({ key, value }: { key: string; value: string }) { ops.push(`set:${key}`); map.set(key, value); },
    async remove({ key }: { key: string }) { ops.push(`remove:${key}`); map.delete(key); },
    dump: () => map,
  };
}

beforeEach(() => {
  storage.clear();
  _internal.setTestBridge(null);
});

// ---------------------------------------------------------------------------
// Web / Electron / PWA: localStorage is the single copy
// ---------------------------------------------------------------------------

test('web (no native bridge): credentials live in localStorage under the legacy keys', async () => {
  assert.equal(_internal.activeBridge(), null, 'no native bridge on web');
  setAccessToken('access-1');
  setRefreshToken('rxr_abc');
  assert.equal(getAccessToken(), 'access-1');
  assert.equal(getRefreshTokenSync(), 'rxr_abc');
  assert.equal(await getRefreshToken(), 'rxr_abc');
  assert.equal(storage.getItem(ACCESS_TOKEN_KEY), 'access-1', 'existing key preserved for backward compat');
  assert.equal(storage.getItem(REFRESH_TOKEN_KEY), 'rxr_abc');
});

test('explicit sign-out clears both credential copies (web)', async () => {
  setAccessToken('access-1');
  setRefreshToken('rxr_abc');
  await clearCredentialStorage();
  assert.equal(getAccessToken(), null);
  assert.equal(getRefreshTokenSync(), null);
});

// ---------------------------------------------------------------------------
// Android: native secure storage mirrors every write
// ---------------------------------------------------------------------------

test('Android: writes are mirrored into native secure storage', async () => {
  const native = fakeNativeStore();
  _internal.setTestBridge(native as any);
  setAccessToken('access-android');
  setRefreshToken('rxr_android_secret');
  // localStorage (synchronous working copy)…
  assert.equal(getAccessToken(), 'access-android');
  assert.equal(getRefreshTokenSync(), 'rxr_android_secret');
  // …and the native Keystore-backed copy (authoritative).
  await new Promise((r) => setTimeout(r, 0)); // fire-and-forget mirror
  assert.equal(native.dump().get(REFRESH_TOKEN_KEY), 'rxr_android_secret');
  assert.equal(native.dump().get(ACCESS_TOKEN_KEY), 'access-android');
});

test('Android: getRefreshToken prefers the durable native copy', async () => {
  const native = fakeNativeStore();
  _internal.setTestBridge(native as any);
  await native.set({ key: REFRESH_TOKEN_KEY, value: 'rxr_native_truth' });
  storage.setItem(REFRESH_TOKEN_KEY, 'rxr_stale_local');
  assert.equal(await getRefreshToken(), 'rxr_native_truth');
});

test('Android: explicit sign-out clears localStorage AND native storage', async () => {
  const native = fakeNativeStore();
  _internal.setTestBridge(native as any);
  setAccessToken('a');
  setRefreshToken('rxr_x');
  await new Promise((r) => setTimeout(r, 0));
  await clearCredentialStorage();
  assert.equal(getAccessToken(), null);
  assert.equal(getRefreshTokenSync(), null);
  assert.equal(native.dump().get(REFRESH_TOKEN_KEY), undefined, 'native copy removed');
  assert.equal(native.dump().get(ACCESS_TOKEN_KEY), undefined, 'native access copy removed');
});

// ---------------------------------------------------------------------------
// Survival + recovery (the scenarios that would otherwise sign users out)
// ---------------------------------------------------------------------------

test('Android: WebView storage loss is recovered from the native copy (app relaunch)', async () => {
  const native = fakeNativeStore();
  _internal.setTestBridge(native as any);
  setAccessToken('access-keep');
  setRefreshToken('rxr_survives');
  await new Promise((r) => setTimeout(r, 0));
  // "App restarted and the WebView lost its storage" — native copy intact.
  storage.clear();
  await hydrateCredentialStorage();
  assert.equal(getRefreshTokenSync(), 'rxr_survives', 'credential restored into localStorage');
  assert.equal(getAccessToken(), 'access-keep', 'access token restored too');
});

test('v1 → v2 migration: an updated install mirrors its localStorage credential into native storage (nothing deleted)', async () => {
  const native = fakeNativeStore();
  // v1 install: credential ONLY in localStorage (no native bridge existed).
  storage.setItem(REFRESH_TOKEN_KEY, 'rxr_from_v1');
  storage.setItem(ACCESS_TOKEN_KEY, 'access_from_v1');
  // v2 install boots: native bridge now available, native store empty.
  _internal.setTestBridge(native as any);
  await hydrateCredentialStorage();
  assert.equal(native.dump().get(REFRESH_TOKEN_KEY), 'rxr_from_v1', 'mirrored into secure storage');
  assert.equal(storage.getItem(REFRESH_TOKEN_KEY), 'rxr_from_v1', 'old copy still present — never pre-deleted');
});

test('an application update never clears credentials (no wipe path exists)', async () => {
  const native = fakeNativeStore();
  _internal.setTestBridge(native as any);
  setAccessToken('access-before-update');
  setRefreshToken('rxr_before_update');
  await new Promise((r) => setTimeout(r, 0));
  // The "update" is just a relaunch of the new version: hydrate (reconcile).
  await hydrateCredentialStorage();
  assert.equal(getRefreshTokenSync(), 'rxr_before_update', 'still signed in after the update');
  assert.equal(getAccessToken(), 'access-before-update');
  assert.equal(native.dump().get(REFRESH_TOKEN_KEY), 'rxr_before_update');
  // Rotation (what a refresh does) replaces the credential in ONE step —
  // the new value is written before the old one is gone.
  setRefreshToken('rxr_rotated');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(storage.getItem(REFRESH_TOKEN_KEY), 'rxr_rotated');
  assert.equal(native.dump().get(REFRESH_TOKEN_KEY), 'rxr_rotated');
});

test('hydrate is a no-op when both copies agree (steady state)', async () => {
  const native = fakeNativeStore();
  _internal.setTestBridge(native as any);
  setRefreshToken('rxr_same');
  await new Promise((r) => setTimeout(r, 0));
  await hydrateCredentialStorage();
  assert.equal(getRefreshTokenSync(), 'rxr_same');
  assert.equal(native.dump().get(REFRESH_TOKEN_KEY), 'rxr_same');
});
