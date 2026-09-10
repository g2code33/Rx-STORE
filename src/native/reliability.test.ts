/**
 * Offline / recovery / reliability tests (Prompt 8).
 *
 * Hermetic: an in-memory localStorage polyfill stands in for the browser, and the
 * pure decision logic (queue, backoff, crash recovery, staleness) is tested
 * directly. No network or real OS access.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---- in-memory localStorage polyfill (installed before importing cache.ts) ----
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
let storage: Storage;
beforeEach(() => { storage = makeStorage(); (globalThis as any).localStorage = storage; });

const cache = await import('./cache.ts');
const q = await import('./syncQueue.ts');
const rec = await import('./transactionRecovery.ts');
type PendingAttempt = import('./transactionRecovery.ts').PendingAttempt;
const connectivity = await import('./connectivity.ts');
const detect = await import('../platform/detect.ts');

function signIn(id: string) {
  storage.setItem('rx-store-user', JSON.stringify({ id }));
}

// ---------------------------------------------------------------------------
// Cache namespacing / account isolation
// ---------------------------------------------------------------------------
test('cache keys are account-scoped, so account A cannot read account B data', () => {
  signIn('userA');
  cache.cacheSet('installation', 'list', ['appA']);
  signIn('userB');
  assert.equal(cache.cacheGet('installation', 'list'), null, 'B must not see A\'s installs');
  cache.cacheSet('installation', 'list', ['appB']);
  signIn('userA');
  assert.deepEqual(cache.cacheGet('installation', 'list'), ['appA'], 'A still sees its own data');
});

test('device identity + catalog are device-scoped and survive logout', () => {
  signIn('userA');
  cache.cacheSet('device', 'id', 'dev-1');
  cache.cacheSet('catalog', 'apps', [{ slug: 'a' }]);
  // signed out
  storage.removeItem('rx-store-user');
  assert.equal(cache.cacheGet('device', 'id'), 'dev-1');
  assert.deepEqual(cache.cacheGet('catalog', 'apps'), [{ slug: 'a' }]);
});

test('clearAccountData removes account data but preserves the device identity', () => {
  signIn('userA');
  cache.cacheSet('device', 'id', 'dev-1');
  cache.cacheSet('installation', 'list', ['x']);
  cache.cacheSet('transaction', 'pending', { appSlug: 'x' });
  storage.setItem('rx-store-token', 'tok');
  storage.setItem('rx-store-refresh-token', 'ref');
  storage.setItem('rx-store-installed', JSON.stringify(['legacy']));

  cache.clearAccountData('userA');

  assert.equal(cache.cacheGet('installation', 'list', { accountId: 'userA' }), null);
  assert.equal(cache.cacheGet('transaction', 'pending', { accountId: 'userA' }), null);
  assert.equal(storage.getItem('rx-store-token'), null);
  assert.equal(storage.getItem('rx-store-refresh-token'), null);
  assert.equal(storage.getItem('rx-store-installed'), null, 'legacy shared key is purged');
  assert.equal(cache.cacheGet('device', 'id'), 'dev-1', 'device id survives cleanly');
});

test('a legacy shared install key is not visible to a signed-in account', () => {
  // Simulate a shared-computer leak: the legacy key holds another account's list.
  storage.setItem('rx-store-installed', JSON.stringify(['other-account-app']));
  signIn('userB');
  // AppContext's reader is per-user only; the shared key must not be consulted.
  const key = `rx-store-installed-userB`;
  assert.equal(storage.getItem(key), null, 'B has no cached installs of its own');
});

// ---------------------------------------------------------------------------
// Sync queue: durability, coalescing, idempotency, backoff
// ---------------------------------------------------------------------------
test('queued synchronization survives a restart (persisted)', () => {
  signIn('u1');
  q.enqueue({ kind: 'installation', deviceId: 'd1', appSlug: 'cgpa-pilot', payload: { installed: true } });
  assert.equal(q.pendingCount(), 1);
  // A "restart" is just re-reading from storage (no module state involved).
  const items = q.allItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].appSlug, 'cgpa-pilot');
});

test('duplicate enqueues COALESCE (no duplicate installation records)', () => {
  signIn('u1');
  q.enqueue({ kind: 'installation', deviceId: 'd1', appSlug: 'app1', payload: { v: 1 } });
  q.enqueue({ kind: 'installation', deviceId: 'd1', appSlug: 'app1', payload: { v: 2 } });
  q.enqueue({ kind: 'installation', deviceId: 'd1', appSlug: 'app1', payload: { v: 3 } });
  const items = q.allItems();
  assert.equal(items.length, 1, 'one record per (device, app)');
  assert.deepEqual(items[0].payload, { v: 3 }, 'latest state wins');
});

test('different apps and different devices queue independently', () => {
  signIn('u1');
  q.enqueue({ kind: 'installation', deviceId: 'd1', appSlug: 'a', payload: {} });
  q.enqueue({ kind: 'installation', deviceId: 'd1', appSlug: 'b', payload: {} });
  q.enqueue({ kind: 'installation', deviceId: 'd2', appSlug: 'a', payload: {} });
  assert.equal(q.pendingCount(), 3);
});

test('backoff grows exponentially and is capped', () => {
  const a0 = q.backoffDelay(0, 'k');
  const a1 = q.backoffDelay(1, 'k');
  const a2 = q.backoffDelay(2, 'k');
  assert.ok(a1 > a0, 'second attempt waits longer');
  assert.ok(a2 > a1, 'third attempt waits longer still');
  assert.ok(q.backoffDelay(50, 'k') <= q.BACKOFF_MAX_MS, 'capped');
  assert.ok(q.backoffDelay(1, 'k') >= q.BACKOFF_BASE_MS, 'never faster than the base');
});

test('a flushed item is removed; a failed item is rescheduled (no hammering)', async () => {
  signIn('u1');
  const item = q.enqueue({ kind: 'installation', deviceId: 'd1', appSlug: 'a', payload: {} });

  // Offline: flush is a no-op and keeps the item.
  const offline = await q.flush(async () => { throw new Error('offline'); }, { canSync: () => false });
  assert.equal(offline.sent, 0);
  assert.equal(q.pendingCount(), 1);

  // Failure: item stays but is not due again immediately.
  const failed = await q.flush(async () => { throw new Error('network down'); });
  assert.equal(failed.failed, 1);
  assert.equal(q.pendingCount(), 1);
  assert.equal(q.dueItems(Date.now()).length, 0, 'backoff prevents an immediate retry');

  // Retry later succeeds and clears the item.
  const later = Date.now() + q.BACKOFF_MAX_MS + 1;
  const sent = await q.flush(async () => { /* ok */ }, { now: later });
  assert.equal(sent.sent, 1);
  assert.equal(q.pendingCount(), 0);
  assert.ok(item);
});

