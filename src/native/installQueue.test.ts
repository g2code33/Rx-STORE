/**
 * Install queue tests (Phase 16).
 *
 * Hermetic: a scriptable fake runner (no network, no coordinator) drives the
 * queue through every state; localStorage is an in-memory polyfill. Verifies
 * the full happy path, sequential processing, failure identification, retry,
 * cancel semantics, persistence/rehydration (interrupted items never become
 * "installed"), offline pausing, and duplicate protection.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---- localStorage polyfill (must exist before importing the queue) ----
function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear() { m.clear(); },
    getItem(k) { return m.has(k) ? m.get(k)! : null; },
    key(i) { return Array.from(m.keys())[i] ?? null; },
    removeItem(k) { m.delete(k); },
    setItem(k, v) { m.set(k, String(v)); },
  } as Storage;
}

let storage: Storage;
let online = true;
const savedLocation = { href: 'https://rxstore.test/' };

beforeEach(() => {
  storage = makeStorage();
  (globalThis as any).localStorage = storage;
  online = true;
  (globalThis as any).window = {
    location: savedLocation,
    open: () => null,
    navigator: { userAgent: 'test' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as any).__setOnlineForTests?.(online);
});

const { createInstallQueueForTests, __setInstallQueueForTests } = await import('./installQueue.ts');
const connectivity = await import('./connectivity.ts');

/** Scriptable fake runner: `plan` queues (state, payload) emissions. */
function fakeRunner(plan: Array<(api: any) => Promise<any>>): {
  runner: any; calls: string[];
} {
  let idx = 0;
  const calls: string[] = [];
  return {
    calls,
    runner: {
      async run(input: any) {
        const slug = input.slug;
        calls.push(`start:${slug}`);
        const step = plan[Math.min(idx, plan.length - 1)];
        idx++;
        const result = await step(input);
        calls.push(`end:${slug}:${result.state}`);
        return result;
      },
    },
  };
}

const okFlow = async (input: any) => {
  input.onState('downloading');
  input.onProgress(45);
  input.onProgress(100);
  input.onState('verifying');
  input.onState('installing');
  return { ok: true, state: 'installed' as const, version: '2.0.0' };
};

const waitFor = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** Invoke a deferred-release captured inside a promise executor (TS can't see
 *  the assignment, hence the cast). */
function fire(fn: unknown, arg: any = {}): void {
  (fn as ((a: any) => void) | null)?.(arg);
}

// ---------------------------------------------------------------------------
// Happy path + states + progress
// ---------------------------------------------------------------------------

test('full flow: queued → downloading (progress) → verifying → installing → installed', async () => {
  const f = fakeRunner([okFlow]);
  const q = createInstallQueueForTests(f.runner);
  const events: Array<{ slug: string; state: any; progress?: number }> = [];
  q.subscribe(() => {
    const item = q.getSnapshot()[0];
    if (item && (!events.length || events[events.length - 1].state !== item.state || events[events.length - 1].progress !== item.progress)) {
      events.push({ slug: item.slug, state: item.state, progress: item.progress });
    }
  });
  q.enqueue({ slug: 'clinic', name: 'Clinic Pro' });
  await waitFor(30);
  const item = q.getSnapshot()[0];
  assert.equal(item.state, 'installed');
  assert.equal(item.version, '2.0.0');
  const states = events.map((e) => e.state);
  assert.ok(states.includes('queued'));
  assert.ok(states.includes('downloading'));
  assert.ok(states.includes('verifying'));
  assert.ok(states.includes('installing'));
  assert.ok(states.includes('installed'));
  // Progress was reported during downloading.
  assert.ok(events.some((e) => e.state === 'downloading' && e.progress === 45));
});

