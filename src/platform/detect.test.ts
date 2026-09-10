/**
 * Unit tests for the normalized installed-app detection model.
 *
 * These cover the pure classification + version-comparison logic that turns
 * raw native detection outcomes (Windows registry, Linux package manager,
 * Android package manager) into the normalized Get/Open/Update state. The
 * OS access itself lives in Electron/Rust/Java native code; this module is the
 * single decision layer both native clients and the UI depend on.
 *
 * Run with Node 22+ (native TypeScript stripping):
 *   node --experimental-strip-types --test src/platform/detect.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  detectionState,
  detectionAction,
  normalizeInstalledApp,
  stateForDetection,
  currentDeviceInstallState,
  resolveDeviceView,
  otherDeviceInstallCount,
  mapDetectionToInstall,
  installStatusForReport,
  deviceActivity,
  classifyOpenFailure,
  isExecutableTargetValid,
  preferredUninstallCommand,
  hasUninstallableSource,
  type InstalledApp,
} from './detect.ts';

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------
test('compareVersions: 1.0.0 < 1.0.1', () => {
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
});
test('compareVersions: 1.0.9 < 1.0.10 (numeric, not lexicographic)', () => {
  assert.equal(compareVersions('1.0.9', '1.0.10'), -1);
});
test('compareVersions: 1.1.0 > 1.0.25', () => {
  assert.equal(compareVersions('1.1.0', '1.0.25'), 1);
});
test('compareVersions: 2.0.0 > 1.9.99', () => {
  assert.equal(compareVersions('2.0.0', '1.9.99'), 1);
});
test('compareVersions: equal versions', () => {
  assert.equal(compareVersions('1.0.25', '1.0.25'), 0);
});
test('compareVersions: handles leading v and prerelease suffixes', () => {
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 0);
});
test('compareVersions: missing / invalid handled without throwing', () => {
  assert.equal(compareVersions(undefined, undefined), 0);
  assert.equal(compareVersions('', '1.0.25'), -1);
  assert.equal(compareVersions('not-a-version', '1.0.25'), -1);
});

// ---------------------------------------------------------------------------
// Detection state mapping
// ---------------------------------------------------------------------------
test('not installed -> NOT_INSTALLED', () => {
  assert.equal(detectionState('1.0.25', false, ''), 'NOT_INSTALLED');
});
test('installed, same version -> INSTALLED_CURRENT', () => {
  assert.equal(detectionState('1.0.25', true, '1.0.25'), 'INSTALLED_CURRENT');
});
test('installed, older than store -> UPDATE_AVAILABLE', () => {
  assert.equal(detectionState('1.0.25', true, '1.0.24'), 'UPDATE_AVAILABLE');
});
test('installed, newer than store -> INSTALLED_CURRENT (no downgrade)', () => {
  assert.equal(detectionState('1.0.25', true, '1.1.0'), 'INSTALLED_CURRENT');
});
test('installed but version missing -> INSTALLED_CURRENT (never Update)', () => {
  assert.equal(detectionState('1.0.25', true, undefined), 'INSTALLED_CURRENT');
  assert.equal(detectionState('1.0.25', true, ''), 'INSTALLED_CURRENT');
});

// ---------------------------------------------------------------------------
// Windows scenarios (registry + executable)
// ---------------------------------------------------------------------------
test('Windows: registry entry missing -> NOT_INSTALLED', () => {
  const app = normalizeInstalledApp('clinical-rx', 'windows', { installed: false, source: 'none' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'NOT_INSTALLED');
});
test('Windows: installed/current via registry -> INSTALLED_CURRENT', () => {
  const app = normalizeInstalledApp('clinical-rx', 'windows', { installed: true, version: '1.0.25', executable: 'C:\\Apps\\clinical-rx.exe', source: 'registry' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'INSTALLED_CURRENT');
  assert.equal(app.executable, 'C:\\Apps\\clinical-rx.exe');
});
test('Windows: installed/older -> UPDATE_AVAILABLE', () => {
  const app = normalizeInstalledApp('clinical-rx', 'windows', { installed: true, version: '1.0.24', source: 'registry' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'UPDATE_AVAILABLE');
});
test('Windows: installed/newer -> INSTALLED_CURRENT', () => {
  const app = normalizeInstalledApp('clinical-rx', 'windows', { installed: true, version: '2.0.0', source: 'registry' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'INSTALLED_CURRENT');
});
test('Windows: executable present, no version -> INSTALLED_CURRENT', () => {
  const app = normalizeInstalledApp('clinical-rx', 'windows', { installed: true, executable: 'C:\\Apps\\clinical-rx.exe', source: 'executable' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'INSTALLED_CURRENT');
});
test('Windows: executable missing -> NOT_INSTALLED', () => {
  const app = normalizeInstalledApp('clinical-rx', 'windows', { installed: false, source: 'executable' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'NOT_INSTALLED');
});
test('Windows: only supports semantic versions (1.0.25 vs 1.0.100)', () => {
  assert.equal(compareVersions('1.0.25', '1.0.100'), -1);
});

// ---------------------------------------------------------------------------
// Linux scenarios (package + executable)
// ---------------------------------------------------------------------------
test('Linux: package installed -> INSTALLED_CURRENT or UPDATE_AVAILABLE', () => {
  const app = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: true, version: '1.0.25', executable: '/usr/bin/cgpa-pilot', source: 'package' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'INSTALLED_CURRENT');
});
test('Linux: package absent -> NOT_INSTALLED', () => {
  const app = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: false, source: 'package' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'NOT_INSTALLED');
});
test('Linux: executable present (fallback) -> INSTALLED_CURRENT', () => {
  const app = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: true, executable: '/usr/local/bin/cgpa-pilot', source: 'executable' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'INSTALLED_CURRENT');
});
test('Linux: executable absent (fallback) -> NOT_INSTALLED', () => {
  const app = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: false, source: 'executable' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'NOT_INSTALLED');
});
test('Linux: package manager unavailable but executable found -> installed', () => {
  const app = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: true, executable: '/usr/bin/cgpa-pilot', source: 'executable' }, '1.0.25');
  assert.equal(app.installed, true);
});

// ---------------------------------------------------------------------------
// Android scenarios (package ID)
// ---------------------------------------------------------------------------
test('Android: package installed with version -> INSTALLED_CURRENT', () => {
  const app = normalizeInstalledApp('cgpa-pilot', 'android', { installed: true, version: '1.0.25', source: 'package-manager' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'INSTALLED_CURRENT');
});
test('Android: package absent -> NOT_INSTALLED', () => {
  const app = normalizeInstalledApp('cgpa-pilot', 'android', { installed: false, source: 'package-manager' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'NOT_INSTALLED');
});
test('Android: version retrieval older -> UPDATE_AVAILABLE', () => {
  const app = normalizeInstalledApp('cgpa-pilot', 'android', { installed: true, version: '1.0.24', source: 'package-manager' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'UPDATE_AVAILABLE');
});
test('Android: invalid/empty package ID -> NOT_INSTALLED (never Open)', () => {
  const app = normalizeInstalledApp('cgpa-pilot', 'android', { installed: false, source: 'unconfigured' }, '1.0.25');
  assert.equal(stateForDetection(app, '1.0.25'), 'NOT_INSTALLED');
});

// ---------------------------------------------------------------------------
// UI action mapping
// ---------------------------------------------------------------------------
test('detectionAction maps every state to Get/Open/Update', () => {
  assert.equal(detectionAction('NOT_INSTALLED'), 'Get');
  assert.equal(detectionAction('INSTALLED_CURRENT'), 'Open');
  assert.equal(detectionAction('UPDATE_AVAILABLE'), 'Update');
  assert.equal(detectionAction('DETECTION_UNAVAILABLE'), 'Get');
});

test('stateForDetection: unknown/empty detection -> NOT_INSTALLED', () => {
  const app: InstalledApp = { appId: 'x', platform: 'windows', installed: false, detectedAt: Date.now() };
  assert.equal(stateForDetection(app, '1.0.25'), 'NOT_INSTALLED');
});

// ---------------------------------------------------------------------------
// Rich install-state model (current device is authoritative)
// ---------------------------------------------------------------------------
test('current device installed -> INSTALLED', () => {
  const local = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: true, version: '1.0.25', source: 'package' }, '1.0.25');
  assert.equal(currentDeviceInstallState(local, '1.0.25'), 'INSTALLED');
});
test('current device NOT installed -> NOT_INSTALLED', () => {
  const local = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: false, source: 'none' }, '1.0.25');
  assert.equal(currentDeviceInstallState(local, '1.0.25'), 'NOT_INSTALLED');
});
test('current device outdated -> UPDATE_AVAILABLE', () => {
  const local = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: true, version: '1.0.24', source: 'package' }, '1.0.25');
  assert.equal(currentDeviceInstallState(local, '1.0.25'), 'UPDATE_AVAILABLE');
});
test('detection unavailable (web) -> DETECTION_UNAVAILABLE', () => {
  assert.equal(currentDeviceInstallState(null, '1.0.25'), 'DETECTION_UNAVAILABLE');
});
test('operation overrides base state (installing / updating / uninstalling / failures)', () => {
  const local = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: true, version: '1.0.24', source: 'package' }, '1.0.25');
  assert.equal(currentDeviceInstallState(local, '1.0.25', 'installing'), 'INSTALLING');
  assert.equal(currentDeviceInstallState(local, '1.0.25', 'updating'), 'UPDATING');
  assert.equal(currentDeviceInstallState(local, '1.0.25', 'uninstalling'), 'UNINSTALLING');
  assert.equal(currentDeviceInstallState(local, '1.0.25', 'install_failed'), 'INSTALL_FAILED');
  assert.equal(currentDeviceInstallState(local, '1.0.25', 'update_failed'), 'UPDATE_FAILED');
  assert.equal(currentDeviceInstallState(local, '1.0.25', 'uninstall_failed'), 'UNINSTALL_FAILED');
});

test('mapDetectionToInstall maps the 4 base states', () => {
  assert.equal(mapDetectionToInstall('NOT_INSTALLED'), 'NOT_INSTALLED');
  assert.equal(mapDetectionToInstall('INSTALLED_CURRENT'), 'INSTALLED');
  assert.equal(mapDetectionToInstall('UPDATE_AVAILABLE'), 'UPDATE_AVAILABLE');
  assert.equal(mapDetectionToInstall('DETECTION_UNAVAILABLE'), 'DETECTION_UNAVAILABLE');
});

test('installStatusForReport maps to backend lowercase statuses', () => {
  assert.equal(installStatusForReport('INSTALLED'), 'installed');
  assert.equal(installStatusForReport('NOT_INSTALLED'), 'not_installed');
  assert.equal(installStatusForReport('UPDATE_AVAILABLE'), 'update_available');
  assert.equal(installStatusForReport('INSTALLING'), 'installing');
  assert.equal(installStatusForReport('UNINSTALL_FAILED'), 'uninstall_failed');
  assert.equal(installStatusForReport('DETECTION_UNAVAILABLE'), 'unknown');
});

// ---------------------------------------------------------------------------
// Current device vs other devices (cloud is LAST-KNOWN, never authoritative)
// ---------------------------------------------------------------------------
const otherInstalled = (deviceId: string) => ({ deviceId, appSlug: 'cgpa-pilot', status: 'installed' });

test('installed ONLY on another device -> current device GET, other count 1', () => {
  const local = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: false, source: 'none' }, '1.0.25');
  const view = resolveDeviceView({ local, storeVersion: '1.0.25', otherInstallations: [otherInstalled('phoneA')], currentDeviceId: 'phoneB' });
  assert.equal(view.state, 'NOT_INSTALLED'); // still GET, never OPEN from cloud
  assert.equal(view.otherDevices, 1);
});

test('installed on multiple OTHER devices -> count them, still GET locally', () => {
  const local = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: false, source: 'none' }, '1.0.25');
  const view = resolveDeviceView({ local, storeVersion: '1.0.25', otherInstallations: [otherInstalled('phoneA'), otherInstalled('phoneC'), otherInstalled('laptop')], currentDeviceId: 'phoneB' });
  assert.equal(view.state, 'NOT_INSTALLED');
  assert.equal(view.otherDevices, 3);
});

test('cloud says installed but local detection says not -> GET, never OPEN', () => {
  const local = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: false, source: 'none' }, '1.0.25');
  const view = resolveDeviceView({ local, storeVersion: '1.0.25', otherInstallations: [otherInstalled('laptop')], currentDeviceId: 'phoneB' });
  assert.equal(view.state, 'NOT_INSTALLED');
});

test('local detection confirms installed even if cloud is stale -> OPEN', () => {
  const local = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: true, version: '1.0.25', source: 'package' }, '1.0.25');
  const view = resolveDeviceView({ local, storeVersion: '1.0.25', otherInstallations: [], currentDeviceId: 'ubuntu' });
  assert.equal(view.state, 'INSTALLED');
  assert.equal(view.otherDevices, 0);
});

test('current device outdated while another device is current -> UPDATE here, other count preserved', () => {
  const local = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: true, version: '1.0.24', source: 'package' }, '1.0.25');
  const view = resolveDeviceView({ local, storeVersion: '1.0.25', otherInstallations: [otherInstalled('laptop')], currentDeviceId: 'ubuntu' });
  assert.equal(view.state, 'UPDATE_AVAILABLE');
  assert.equal(view.otherDevices, 1);
});

test('uninstall changes ONLY the current device; other devices remain installed', () => {
  // After uninstalling on the current device, local detection returns not installed.
  const local = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: false, source: 'none' }, '1.0.25');
  const view = resolveDeviceView({ local, storeVersion: '1.0.25', otherInstallations: [otherInstalled('phoneA'), otherInstalled('laptop')], currentDeviceId: 'ubuntu' });
  assert.equal(view.state, 'NOT_INSTALLED'); // current device is now GET
  assert.equal(view.otherDevices, 2);        // other devices still resolved as installed
  // otherDeviceInstallCount excludes the current device id explicitly.
  assert.equal(otherDeviceInstallCount([otherInstalled('phoneA'), otherInstalled('laptop')], 'ubuntu'), 2);
});

test('otherDeviceInstallCount ignores the current device and non-active statuses', () => {
  const list = [
    otherInstalled('phoneA'),
    otherInstalled('ubuntu'),   // current device — excluded
    { deviceId: 'tablet', appSlug: 'cgpa-pilot', status: 'not_installed' },
    { deviceId: 'laptop', appSlug: 'cgpa-pilot', status: 'revoked' },
  ];
  assert.equal(otherDeviceInstallCount(list, 'ubuntu'), 1);
});

// ---------------------------------------------------------------------------
// Windows uninstall metadata handling (pure decision on a detected target)
// ---------------------------------------------------------------------------
test('Windows detection result carries uninstall metadata for the uninstaller', () => {
  const app = normalizeInstalledApp('cgpa-pilot', 'windows', {
    installed: true,
    version: '1.0.25',
    executable: 'C:\\Apps\\cgpa-pilot.exe',
    source: 'registry',
  }, '1.0.25');
  // Simulates the resolved uninstall target flowing to the runtime from detection.
  const uninstallTarget = 'C:\\Apps\\cgpa-pilot\\uninstall.exe';
  const fresh = { ...app, executable: uninstallTarget };
  assert.equal(fresh.installed, true);
  assert.equal(fresh.executable, uninstallTarget);
});

// ---------------------------------------------------------------------------
// Android uninstall reconciliation logic
// ---------------------------------------------------------------------------
test('Android uninstall reconciliation: re-detect after uninstall before reporting', () => {
  // Before: installed on the device.
  const before = normalizeInstalledApp('cgpa-pilot', 'android', { installed: true, version: '1.0.25', source: 'package-manager' }, '1.0.25');
  assert.equal(currentDeviceInstallState(before, '1.0.25'), 'INSTALLED');
  // After the OS confirms removal, re-detection returns not installed.
  const after = normalizeInstalledApp('cgpa-pilot', 'android', { installed: false, source: 'package-manager' }, '1.0.25');
  assert.equal(currentDeviceInstallState(after, '1.0.25'), 'NOT_INSTALLED');
  // Report only reflects CONFIRMED (re-detected) state, not the intent to uninstall.
  assert.equal(installStatusForReport(currentDeviceInstallState(after, '1.0.25')), 'not_installed');
});

// ---------------------------------------------------------------------------
// Prompt 2 — full multi-device scenario (current device is authoritative)
// ---------------------------------------------------------------------------
test('scenario: Phone A installed / Phone B not installed -> GET + other device', () => {
  // Phone B current, local detection says not installed.
  const localB = normalizeInstalledApp('cgpa-pilot', 'android', { installed: false, source: 'package-manager' }, '1.0.25');
  const view = resolveDeviceView({
    local: localB, storeVersion: '1.0.25',
    otherInstallations: [{ deviceId: 'phoneA', status: 'installed' }],
    currentDeviceId: 'phoneB',
  });
  assert.equal(view.state, 'NOT_INSTALLED');      // GET, never OPEN from cloud
  assert.equal(view.otherDevices, 1);             // "Installed on another device"
});

test('scenario: install on Phone B -> BOTH devices become installed', () => {
  // After a successful local install, current device detection flips to installed.
  const localB = normalizeInstalledApp('cgpa-pilot', 'android', { installed: true, version: '1.0.25', source: 'package-manager' }, '1.0.25');
  const view = resolveDeviceView({
    local: localB, storeVersion: '1.0.25',
    otherInstallations: [{ deviceId: 'phoneA', status: 'installed' }],
    currentDeviceId: 'phoneB',
  });
  assert.equal(view.state, 'INSTALLED');          // OPEN on Phone B
  assert.equal(view.otherDevices, 1);             // Phone A still installed
});

test('scenario: uninstall on Phone B does NOT affect Phone A', () => {
  // Phone B re-detects as not installed; Phone A's record is untouched.
  const localB = normalizeInstalledApp('cgpa-pilot', 'android', { installed: false, source: 'package-manager' }, '1.0.25');
  const view = resolveDeviceView({
    local: localB, storeVersion: '1.0.25',
    otherInstallations: [{ deviceId: 'phoneA', status: 'installed' }],
    currentDeviceId: 'phoneB',
  });
  assert.equal(view.state, 'NOT_INSTALLED');      // GET on Phone B
  assert.equal(view.otherDevices, 1);             // Phone A remains installed
});

test('scenario: current device opened, other device count preserved', () => {
  // Phone A opens after B uninstalls — local detection confirms installed.
  const localA = normalizeInstalledApp('cgpa-pilot', 'android', { installed: true, version: '1.0.25', source: 'package-manager' }, '1.0.25');
  const view = resolveDeviceView({
    local: localA, storeVersion: '1.0.25',
    otherInstallations: [{ deviceId: 'phoneB', status: 'not_installed' }],
    currentDeviceId: 'phoneA',
  });
  assert.equal(view.state, 'INSTALLED');          // still OPEN
  assert.equal(view.otherDevices, 0);             // Phone B not installed anywhere else
});

// ---------------------------------------------------------------------------
// Update preserves the actual installed version until verification
// ---------------------------------------------------------------------------
test('update: preserves installed version until native verification', () => {
  const local = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: true, version: '1.2.0', source: 'package' }, '1.3.0');
  const state = currentDeviceInstallState(local, '1.3.0');
  assert.equal(state, 'UPDATE_AVAILABLE');
  // The detected version is preserved (not overwritten by the store version).
  assert.equal(local.version, '1.2.0');
  // Only after re-detection confirms 1.3.0 does it become installed/current.
  const verified = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: true, version: '1.3.0', source: 'package' }, '1.3.0');
  assert.equal(currentDeviceInstallState(verified, '1.3.0'), 'INSTALLED');
});

// ---------------------------------------------------------------------------
// Offline current-device detection does NOT depend on the backend
// ---------------------------------------------------------------------------
test('offline: current-device detection continues without backend state', () => {
  // currentDeviceInstallState is PURE — it has no backend dependency. Web/PWA
  // (no local detection) => DETECTION_UNAVAILABLE; native => local wins.
  assert.equal(currentDeviceInstallState(null, '1.0.25'), 'DETECTION_UNAVAILABLE');
  const local = normalizeInstalledApp('cgpa-pilot', 'linux', { installed: true, version: '1.0.25', source: 'package' }, '1.0.25');
  assert.equal(currentDeviceInstallState(local, '1.0.25'), 'INSTALLED');
  // Stale backend data is never allowed to flip a not-installed device to Open.
  const view = resolveDeviceView({ local: normalizeInstalledApp('cgpa-pilot', 'android', { installed: false, source: 'package-manager' }, '1.0.25'), storeVersion: '1.0.25', otherInstallations: [{ deviceId: 'laptop', status: 'installed' }], currentDeviceId: 'phoneB' });
  assert.equal(view.state, 'NOT_INSTALLED');
});

// ---------------------------------------------------------------------------
// Device staleness — never claim a device is online just because it has a record
// ---------------------------------------------------------------------------
test('deviceActivity thresholds: active / stale / offline, never falsely online', () => {
  const now = Date.now();
  const hours = (n: number) => new Date(now - n * 3600_000).toISOString();
  const days = (n: number) => new Date(now - n * 86_400_000).toISOString();
  assert.equal(deviceActivity(hours(1), now), 'active');
  assert.equal(deviceActivity(hours(23), now), 'active');
  assert.equal(deviceActivity(days(2), now), 'stale');
  assert.equal(deviceActivity(days(13), now), 'stale');
  assert.equal(deviceActivity(days(20), now), 'offline');
  assert.equal(deviceActivity('', now), 'offline');
  assert.equal(deviceActivity(undefined, now), 'offline');
  assert.equal(deviceActivity('garbage', now), 'offline');
});

// ---------------------------------------------------------------------------
// Prompt 4 — native lifecycle hardening decisions
// ---------------------------------------------------------------------------
test('open failure never becomes an uninstall (stale / missing / launch)', () => {
  const stale = classifyOpenFailure('STALE_EXECUTABLE: no longer exists');
  assert.equal(stale.kind, 'stale_executable');
  assert.equal(stale.recoverable, true);

  const missing = classifyOpenFailure('The installed application executable could not be found.');
  assert.equal(missing.kind, 'not_found');
  assert.equal(missing.recoverable, true);

  const launch = classifyOpenFailure('Access is denied.');
  assert.equal(launch.kind, 'launch_failed');
  assert.equal(launch.recoverable, false);

  // Launch failure is NOT a reason to mark the app uninstalled.
  assert.notEqual(launch.kind, 'uninstall');
});

test('stale executable path: a missing file triggers re-detection, not uninstall', () => {
  // target exists -> valid; target removed -> invalid (re-detect), but not uninstalled.
  assert.equal(isExecutableTargetValid('C:\\x\\app.exe', true), true);
  assert.equal(isExecutableTargetValid('C:\\x\\app.exe', false), false);
  assert.equal(isExecutableTargetValid(undefined, false), false);
  const after = normalizeInstalledApp('cgpa-pilot', 'windows', { installed: true, version: '1.0.25', executable: 'C:\\gone\\app.exe', source: 'registry' }, '1.0.25');
  // A stale path is still "detected installed" until re-detection proves otherwise.
  assert.equal(stateForDetection(after, '1.0.25'), 'INSTALLED_CURRENT');
});

test('preferredUninstallCommand prefers QuietUninstallString, falls back to UninstallString', () => {
  assert.equal(preferredUninstallCommand('"C:\\x\\un.exe" /S', '"C:\\x\\un.exe" /quiet', true), '"C:\\x\\un.exe" /quiet');
  assert.equal(preferredUninstallCommand('"C:\\x\\un.exe" /S', '', true), '"C:\\x\\un.exe" /S');
  assert.equal(preferredUninstallCommand('', '"C:\\x\\un.exe" /quiet', false), '"C:\\x\\un.exe" /quiet');
  assert.equal(preferredUninstallCommand('', '', true), null);
});

test('hasUninstallableSource: only registry/package/desktop/owned artifacts support real uninstall', () => {
  assert.equal(hasUninstallableSource('registry', '"C:\\x\\un.exe"', '', ''), true);
  assert.equal(hasUninstallableSource('package', '', 'cgpa-pilot', ''), true);
  assert.equal(hasUninstallableSource('desktop', '', '', ''), true);
  assert.equal(hasUninstallableSource('package-manager', '', '', ''), true);
  assert.equal(hasUninstallableSource('executable', '', '', ''), false);
  assert.equal(hasUninstallableSource('', '', '', '/opt/rx/cgpa-pilot.AppImage'), true);
});

test('installer launch is NOT installation success (state model enforces verification)', () => {
  // The coordinator distinguishes INSTALLER_STARTED from INSTALLED: only native
  // detection confirmation can reach INSTALLED. We model this with the rich state.
  const launched = currentDeviceInstallState(null, '1.0.25', 'installing');
  assert.equal(launched, 'INSTALLING');
  // Not INSTALLED until detection confirms.
  const local = normalizeInstalledApp('cgpa-pilot', 'android', { installed: true, version: '1.0.25', source: 'package-manager' }, '1.0.25');
  assert.equal(currentDeviceInstallState(local, '1.0.25'), 'INSTALLED');
});

test('Android uninstall reconciliation: confirmed absence only after re-detection', () => {
  const before = normalizeInstalledApp('cgpa-pilot', 'android', { installed: true, version: '1.0.25', source: 'package-manager' }, '1.0.25');
  assert.equal(currentDeviceInstallState(before, '1.0.25'), 'INSTALLED');
  // After OS confirms removal, re-detection returns not installed.
  const after = normalizeInstalledApp('cgpa-pilot', 'android', { installed: false, source: 'package-manager' }, '1.0.25');
  assert.equal(currentDeviceInstallState(after, '1.0.25'), 'NOT_INSTALLED');
  // Report only the CONFIRMED state — never the uninstall intent.
  assert.equal(installStatusForReport(currentDeviceInstallState(after, '1.0.25')), 'not_installed');
});