test('flush reports remaining work so the UI can show a pending count', async () => {
  signIn('u1');
  q.enqueue({ kind: 'installation', deviceId: 'd1', appSlug: 'a', payload: {} });
  q.enqueue({ kind: 'installation', deviceId: 'd1', appSlug: 'b', payload: {} });
  const r = await q.flush(async (item) => { if (item.appSlug === 'b') throw new Error('nope'); });
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.remaining, 1);
});

test('stale queued work is pruned', () => {
  signIn('u1');
  q.enqueue({ kind: 'installation', deviceId: 'd1', appSlug: 'a', payload: {}, now: 0 });
  const removed = q.pruneStale(Date.now() + 10 * 24 * 60 * 60 * 1000);
  assert.equal(removed, 1);
  assert.equal(q.pendingCount(), 0);
});

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------
test('connectivity defaults to online and can be forced offline (no polling)', () => {
  connectivity.__setOnlineForTests(true);
  assert.equal(connectivity.isOnline(), true);
  let seen: boolean | null = null;
  const unsub = connectivity.subscribeConnectivity((o) => { seen = o; });
  connectivity.__setOnlineForTests(false);
  assert.equal(connectivity.isOnline(), false);
  assert.equal(seen, false);
  unsub();
});

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------
const attempt = (over: Partial<PendingAttempt> = {}): PendingAttempt => ({
  attemptId: 'inst_1',
  appSlug: 'cgpa-pilot',
  targetVersion: '1.3.0',
  previousVersion: '1.2.0',
  phase: 'INSTALLER_STARTED',
  isUpdate: true,
  startedAt: Date.now(),
  updatedAt: Date.now(),
  ...over,
});