test('sequential processing: the second item starts only after the first finishes', async () => {
  let releaseFirst: ((r: any) => void) | null = null;
  const f = fakeRunner([
    (input: any) => new Promise((resolve) => { releaseFirst = () => resolve({ ok: true, state: 'installed' }); input.onState('downloading'); }),
    okFlow,
  ]);
  const q = createInstallQueueForTests(f.runner);
  q.enqueue({ slug: 'a', name: 'A' });
  q.enqueue({ slug: 'b', name: 'B' });
  await waitFor(20);
  // Only the first is running; b is still queued.
  assert.equal(f.calls.filter((c) => c.startsWith('start:')).length, 1);
  assert.equal(q.getSnapshot().find((i) => i.slug === 'b')?.state, 'queued');
  fire(releaseFirst);
  await waitFor(30);
  assert.equal(f.calls.filter((c) => c.startsWith('start:')).length, 2);
  assert.equal(q.getSnapshot().find((i) => i.slug === 'b')?.state, 'installed');
});

// ---------------------------------------------------------------------------
// Failure identification + recovery
// ---------------------------------------------------------------------------

test('download failure is identified with its stage and message; retry succeeds', async () => {
  let fail = true;
  const f = fakeRunner([
    async () => (fail ? { ok: false, state: 'failed', error: 'Connection reset', errorStage: 'download' } : { ok: true, state: 'installed' }),
  ]);
  const q = createInstallQueueForTests(f.runner);
  q.enqueue({ slug: 'x', name: 'X' });
  await waitFor(20);
  const item = q.getSnapshot()[0];
  assert.equal(item.state, 'failed');
  assert.equal(item.errorStage, 'download');
  assert.equal(item.error, 'Connection reset');
  // Queue state preserved; other records untouched (nothing else written).
  assert.equal(q.getSnapshot().length, 1);
  fail = false;
  assert.equal(q.retry(item.id), true);
  await waitFor(20);
  assert.equal(q.getSnapshot()[0].state, 'installed');
});

test('verify / install / detect failures each identify their stage', async () => {
  for (const stage of ['verify', 'install', 'detect'] as const) {
    storage.clear(); // isolate iterations: a fresh queue rehydrates persisted items
    const f = fakeRunner([async () => ({ ok: false, state: 'failed', error: `boom-${stage}`, errorStage: stage })]);
    const q = createInstallQueueForTests(f.runner);
    const id = q.enqueue({ slug: 'y', name: 'Y' })!;
    await waitFor(15);
    const item = q.getSnapshot().find((i) => i.id === id)!;
    assert.equal(item.state, 'failed');
    assert.equal(item.errorStage, stage);
    assert.equal(item.error, `boom-${stage}`);
  }
});

// ---------------------------------------------------------------------------
// Cancel semantics
// ---------------------------------------------------------------------------

test('cancel while queued removes the item before it ever runs', async () => {
  let release: ((r: any) => void) | null = null;
  const f = fakeRunner([
    (input: any) => new Promise((resolve) => { release = () => resolve({ ok: true, state: 'installed' }); input.onState('downloading'); }),
    okFlow,
  ]);
  const q = createInstallQueueForTests(f.runner);
  q.enqueue({ slug: 'first', name: 'First' });
  q.enqueue({ slug: 'second', name: 'Second' });
  await waitFor(15);
  const secondId = q.getSnapshot().find((i) => i.slug === 'second')!.id;
  assert.equal(q.cancel(secondId), true);
  assert.equal(q.getSnapshot().find((i) => i.slug === 'second')!.state, 'cancelled');
  fire(release);
  await waitFor(30);
  // 'second' never ran.
  assert.ok(!f.calls.some((c) => c.startsWith('start:second')));
  assert.equal(f.calls.filter((c) => c.startsWith('start:')).length, 1);
});

test('cancel while running marks cancelled and discards the pipeline outcome', async () => {
  let finishPipeline: ((r: any) => void) | null = null;
  const f = fakeRunner([
    (input: any) => new Promise((resolve) => {
      input.onState('downloading');
      input.onProgress(30);
      finishPipeline = () => resolve({ ok: true, state: 'installed' });
    }),
  ]);
  const q = createInstallQueueForTests(f.runner);
  q.enqueue({ slug: 'z', name: 'Z' });
  await waitFor(15);
  const item = q.getSnapshot()[0];
  assert.equal(item.state, 'downloading');
  q.cancel(item.id);
  assert.equal(q.getSnapshot()[0].state, 'cancelled');
  fire(finishPipeline); // pipeline completes "installed" AFTER cancel
  await waitFor(20);
  // The outcome is discarded — the item stays cancelled (no fake installed).
  assert.equal(q.getSnapshot()[0].state, 'cancelled');
});

