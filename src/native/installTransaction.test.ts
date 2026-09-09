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