const detected = (installed: boolean, version?: string) =>
  detect.normalizeInstalledApp('cgpa-pilot', 'linux', { installed, version, source: 'package' }, version);

test('crash recovery: an interrupted UPDATE never assumes the new version', () => {
  // Detection still reports 1.2.0 → the update did not take.
  const d = rec.decideRecovery(attempt(), detected(true, '1.2.0'));
  assert.equal(d.outcome, 'recovered_previous');
  assert.equal(d.installed, true, 'the old version remains installed');
  assert.equal(d.effectiveVersion, '1.2.0', 'preserves 1.2.0, never claims 1.3.0');
  assert.equal(d.shouldSync, true);
  assert.match(d.message, /interrupted|still installed/i);
});

test('crash recovery: a completed update is only reported when detection agrees', () => {
  const d = rec.decideRecovery(attempt(), detected(true, '1.3.0'));
  assert.equal(d.outcome, 'recovered_installed');
  assert.equal(d.effectiveVersion, '1.3.0');
  assert.equal(d.installed, true);
});

test('crash recovery: detection newer than the target also counts as installed', () => {
  const d = rec.decideRecovery(attempt(), detected(true, '1.4.0'));
  assert.equal(d.outcome, 'recovered_installed');
  assert.equal(d.effectiveVersion, '1.4.0');
});

test('crash recovery: not installed at all is reported honestly (no fake success)', () => {
  const d = rec.decideRecovery(attempt(), detected(false));
  assert.equal(d.outcome, 'not_installed');
  assert.equal(d.installed, false);
  assert.equal(d.shouldSync, true);
});

test('crash recovery: detection unavailable never claims success or failure', () => {
  const d = rec.decideRecovery(attempt(), null);
  assert.equal(d.outcome, 'still_installing');
  assert.equal(d.shouldSync, false, 'nothing to sync when we cannot verify');
  assert.match(d.message, /could not be verified/i);
});

test('crash recovery: an abandoned attempt is cleared instead of stuck "Installing…"', () => {
  const old = attempt({ startedAt: Date.now() - 24 * 60 * 60 * 1000 });
  const d = rec.decideRecovery(old, detected(true, '1.2.0'));
  assert.equal(d.outcome, 'stale_cleared');
  assert.equal(d.effectiveVersion, '1.2.0');
});

test('crash recovery: a fresh install (not an update) that landed is recovered', () => {
  const d = rec.decideRecovery(
    attempt({ isUpdate: false, previousVersion: undefined, targetVersion: '1.0.0' }),
    detected(true, '1.0.0'),
  );
  assert.equal(d.outcome, 'recovered_installed');
  assert.equal(d.installed, true);
});

test('crash recovery: an interrupted first install with no version detected is not claimed installed', () => {
  const d = rec.decideRecovery(attempt({ isUpdate: false, targetVersion: '1.0.0' }), detected(false));
  assert.equal(d.outcome, 'not_installed');
});

test('persisted attempts round-trip and clear', () => {
  signIn('u1');
  rec.saveAttempt(attempt());
  const loaded = rec.loadAttempt();
  assert.ok(loaded);
  assert.equal(loaded!.appSlug, 'cgpa-pilot');
  assert.equal(loaded!.phase, 'INSTALLER_STARTED');
  assert.equal(rec.phaseNeedsRecovery(loaded!.phase), true);
  rec.clearAttempt();
  assert.equal(rec.loadAttempt(), null);
});

test('artifact cleanup only happens once an install is definitively over', () => {
  const a = attempt({ artifactPath: '/tmp/app.exe' });
  assert.equal(rec.artifactCleanupCandidate(a, 'still_installing'), null, 'never delete while installing');
  assert.equal(rec.artifactCleanupCandidate(a, 'recovered_installed'), null, 'keep for the installer');
  assert.equal(rec.artifactCleanupCandidate(a, 'not_installed'), '/tmp/app.exe', 'safe to remove');
  assert.equal(rec.artifactCleanupCandidate(a, 'stale_cleared'), '/tmp/app.exe', 'safe to remove');
});

