/**
 * The install/download transaction is ONE app-wide fact.
 *
 * PRODUCTION BUG: `useInstallTransaction()` kept its state in `useState` per
 * component, so AppDetail and useInstallButton each had their own copy. A
 * download started on one surface was invisible to the other, and the in-page
 * download panel could stay hidden while a transfer genuinely ran.
 *
 * These tests pin the shared store's contract (one snapshot, many subscribers,
 * attempt identity) without needing React.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  __resetTransactionStore, getTransaction, isTransactionFailed, isTransactionRunning,
  patchTransaction, resetTransaction, setTransaction, subscribeToTransaction,
} from './installStore.ts';
import { createTransaction, transition } from './installTransaction.ts';

beforeEach(() => __resetTransactionStore());

test('every subscriber sees the SAME transaction (no per-component copies)', () => {
  const seenA: string[] = [];
  const seenB: string[] = [];
  subscribeToTransaction((tx) => seenA.push(tx.state));
  subscribeToTransaction((tx) => seenB.push(tx.state));

  setTransaction(transition(getTransaction(), { state: 'DOWNLOADING' }));
  assert.deepEqual(seenA, ['DOWNLOADING']);
  assert.deepEqual(seenB, ['DOWNLOADING'], 'both surfaces received the same update');
  assert.equal(getTransaction().state, 'DOWNLOADING');
});

test('unsubscribing stops delivery (a closed page must not update)', () => {
  let calls = 0;
  const off = subscribeToTransaction(() => { calls++; });
  setTransaction(transition(getTransaction(), { state: 'DOWNLOADING' }));
  off();
  setTransaction(transition(getTransaction(), { state: 'VERIFYING' }));
  assert.equal(calls, 1);
});

test('a throwing subscriber cannot break the others', () => {
  const seen: string[] = [];
  subscribeToTransaction(() => { throw new Error('boom'); });
  subscribeToTransaction((tx) => seen.push(tx.state));
  assert.doesNotThrow(() => setTransaction(transition(getTransaction(), { state: 'DOWNLOADING' })));
  assert.deepEqual(seen, ['DOWNLOADING']);
});

test('patch and reset behave like the hook expects', () => {
  setTransaction(transition(getTransaction(), { state: 'DOWNLOADING', progress: { received: 10, total: 100, percent: 10 } }));
  patchTransaction({ paused: true });
  assert.equal(getTransaction().paused, true);
  assert.equal(getTransaction().progress.received, 10, 'a patch keeps the other fields');

  const before = getTransaction().attemptId;
  const fresh = resetTransaction();
  assert.equal(fresh.state, 'IDLE');
  assert.notEqual(fresh.attemptId, before, 'a reset starts a NEW attempt');
});

test('running / failed classification matches the UI rules', () => {
  const at = (state: any) => setTransaction(transition(getTransaction(), { state }));
  assert.equal(isTransactionRunning(getTransaction()), false, 'IDLE is not running');
  for (const s of ['DOWNLOAD_STARTED', 'DOWNLOADING', 'VERIFYING', 'INSTALLER_STARTED', 'INSTALLATION_PENDING']) {
    at(s);
    assert.equal(isTransactionRunning(), true, `${s} is running`);
    assert.equal(isTransactionFailed(), false, `${s} is not a failure`);
  }
  for (const s of ['DOWNLOAD_FAILED', 'VERIFICATION_FAILED', 'INSTALL_FAILED', 'INSTALLATION_NOT_DETECTED', 'CANCELLED']) {
    at(s);
    assert.equal(isTransactionRunning(), false, `${s} is not running`);
    assert.equal(isTransactionFailed(), true, `${s} offers a retry`);
  }
  at('INSTALLED');
  assert.equal(isTransactionRunning(), false);
  assert.equal(isTransactionFailed(), false);
});

test('a transaction carries the app it belongs to', () => {
  const tx = createTransaction({ appSlug: 'yayra', appName: 'yayra', targetVersion: '1.0.79' });
  assert.equal(tx.appSlug, 'yayra');
  setTransaction(tx);
  // The page uses this to avoid showing ANOTHER app's download.
  assert.equal(getTransaction().appSlug === 'yayra', true);
});

test('the app page renders a permanent download section, idle included', () => {
  const card = readFileSync(new URL('../components/apps/DownloadCard.tsx', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../pages/AppDetail.tsx', import.meta.url), 'utf8');
  // The section exists on the page (not conditional on a download running)…
  assert.match(page, /id="downloads"/, 'the app page has a stable #downloads section');
  assert.doesNotMatch(page, /\{showDownloadPanel && \(/, 'the section is not hidden when idle');
  // …and states what it does when nothing is happening.
  assert.match(card, /Downloads &amp; updates/);
  assert.match(card, /Nothing in progress/);
  // The hook reads the shared store, not a private useState.
  const hook = readFileSync(new URL('./useInstallTransaction.ts', import.meta.url), 'utf8');
  assert.match(hook, /subscribeToTransaction/);
  assert.doesNotMatch(hook, /useState<TransactionResult>\(\(\) => createTransaction/, 'no private per-component copy');
});
