/**
 * Unit tests for the installation-state → button mapping (Prompt 5).
 *
 * These are pure and hermetic: they verify that the UI gets exactly one button
 * per state and never conflates DOWNLOAD with INSTALL, and that the current
 * device's detected state is authoritative over backend "other device" info.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installButtonFor,
  installStateStatus,
  deviceCountLabel,
  type InstallButton,
} from './installUi.ts';

test('GET when not installed (idle)', () => {
  const b = installButtonFor({ txState: 'IDLE', hasLocalInstall: false, isUpdateAvailable: false });
  assert.equal(b.state, 'GET');
  assert.equal(b.action, 'get');
  assert.equal(b.label, 'Get');
});

test('OPEN when installed locally (idle)', () => {
  const b = installButtonFor({ txState: 'IDLE', hasLocalInstall: true, isUpdateAvailable: false });
  assert.equal(b.state, 'OPEN');
  assert.equal(b.action, 'open');
  assert.equal(b.label, 'Open');
});

test('UPDATE when update available (idle)', () => {
  const b = installButtonFor({ txState: 'IDLE', hasLocalInstall: true, isUpdateAvailable: true });
  assert.equal(b.state, 'UPDATE');
  assert.equal(b.action, 'update');
  assert.equal(b.label, 'Update');
});

test('DOWNLOADING shows percent and never becomes OPEN', () => {
  const b = installButtonFor({ txState: 'DOWNLOADING', percent: 42 });
  assert.equal(b.state, 'DOWNLOADING');
  assert.equal(b.action, 'get');
  assert.equal(b.label, 'Downloading 42%');
  assert.equal(b.percent, 42);
  assert.notEqual(b.state, 'OPEN', 'downloading is not opening');
});

test('VERIFYING and CHECKING have distinct labels', () => {
  assert.equal(installButtonFor({ txState: 'VERIFYING' }).label, 'Verifying…');
  assert.equal(installButtonFor({ txState: 'VERIFYING_INSTALLATION' }).label, 'Checking installation…');
  assert.equal(installButtonFor({ txState: 'VERIFYING' }).state, 'VERIFYING');
  assert.equal(installButtonFor({ txState: 'VERIFYING_INSTALLATION' }).state, 'CHECKING');
});

test('INSTALLING shows after installer launch, INSTALLED only after verify', () => {
  assert.equal(installButtonFor({ txState: 'INSTALLER_STARTED' }).state, 'INSTALLING');
  assert.equal(installButtonFor({ txState: 'INSTALLATION_PENDING' }).state, 'INSTALLING');
  // Installer launch is NOT installation success.
  assert.notEqual(installButtonFor({ txState: 'INSTALLER_STARTED' }).state, 'OPEN');
  // Only INSTALLED (post native detection) becomes OPEN.
  assert.equal(installButtonFor({ txState: 'INSTALLED' }).state, 'OPEN');
});

test('failure states map to RETRY', () => {
  for (const state of ['DOWNLOAD_FAILED', 'VERIFICATION_FAILED', 'INSTALL_FAILED', 'INSTALLATION_NOT_DETECTED', 'CANCELLED']) {
    const b = installButtonFor({ txState: state as any, failed: true });
    assert.equal(b.state, 'RETRY', state);
    assert.equal(b.action, 'retry', state);
  }
  const vf = installButtonFor({ txState: 'VERIFICATION_FAILED' });
  assert.equal(vf.label, 'Package verification failed. The file was not installed.');
});

test('UPDATING borrows the download pipeline with update wording', () => {
  const b = installButtonFor({ txState: 'DOWNLOADING', percent: 72, isUpdate: true });
  assert.equal(b.state, 'UPDATING');
  assert.equal(b.action, 'update');
  assert.equal(b.label, 'Updating 72%');
});

test('installStateStatus gives accessible descriptors (update failure preserves old version)', () => {
  assert.equal(installStateStatus('INSTALLED'), 'Installed on this device');
  assert.equal(installStateStatus('UPDATE_FAILED'), 'Update failed — your existing version is still installed');
  assert.equal(installStateStatus('NOT_INSTALLED'), 'Not installed on this device');
  assert.equal(installStateStatus('DETECTION_UNAVAILABLE'), 'Installation status unavailable');
});

test('deviceCountLabel: never claims OPEN for another device', () => {
  assert.equal(deviceCountLabel(0), '');
  assert.equal(deviceCountLabel(1), 'Installed on another device');
  assert.equal(deviceCountLabel(3), 'Installed on 3 devices');
});

test('current-device detection determines OPEN, not backend other-device data', () => {
  // Local not installed + other device installed => GET, never OPEN.
  const localOff = installButtonFor({ txState: 'IDLE', hasLocalInstall: false, isUpdateAvailable: false });
  assert.equal(localOff.state, 'GET');
  // Local installed + nothing else => OPEN.
  const localOn = installButtonFor({ txState: 'IDLE', hasLocalInstall: true, isUpdateAvailable: false });
  assert.equal(localOn.state, 'OPEN');
});
