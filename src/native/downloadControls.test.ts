/**
 * Live download controls — pause / resume / cancel.
 *
 * Production: clicking Update on a 130MB installer showed a stack of identical
 * "Downloading the package…" toasts, no percentage and no way to stop it. These
 * tests pin the control registry (only real capabilities are advertised), the
 * resumable byte pump used by the web downloader, and the rate/ETA maths the
 * card renders.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_DOWNLOAD_CONTROLS,
  cancelDownload,
  createBytePump,
  downloadCapabilities,
  downloadControl,
  pauseDownload,
  registerDownloadControl,
  resetDownloadControls,
  resumeDownload,
  unregisterDownloadControl,
} from './downloadControls.ts';
import { etaSeconds, formatBytes, formatDuration, transferRate } from './downloadProgress.ts';

beforeEach(() => resetDownloadControls());

test('capabilities are honestly reported per platform, never faked', async () => {
  // Android's DownloadManager has no public pause/resume/cancel API.
  assert.deepEqual(NO_DOWNLOAD_CONTROLS, { pause: false, resume: false, cancel: false });
  assert.deepEqual(downloadCapabilities('nope'), NO_DOWNLOAD_CONTROLS);
  assert.equal(downloadControl('nope'), null);
  // …and every control is a no-op for an attempt that has no live download.
  assert.equal(await pauseDownload('nope'), false);
  assert.equal(await resumeDownload('nope'), false);
  assert.equal(await cancelDownload('nope'), false);
});

test('pause / resume / cancel reach the registered platform control', async () => {
  const calls: string[] = [];
  registerDownloadControl('inst_1', {
    capabilities: { pause: true, resume: true, cancel: true },
    pause: () => { calls.push('pause'); },
    resume: () => { calls.push('resume'); },
    cancel: () => { calls.push('cancel'); },
  });
  assert.deepEqual(downloadCapabilities('inst_1'), { pause: true, resume: true, cancel: true });
  assert.equal(await pauseDownload('inst_1'), true);
  assert.equal(await resumeDownload('inst_1'), true);
  assert.equal(await cancelDownload('inst_1'), true);
  assert.deepEqual(calls, ['pause', 'resume', 'cancel']);

  // Unregistered (download finished) → the UI gets false and hides the buttons.
  unregisterDownloadControl('inst_1');
  assert.equal(await pauseDownload('inst_1'), false);
});

test('an unsupported capability is refused, not silently "succeeded"', async () => {
  let called = 0;
  registerDownloadControl('inst_android', {
    capabilities: { ...NO_DOWNLOAD_CONTROLS },
    pause: () => { called++; },
    resume: () => { called++; },
    cancel: () => { called++; },
  });
  assert.equal(await pauseDownload('inst_android'), false);
  assert.equal(await resumeDownload('inst_android'), false);
  assert.equal(await cancelDownload('inst_android'), false);
  assert.equal(called, 0, 'the platform control is never invoked when unsupported');
});

test('the byte pump pauses, resumes and cancels (the web downloader’s transfer)', async () => {
  const pump = createBytePump();
  assert.equal(pump.state(), 'running');

  pump.pause();
  assert.equal(pump.state(), 'paused');
  // A paused pump blocks the download loop…
  let released = false;
  const waiter = pump.waitWhilePaused().then(() => { released = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(released, false, 'a paused download must not continue');

  // …until resume releases it.
  pump.resume();
  await waiter;
  assert.equal(released, true);
  assert.equal(pump.state(), 'running');

  pump.cancel();
  assert.equal(pump.state(), 'cancelled');
  await pump.waitWhilePaused(); // must not hang
});

test('cancelling while paused releases the waiter immediately', async () => {
  const pump = createBytePump();
  pump.pause();
  let released = false;
  const waiter = pump.waitWhilePaused().then(() => { released = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(released, false);
  pump.cancel();
  await waiter;
  assert.equal(released, true);
  assert.equal(pump.state(), 'cancelled');
});

test('resume is ignored unless paused; cancel is terminal', () => {
  const pump = createBytePump();
  pump.resume();
  assert.equal(pump.state(), 'running', 'resume without pause is a no-op');
  pump.cancel();
  pump.resume();
  assert.equal(pump.state(), 'cancelled', 'a cancelled transfer cannot be resumed');
  pump.pause();
  assert.equal(pump.state(), 'cancelled', 'a cancelled transfer cannot be paused');
});

// ---------------------------------------------------------------------------
// Rate / ETA — what the card shows under the progress bar.
// ---------------------------------------------------------------------------

test('transferRate: bytes per second from two samples, 0 when it cannot be known', () => {
  assert.equal(transferRate(null, { at: 1000, received: 500 }), 0);
  // 1MB over 2s = 512KB/s
  assert.equal(transferRate({ at: 0, received: 0 }, { at: 2000, received: 1048576 }), 524288);
  // No progress (paused) or time moving backwards → no invented rate.
  assert.equal(transferRate({ at: 0, received: 500 }, { at: 1000, received: 500 }), 0);
  assert.equal(transferRate({ at: 1000, received: 0 }, { at: 1000, received: 500 }), 0);
  assert.equal(transferRate({ at: 2000, received: 0 }, { at: 1000, received: 500 }), 0);
});

test('etaSeconds: honest remaining time, null when it would be a guess', () => {
  assert.equal(etaSeconds(0, 0, 1000), null, 'unknown total → no ETA');
  assert.equal(etaSeconds(500, 500, 1000), null, 'already complete → no ETA');
  assert.equal(etaSeconds(500, 1000, 0), null, 'no rate → no ETA');
  assert.equal(etaSeconds(500, 1000, 500), 1, '500 remaining at 500 B/s = 1s');
  assert.equal(etaSeconds(0, 10 * 1024 * 1024, 1024 * 1024), 10, '10MB at 1MB/s = 10s');
  assert.equal(etaSeconds(0, 100, 1e9), 1, 'never rounds down to 0s');
});

test('formatBytes / formatDuration stay readable at real installer sizes', () => {
  assert.equal(formatBytes(0), '0 MB');
  assert.equal(formatBytes(512 * 1024), '512 KB');
  assert.equal(formatBytes(10.4 * 1024 * 1024), '10.4 MB');
  assert.equal(formatBytes(161591382), '154.1 MB');
  assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.50 GB');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(200), '3m 20s');
  assert.equal(formatDuration(120), '2m');
});

// ---------------------------------------------------------------------------
// The download UI lives IN THE PAGE (not only in a toast).
//
// Production: clicking Update on a 130MB installer produced a stack of
// "Downloading the package…" toasts with no percentage and no way to stop it.
// The controls must be part of the app page, where Get/Update/Open live.
// ---------------------------------------------------------------------------
test('the app page renders the download panel inline, with the controls', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../pages/AppDetail.tsx', import.meta.url), 'utf8');

  // The full-width panel is rendered inside the page…
  assert.match(page, /variant="panel"/, 'AppDetail renders the full-width download panel');
  assert.match(page, /showDownloadPanel/, 'the panel has an explicit visibility rule');
  // …and it is wired to the live controls.
  for (const handler of ['onPause', 'onResume', 'onCancel', 'onRetry']) {
    assert.match(page, new RegExp(`${handler}=\\{`), `${handler} must be wired on the panel`);
  }
  // The stacking toast is gone.
  assert.doesNotMatch(page, /toast\('Downloading the package/,
    'per-transition download toasts must not come back (they stacked up)');
});

test('the panel hides when nothing is happening and after success', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../pages/AppDetail.tsx', import.meta.url), 'utf8');
  const rule = /const showDownloadPanel = React\.useMemo\(\(\) => \{([\s\S]*?)\}, \[/.exec(page)?.[1] || '';
  assert.match(rule, /'IDLE'/, 'nothing to show while idle');
  assert.match(rule, /'INSTALLED'/, 'a finished install is represented by the Open/Update button');
  assert.match(rule, /DOWNLOAD_FAILED/, 'failures stay visible so the user can retry');
});
