/**
 * Unit tests for device identity persistence.
 *
 * Node has no browser `window`/`localStorage`, so we install a tiny in-memory
 * polyfill scoped to this test file. This lets us verify the core property that
 * matters for Prompt 2: the stable device id survives restart, refresh, and
 * logout (it is never regenerated from a login/logout event).
 *
 * Run via the repo test script:
 *   node --experimental-strip-types --test src/native/deviceIdentity.test.ts
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
  };
}

let storage: Storage;

function setWindow(s: Storage, ua = ''): void {
  // Node's global `navigator` is read-only; deviceIdentity reads `window.navigator`,
  // so we provide it on the polyfilled window object (no global overwrite).
  (globalThis as any).window = {
    localStorage: s,
    screen: { width: 1280, height: 800 },
    navigator: { userAgent: ua },
  };
  (globalThis as any).localStorage = s;
}

beforeEach(() => {
  storage = makeStorage();
  setWindow(storage);
});

// Imported after the polyfill is installed so `typeof window` resolves at call time.
const { getDeviceId, setDeviceName, clearDeviceIdentity, buildDeviceRecord, getRuntimePlatform } = await import('./deviceIdentity.ts');

test('device ID persists across multiple reads (restart/refresh)', () => {
  const id1 = getDeviceId();
  const id2 = getDeviceId();
  assert.equal(id2, id1, 'device id must be stable across reads');
});

test('device ID survives logout (clearDeviceIdentity does not regenerate it)', () => {
  const idBefore = getDeviceId();
  setDeviceName('Blessing');
  clearDeviceIdentity(); // only removes the device NAME, never the id
  const idAfter = getDeviceId();
  assert.equal(idAfter, idBefore, 'logout must not create a new device');
});

test('different installs get different device IDs', () => {
  const idA = getDeviceId();
  storage = makeStorage();
  setWindow(storage);
  const idB = getDeviceId();
  assert.notEqual(idA, idB, 'separate installs must not share a device id');
});

test('buildDeviceRecord returns a human-readable device name + stable id', () => {
  const rec = buildDeviceRecord('1.3.2');
  assert.ok(rec.deviceId);
  assert.ok(rec.deviceName, 'device name should be human-readable by default');
  assert.equal(rec.rxStoreVersion, '1.3.2');
  assert.ok(['windows', 'linux', 'android', 'web'].includes(rec.platform));
});

test('getRuntimePlatform never claims native detection on web', () => {
  setWindow(storage, 'Mozilla/5.0 Chrome/120');
  assert.equal(getRuntimePlatform(), 'web');
});
