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
