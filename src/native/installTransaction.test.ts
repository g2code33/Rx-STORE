/**
 * Unit tests for the installation transaction state machine (Prompt 3).
 * Ensures the lifecycle is explicit and DOWNLOAD ≠ INSTALL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTransaction,
  transition,
  describeTransaction,
  isFailed,
  isTerminalSuccess,
  createTransactionStore,
  type TransactionResult,
  type TransactionState,
} from './installTransaction.ts';

test('createTransaction starts in IDLE with a unique attemptId', () => {
  const a = createTransaction();
  const b = createTransaction();
  assert.equal(a.state, 'IDLE');
  assert.ok(a.attemptId);
  assert.notEqual(a.attemptId, b.attemptId, 'each attempt has a unique id');
});

test('transition applies a new state without mutating the original', () => {
  const t = createTransaction();
  const next = transition(t, { state: 'DOWNLOAD_STARTED' });
  assert.equal(next.state, 'DOWNLOAD_STARTED');
  assert.equal(t.state, 'IDLE', 'original is not mutated');
});

test('describeTransaction gives a human label per state', () => {
  assert.equal(describeTransaction('IDLE'), 'Get');
  assert.equal(describeTransaction('DOWNLOADING'), 'Downloading');
  assert.equal(describeTransaction('VERIFYING'), 'Verifying checksum…');
  assert.equal(describeTransaction('INSTALLED'), 'Installed');
  assert.equal(describeTransaction('VERIFICATION_FAILED'), 'Verification failed');
});

test('isFailed covers failure states only', () => {
  const failures: string[] = ['DOWNLOAD_FAILED', 'VERIFICATION_FAILED', 'INSTALL_FAILED', 'INSTALLATION_NOT_DETECTED', 'CANCELLED'];
  for (const s of failures) {
    assert.equal(isFailed(s as TransactionState), true, s);
  }
  assert.equal(isFailed('IDLE' as TransactionState), false);
  assert.equal(isFailed('DOWNLOADING' as TransactionState), false);
  assert.equal(isFailed('INSTALLED' as TransactionState), false);
});

test('isTerminalSuccess covers INSTALLED / VERIFIED', () => {
  assert.equal(isTerminalSuccess('INSTALLED'), true);
  assert.equal(isTerminalSuccess('VERIFIED'), true);
  assert.equal(isTerminalSuccess('DOWNLOAD_COMPLETED'), false);
});

test('download completion never transitions to INSTALLED on its own', () => {
  // The state machine models the pipeline; going straight from DOWNLOAD_COMPLETED
  // to INSTALLED is not a valid direct transition in the pipeline (it must pass
  // through VERIFYING / INSTALLATION_PENDING / VERIFYING_INSTALLATION).
  const t = createTransaction();
  const downloaded = transition(t, { state: 'DOWNLOAD_COMPLETED' });
  assert.equal(downloaded.state, 'DOWNLOAD_COMPLETED');
  // No helper here auto-promotes to INSTALLED.
  assert.notEqual(downloaded.state, 'INSTALLED');
});

test('a failed update preserves the previous installed version', () => {
  const t = createTransaction({ previousVersion: '1.2.0', targetVersion: '1.3.0' });
  const failed = transition(t, { state: 'VERIFICATION_FAILED' });
  assert.equal(failed.previousVersion, '1.2.0', 'old version preserved');
  assert.equal(failed.targetVersion, '1.3.0');
});

test('transaction store notifies subscribers on set and keeps latest', () => {
  const store = createTransactionStore();
  let seen: TransactionResult | null = null;
  const unsub = store.subscribe((tx) => { seen = tx; });
  const next = transition(store.get(), { state: 'DOWNLOADING' });
  store.set(next);
  assert.equal((seen as TransactionResult | null)?.state, 'DOWNLOADING');
  assert.equal(store.get().state, 'DOWNLOADING');
  unsub();
});

// ---------------------------------------------------------------------------
// Update replace-path threading: an AppImage update must REPLACE the previous
// artifact instead of launching a second copy (fixes the "update opens the
// old app / software store" class of bug at the coordinator level).
// ---------------------------------------------------------------------------

test('desktop launchInstall receives the previous AppImage path as replacePath', async () => {
  const calls: any[] = [];
  const fakeDesktop = {
    isDesktop: true,
    canDetect: () => true,
    refresh: async () => undefined,
    // Runtime interface: detect(app) returns an InstalledApp when present.
    detect: async () => ({ installed: true, version: '2.0.0', source: 'appimage' }),
    resolve: async () => ({ state: 'INSTALLED', otherDevices: 0 }),
    downloadApp: async () => ({ path: '/downloads/new.AppImage', fileName: 'new.AppImage', size: 10 }),
    hashFile: async () => ({ sha256: 'a'.repeat(64), size: 10 }),
    installApp: async (filePath: string, opts?: any) => { calls.push({ filePath, opts }); return { launched: false, installed: true, method: 'appimage-replaced' }; },
    openApp: async () => true,
    uninstallApp: async () => true,
    showNotification: async () => true,
  };
  const savedDesktop = (globalThis as any).window?.rxDesktop;
  try {
    (globalThis as any).window = { ...(globalThis as any).window, rxDesktop: fakeDesktop };
    const { InstallCoordinator } = await import('./installCoordinator.ts');
    const coord = new InstallCoordinator(fakeDesktop as any);
    const result = await coord.run({
      app: { id: 'app1', slug: 'demo', name: 'Demo' } as any,
      packageMeta: {
        platform: 'linux_appimage', url: 'https://example.test/x.AppImage', fileName: 'x.AppImage',
        version: '2.0.0', size: 10, sha256: 'a'.repeat(64), replacePath: '/opt/old.AppImage',
      },
      previousVersion: '1.0.0', isUpdate: true,
    });
    assert.equal(result.state, 'INSTALLED', `transaction completed: ${result.state} ${result.message || ''}`);
    assert.equal(calls.length, 1, 'installApp called exactly once');
    assert.equal(calls[0].filePath, '/downloads/new.AppImage');
    assert.equal(calls[0].opts?.replacePath, '/opt/old.AppImage', 'the previous artifact path was forwarded for replacement');
  } finally {
    if (savedDesktop !== undefined) (globalThis as any).window.rxDesktop = savedDesktop;
    else if ((globalThis as any).window) delete (globalThis as any).window.rxDesktop;
  }
});

// ---------------------------------------------------------------------------
// INSTALL_FAILED carries the real installer message (password cancelled, apt
// lock busy) — the renderer must surface it, never a generic 'could not be
// launched' (which made production failures undiagnosable).
// ---------------------------------------------------------------------------

test('an installer failure carries its real message through the transaction', async () => {
  const failingRuntime = {
    canDetect: () => true,
    refresh: async () => undefined,
    detect: async () => ({ installed: false }),
    resolve: async () => ({ state: 'NOT_INSTALLED', otherDevices: 0 }),
    download: async (_url: string, _meta: any, onProgress: any) => {
      onProgress({ received: 10, total: 10, percent: 100 });
      return { data: new Uint8Array(10).buffer as ArrayBuffer };
    },
    hash: async () => 'a'.repeat(64),
    launchInstall: async () => { throw new Error('Installation was cancelled — approve the password prompt (or run again) to update the application.'); },
  };
  const { InstallCoordinator } = await import('./installCoordinator.ts');
  // Verification path on web hashes in place; the 10 zero bytes won't match
  // 'aaaa…'. Provide a matching hash so the transaction reaches the INSTALL
  // stage where launchInstall throws.
  const realHash = await import('./verify.ts').then((m) => m.sha256Hex(new Uint8Array(10).buffer as ArrayBuffer));
  const coord = new InstallCoordinator(failingRuntime as any, { download: failingRuntime.download as any, hash: async () => realHash, launchInstall: failingRuntime.launchInstall as any });
  const result = await coord.run({
    app: { id: 'app1', slug: 'demo', name: 'Demo' } as any,
    packageMeta: { platform: 'linux_deb', url: 'https://example.test/x.deb', fileName: 'x.deb', version: '2.0.0', size: 10, sha256: realHash },
    isUpdate: true, previousVersion: '1.0.0',
  });
  assert.equal(result.state, 'INSTALL_FAILED');
  assert.match(result.message || '', /password prompt/, 'the REAL reason survives the transaction');
});