// ---------------------------------------------------------------------------
// Persistence / rehydration (RECOVERY — never fake an install)
// ---------------------------------------------------------------------------

test('rehydrate: queued items stay queued, failed stay failed, running becomes failed(interrupted)', async () => {
  // Seed storage as a previous session left it.
  const now = Date.now();
  storage.setItem('rx-install-queue-v1', JSON.stringify({ v: 1, items: [
    { id: 'q1', slug: 'a', name: 'A', state: 'queued', addedAt: now, updatedAt: now },
    { id: 'q2', slug: 'b', name: 'B', state: 'downloading', progress: 40, addedAt: now, updatedAt: now },
    { id: 'q3', slug: 'c', name: 'C', state: 'failed', error: 'boom', errorStage: 'download', addedAt: now, updatedAt: now },
    { id: 'q4', slug: 'd', name: 'D', state: 'installed', addedAt: now, updatedAt: now },
  ] }));

  // A queue that never starts processing (offline) so states stay stable.
  online = false;
  connectivity.__setOnlineForTests(false);
  const q = createInstallQueueForTests({ run: async () => ({ ok: true, state: 'installed' }) });
  __setInstallQueueForTests(q);
  const items = q.getSnapshot();
  const byslug = Object.fromEntries(items.map((i: any) => [i.slug, i]));

  assert.equal(byslug.a.state, 'queued', 'queued persisted');
  assert.equal(byslug.b.state, 'failed', 'a mid-run item can never survive as installed');
  assert.equal(byslug.b.errorStage, 'interrupted', 'interrupted identified');
  assert.ok(byslug.b.error.includes('Interrupted'));
  assert.equal(byslug.c.state, 'failed', 'failed persisted with its reason');
  assert.equal(byslug.c.errorStage, 'download');
  assert.ok(!byslug.d, 'installed items are pruned on rehydrate');
  connectivity.__setOnlineForTests(true);
  __setInstallQueueForTests(null);
});

test('clearFinished removes terminal items only', async () => {
  const f = fakeRunner([okFlow, okFlow]);
  const q = createInstallQueueForTests(f.runner);
  q.enqueue({ slug: 'a', name: 'A' });
  q.enqueue({ slug: 'b', name: 'B' });
  await waitFor(40);
  assert.equal(q.getSnapshot().every((i) => i.state === 'installed'), true);
  const removed = q.clearFinished();
  assert.equal(removed, 2);
  assert.equal(q.getSnapshot().length, 0);
});

test('duplicate enqueue is ignored while an item is active', async () => {
  let release: ((r: any) => void) | null = null;
  const f = fakeRunner([
    (input: any) => new Promise((resolve) => { release = () => resolve({ ok: true, state: 'installed' }); input.onState('downloading'); }),
  ]);
  const q = createInstallQueueForTests(f.runner);
  q.enqueue({ slug: 'dup', name: 'Dup' });
  await waitFor(10);
  assert.equal(q.enqueue({ slug: 'dup', name: 'Dup' }), null, 'no duplicate while running');
  fire(release);
  await waitFor(20);
  assert.equal(q.enqueue({ slug: 'dup', name: 'Dup' }), null, 'no duplicate right after installed');
  assert.equal(q.getSnapshot().length, 1);
});

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

test('offline: processing pauses (items stay queued) and resumes when back online', async () => {
  connectivity.__setOnlineForTests(false);
  const f = fakeRunner([okFlow]);
  const q = createInstallQueueForTests(f.runner);
  q.subscribe(() => {});
  q.enqueue({ slug: 'off', name: 'Off' });
  await waitFor(25);
  assert.equal(q.getSnapshot()[0].state, 'queued', 'never started while offline');
  assert.equal(f.calls.length, 0);

  connectivity.__setOnlineForTests(true);
  await waitFor(25);
  assert.equal(q.getSnapshot()[0].state, 'installed', 'resumed after reconnect');
  assert.equal(f.calls.length, 2);
});

// ---------------------------------------------------------------------------
// Library classification (device awareness)
// ---------------------------------------------------------------------------