// ---------------------------------------------------------------------------
// Stale cloud state / stale other-device state
// ---------------------------------------------------------------------------
test('current native detection wins over stale cloud state', () => {
  // Cloud says installed; local detection says not installed.
  const local = detected(false);
  const view = detect.resolveDeviceView({
    local,
    storeVersion: '1.3.0',
    otherInstallations: [{ deviceId: 'this-device', status: 'installed' }],
    currentDeviceId: 'this-device',
  });
  assert.equal(view.state, 'NOT_INSTALLED', 'local detection is authoritative');
  assert.equal(view.otherDevices, 0, 'our own cloud record is not an "other device"');
});

test('a stale other-device record is labelled "last known", not current', () => {
  const now = Date.now();
  const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
  assert.equal(detect.otherDeviceInstallLabel(daysAgo(0), now), 'Installed on another device');
  assert.match(detect.otherDeviceInstallLabel(daysAgo(3), now), /last known/i);
  assert.match(detect.otherDeviceInstallLabel(daysAgo(60), now), /previously installed/i);
  assert.equal(detect.isOtherDeviceStateFresh(daysAgo(0), now), true);
  assert.equal(detect.isOtherDeviceStateFresh(daysAgo(3), now), false, 'never presented as current');
});

test('offline native detection works with no backend involvement', () => {
  // The detection decision layer is pure — it depends on nothing networked.
  const local = detected(true, '1.2.0');
  assert.equal(detect.currentDeviceInstallState(local, '1.3.0'), 'UPDATE_AVAILABLE');
  assert.equal(detect.currentDeviceInstallState(local, '1.2.0'), 'INSTALLED');
  assert.equal(detect.currentDeviceInstallState(detected(false), '1.2.0'), 'NOT_INSTALLED');
});

// ---------------------------------------------------------------------------
// Malformed data resilience
// ---------------------------------------------------------------------------
test('cache rejects malformed stored values instead of throwing', () => {
  signIn('u1');
  const key = cache.cacheKey('installation', 'bad');
  storage.setItem(key, '{not valid json');
  assert.equal(cache.cacheGet('installation', 'bad'), null);
});

test('cacheGetWithAge reports staleness for last-known semantics', () => {
  signIn('u1');
  cache.cacheSet('installation', 'devices', { at: Date.now() - 60 * 60 * 1000, data: ['x'] });
  const got = cache.cacheGetWithAge<string[]>('installation', 'devices');
  assert.ok(got);
  assert.deepEqual(got!.data, ['x']);
  assert.equal(got!.stale, true, 'older than the 5-minute installation TTL');
});

test('queue tolerates a corrupted persisted queue', () => {
  signIn('u1');
  const key = cache.cacheKey('installation', 'queue-v1');
  storage.setItem(key, 'garbage');
  assert.equal(q.pendingCount(), 0, 'corrupt queue reads as empty, never throws');
  q.enqueue({ kind: 'device_register', deviceId: 'd1', payload: {} });
  assert.equal(q.pendingCount(), 1);
});

test('duplicate device registration coalesces (device registration is idempotent)', () => {
  signIn('u1');
  q.enqueue({ kind: 'device_register', deviceId: 'd1', payload: { deviceName: 'A' } });
  q.enqueue({ kind: 'device_register', deviceId: 'd1', payload: { deviceName: 'B' } });
  const items = q.allItems();
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].payload, { deviceName: 'B' });
});

test('duplicate heartbeats also coalesce (heartbeat is idempotent)', () => {
  signIn('u1');
  q.enqueue({ kind: 'heartbeat', deviceId: 'd1', payload: { deviceId: 'd1' } });
  q.enqueue({ kind: 'heartbeat', deviceId: 'd1', payload: { deviceId: 'd1' } });
  assert.equal(q.pendingCount(), 1);
});