const classification = await import('./libraryClassification.ts');

test('classification: this device (native) vs other devices vs available vs unsupported vs previous', () => {
  const installations: Array<{ appSlug: string; deviceId: string; status: string }> = [
    { appSlug: 'a', deviceId: 'dev1', status: 'installed' },        // other device
    { appSlug: 'b', deviceId: 'dev1', status: 'not_installed' },    // previous (uninstalled everywhere)
    { appSlug: 'c', deviceId: 'dev1', status: 'update_available' }, // other device + update
  ];
  const base = (slug: string, platforms: string[]) => classification.classifyLibraryApp({
    app: { slug, platforms: platforms as any },
    thisDevice: { installed: false, updateAvailable: false },
    installations: installations as any,
    currentDeviceId: 'me',
    runtimePlatform: 'windows',
  });

  const a = base('a', ['windows']);
  assert.equal(a.otherDeviceIds.length, 1);
  assert.equal(a.thisDevice, false);

  const b = base('b', ['windows']);
  assert.equal(b.previouslyInstalled, true);
  assert.equal(b.otherDeviceIds.length, 0);

  const c = base('c', ['windows']);
  assert.equal(c.otherDeviceUpdate, true);
  assert.equal(c.otherDeviceIds.length, 1);

  // Unsupported: android-only app on a windows device.
  const d = base('d', ['android']);
  assert.equal(d.supportedOnThisPlatform, false);
  // Supported via web even on windows.
  const e = base('e', ['web']);
  assert.equal(e.supportedOnThisPlatform, true);
  // This-device native detection is authoritative in the classification input.
  const f2 = classification.classifyLibraryApp({
    app: { slug: 'a', platforms: ['windows'] },
    thisDevice: { installed: true, updateAvailable: false },
    installations: installations as any, currentDeviceId: 'me', runtimePlatform: 'windows',
  });
  assert.equal(f2.thisDevice, true);
});

test('first-launch eligibility: only with something real to restore, online, signed in', () => {
  const candidates = [{ slug: 'a', name: 'A', deviceCount: 1, previouslyInstalled: false }];
  assert.equal(classification.shouldShowFirstLaunch({
    signedIn: true, offline: false, catalogLoaded: true, alreadyDone: false, candidates,
  }), true);
  assert.equal(classification.shouldShowFirstLaunch({
    signedIn: false, offline: false, catalogLoaded: true, alreadyDone: false, candidates,
  }), false, 'signed out');
  assert.equal(classification.shouldShowFirstLaunch({
    signedIn: true, offline: true, catalogLoaded: true, alreadyDone: false, candidates,
  }), false, 'offline — cannot honestly start installs');
  assert.equal(classification.shouldShowFirstLaunch({
    signedIn: true, offline: false, catalogLoaded: true, alreadyDone: true, candidates,
  }), false, 'already completed');
  assert.equal(classification.shouldShowFirstLaunch({
    signedIn: true, offline: false, catalogLoaded: true, alreadyDone: false, candidates: [],
  }), false, 'new user with nothing to restore sees nothing');
  assert.equal(classification.shouldShowFirstLaunch({
    signedIn: true, offline: false, catalogLoaded: false, alreadyDone: false, candidates,
  }), false, 'catalog still loading');
});

test('usage honesty: "most used" ordering uses factual signals only; label only with real data', () => {
  const ordered = classification.orderRestoreCandidates([
    { slug: 'low', name: 'Low', deviceCount: 1, previouslyInstalled: false, userDownloads: 0 },
    { slug: 'high', name: 'High', deviceCount: 2, previouslyInstalled: false, userDownloads: 9 },
    { slug: 'mid', name: 'Mid', deviceCount: 2, previouslyInstalled: false, userDownloads: 1 },
  ]);
  assert.deepEqual(ordered.map((c) => c.slug), ['high', 'mid', 'low']);
  assert.equal(classification.hasRealUsageData(ordered), true);
  assert.equal(classification.hasRealUsageData([
    { slug: 'x', name: 'X', deviceCount: 1, previouslyInstalled: true },
  ]), false, 'no download history — no "most used" claim');
});
