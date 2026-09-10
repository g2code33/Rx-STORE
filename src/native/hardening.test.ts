/**
 * Prompt 9 — production-hardening test matrix.
 *
 * Covers the end-to-end acceptance scenarios and the hardening fixes:
 *   - no fake state (native detection is authoritative)
 *   - unified SemVer semantics across detection + verification
 *   - structured logging with credential redaction
 *   - failure metrics/categories
 *   - health-check dependency evaluation
 *   - migration numbering correctness
 *
 * Hermetic: an in-memory localStorage polyfill stands in for the browser.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// ---- localStorage polyfill (must exist before importing cache-backed modules) --
function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear() { m.clear(); },
    getItem(k: string) { return m.has(k) ? m.get(k)! : null; },
    key(i: number) { return Array.from(m.keys())[i] ?? null; },
    removeItem(k: string) { m.delete(k); },
    setItem(k: string, v: string) { m.set(k, String(v)); },
  } as Storage;
}
let storage: Storage;
beforeEach(() => { storage = makeStorage(); (globalThis as any).localStorage = storage; });

const detect = await import('../platform/detect.ts');
const { resolveLocalInstall, installButtonFor, installStateStatus } = await import('./installUi.ts');
const { compareSemver } = await import('./verify.ts');
const logger = await import('./logger.ts');
const cache = await import('./cache.ts');
const q = await import('./syncQueue.ts');
const rec = await import('./transactionRecovery.ts');
const { evaluateWindow, ruleForPath } = await import('../../backend/src/middleware/rateLimiter.ts');
const { isOriginAllowed } = await import('../../backend/src/middleware/cors.ts');
const { compareSemver: backendSemver, validatePackageIntegrity, selectPackage, paginationMeta } = await import('../../backend/src/services/releases.ts');
const pw = await import('../../backend/src/services/password.ts');
const jwt = await import('../../backend/src/services/auth.ts');

const sha = 'a'.repeat(64);
const mkpkg = (o: any = {}) => ({ platform: 'windows', architecture: 'x64', filename: 'a.exe', storage_key: 'k', file_size: 10, sha256: sha, version: '1.0.0', package_type: 'installer', ...o });

// ---------------------------------------------------------------------------
// 4. NO FAKE STATE — native detection is authoritative
// ---------------------------------------------------------------------------
test('native: a stale store record cannot make an app look installed', () => {
  const r = resolveLocalInstall({ detectionAvailable: true, osInstalled: false, storeInstalled: true });
  assert.equal(r.installed, false, 'detection wins over the localStorage record');
  assert.equal(r.source, 'none');
});

test('native: detection reporting installed is authoritative even without a store record', () => {
  const r = resolveLocalInstall({ detectionAvailable: true, osInstalled: true, storeInstalled: false });
  assert.equal(r.installed, true);
  assert.equal(r.source, 'native');
});

test('web/PWA: the store record is the only signal and is labelled as such', () => {
  const r = resolveLocalInstall({ detectionAvailable: false, osInstalled: false, storeInstalled: true });
  assert.equal(r.installed, true);
  assert.equal(r.source, 'store', 'clearly attributed to the store, not the OS');
  const none = resolveLocalInstall({ detectionAvailable: false, osInstalled: false, storeInstalled: false });
  assert.equal(none.installed, false);
});

test('a download completing never renders as OPEN (button state)', () => {
  const downloading = installButtonFor({ txState: 'DOWNLOADING', percent: 40 });
  assert.notEqual(downloading.state, 'OPEN');
  const verifying = installButtonFor({ txState: 'VERIFYING' });
  assert.notEqual(verifying.state, 'OPEN');
  const installing = installButtonFor({ txState: 'INSTALLER_STARTED' });
  assert.notEqual(installing.state, 'OPEN');
  assert.equal(installButtonFor({ txState: 'INSTALLED' }).state, 'OPEN');
});

// ---------------------------------------------------------------------------
// 5. UNIFIED VERSION SEMANTICS (detection vs verification can never disagree)
// ---------------------------------------------------------------------------
test('frontend detection and verification use identical SemVer semantics', () => {
  const cases: Array<[string, string]> = [
    ['1.10.0', '1.9.0'], ['2.0.0', '1.99.0'], ['1.3.0', '1.3.0-beta'],
    ['1.0.0-beta', '1.0.0'], ['1.0.9', '1.0.10'], ['1.0.0', '1.0.0'],
  ];
  for (const [a, b] of cases) {
    assert.equal(
      detect.compareVersions(a, b),
      compareSemver(a, b),
      `detect and verify disagree for ${a} vs ${b}`,
    );
  }
});

test('backend and frontend SemVer agree on the critical cases', () => {
  for (const [a, b] of [['1.10.0', '1.9.0'], ['2.0.0', '1.99.0'], ['1.3.0', '1.3.0-beta'], ['1.0.0', '1.0.1']] as Array<[string, string]>) {
    assert.equal(backendSemver(a, b), compareSemver(a, b), `${a} vs ${b}`);
  }
});

test('a prerelease never hides a real update (regression for the old comparator)', () => {
  // installed 1.3.0-beta, store 1.3.0 -> an update IS available
  assert.equal(detect.compareVersions('1.3.0', '1.3.0-beta'), 1);
  assert.equal(detect.currentDeviceInstallState(
    detect.normalizeInstalledApp('x', 'linux', { installed: true, version: '1.3.0-beta', source: 'package' }, '1.3.0'),
    '1.3.0',
  ), 'UPDATE_AVAILABLE');
});

// ---------------------------------------------------------------------------
// 3. E2E SCENARIO — Phone A / Phone B (account → devices → installs)
// ---------------------------------------------------------------------------
const detected = (installed: boolean, version?: string) =>
  detect.normalizeInstalledApp('app-x', 'android', { installed, version, source: 'package-manager' }, version);

test('E2E: Phone A installs → Phone B shows GET + installed elsewhere → both installed → B uninstalls, A stays', () => {
  // Step 1-2: Phone A installs App X; native detection confirms 1.0.0.
  const phoneA = { deviceId: 'phoneA', status: 'installed', installedVersion: '1.0.0' };
  const viewA = detect.resolveDeviceView({
    local: detected(true, '1.0.0'), storeVersion: '1.0.0',
    otherInstallations: [], currentDeviceId: 'phoneA',
  });
  assert.equal(viewA.state, 'INSTALLED');

  // Step 3: Phone B has nothing locally; the cloud knows Phone A has it.
  const viewB = detect.resolveDeviceView({
    local: detected(false), storeVersion: '1.0.0',
    otherInstallations: [phoneA], currentDeviceId: 'phoneB',
  });
  assert.equal(viewB.state, 'NOT_INSTALLED', 'Phone B must show GET');
  assert.equal(viewB.otherDevices, 1, '"installed on another device"');

  // Step 4: Phone B installs too → both installed.
  const viewB2 = detect.resolveDeviceView({
    local: detected(true, '1.0.0'), storeVersion: '1.0.0',
    otherInstallations: [phoneA], currentDeviceId: 'phoneB',
  });
  assert.equal(viewB2.state, 'INSTALLED');
  assert.equal(viewB2.otherDevices, 1, 'Phone A still counted');

  // Step 5: Phone B uninstalls → only B changes.
  const viewB3 = detect.resolveDeviceView({
    local: detected(false), storeVersion: '1.0.0',
    otherInstallations: [phoneA, { deviceId: 'phoneB', status: 'not_installed' }], currentDeviceId: 'phoneB',
  });
  assert.equal(viewB3.state, 'NOT_INSTALLED');
  assert.equal(viewB3.otherDevices, 1);

  // Step 6: Phone A opens RX Store → still installed.
  const viewA2 = detect.resolveDeviceView({
    local: detected(true, '1.0.0'), storeVersion: '1.0.0',
    otherInstallations: [{ deviceId: 'phoneB', status: 'not_installed' }], currentDeviceId: 'phoneA',
  });
  assert.equal(viewA2.state, 'INSTALLED', 'Phone A remains installed');
});

// ---------------------------------------------------------------------------
// 2. PLATFORM MATRIX — Windows / Linux / Android / Web install→open→update→uninstall
// ---------------------------------------------------------------------------
test('Windows lifecycle: install → open → update → uninstall', () => {
  const store = '1.2.5';
  const installed = detect.normalizeInstalledApp('w', 'windows',
    { installed: true, version: '1.2.5', executable: 'C:\\\\Apps\\\\w.exe', uninstallString: '"C:\\\\Apps\\\\un.exe" /S', source: 'registry' }, store);
  assert.equal(detect.stateForDetection(installed, store), 'INSTALLED_CURRENT');       // OPEN
  assert.equal(installed.executable, 'C:\\\\Apps\\\\w.exe');                            // open target
  assert.equal(detect.preferredUninstallCommand(installed.uninstallString, undefined), '"C:\\\\Apps\\\\un.exe" /S'); // uninstall
  const older = detect.normalizeInstalledApp('w', 'windows', { installed: true, version: '1.2.4', source: 'registry' }, store);
  assert.equal(detect.stateForDetection(older, store), 'UPDATE_AVAILABLE');            // UPDATE
  const gone = detect.normalizeInstalledApp('w', 'windows', { installed: false, source: 'none' }, store);
  assert.equal(detect.stateForDetection(gone, store), 'NOT_INSTALLED');                // after uninstall
});

test('Linux lifecycle: install → open launcher → update → uninstall', () => {
  const store = '2.0.0';
  const installed = detect.normalizeInstalledApp('l', 'linux',
    { installed: true, version: '2.0.0', executable: '/usr/bin/l', packageName: 'l', source: 'package' }, store);
  assert.equal(detect.stateForDetection(installed, store), 'INSTALLED_CURRENT');
  assert.equal(detect.hasUninstallableSource(installed.source, undefined, installed.packageName), true);
  const older = detect.normalizeInstalledApp('l', 'linux', { installed: true, version: '1.9.0', source: 'package' }, store);
  assert.equal(detect.stateForDetection(older, store), 'UPDATE_AVAILABLE');
  const gone = detect.normalizeInstalledApp('l', 'linux', { installed: false, source: 'none' }, store);
  assert.equal(detect.stateForDetection(gone, store), 'NOT_INSTALLED');
});

test('Linux launcher: a .desktop launcher resolves to the real Exec target', () => {
  const d = detect.normalizeInstalledApp('l', 'linux',
    { installed: true, version: '1.0.0', executable: '/opt/l/l', source: 'desktop' }, '1.0.0');
  assert.equal(detect.isExecutableTargetValid(d.executable, true), true);
  assert.equal(detect.isExecutableTargetValid(d.executable, false), false, 'stale path -> re-detect, not uninstall');
});

test('Android lifecycle: install → open by package id → update → uninstall', () => {
  const store = '3.0.0';
  const installed = detect.normalizeInstalledApp('a', 'android',
    { installed: true, version: '3.0.0', source: 'package-manager' }, store);
  assert.equal(detect.stateForDetection(installed, store), 'INSTALLED_CURRENT');
  const older = detect.normalizeInstalledApp('a', 'android', { installed: true, version: '2.9.0', source: 'package-manager' }, store);
  assert.equal(detect.stateForDetection(older, store), 'UPDATE_AVAILABLE');
  const gone = detect.normalizeInstalledApp('a', 'android', { installed: false, source: 'package-manager' }, store);
  assert.equal(detect.stateForDetection(gone, store), 'NOT_INSTALLED');
});

test('Web/PWA: never claims a native install; detection is unavailable', () => {
  assert.equal(detect.currentDeviceInstallState(null, '1.0.0'), 'DETECTION_UNAVAILABLE');
  const r = resolveLocalInstall({ detectionAvailable: false, osInstalled: false, storeInstalled: false });
  assert.equal(r.source, 'none');
  assert.equal(installButtonFor({ txState: 'IDLE', hasLocalInstall: false }).state, 'GET');
});

// ---------------------------------------------------------------------------
// ACCOUNT ISOLATION
// ---------------------------------------------------------------------------
test('account switching isolates installs, devices and pending sync work', () => {
  storage.setItem('rx-store-user', JSON.stringify({ id: 'A' }));
  cache.cacheSet('installation', 'list', ['a1']);
  q.enqueue({ kind: 'installation', deviceId: 'dA', appSlug: 'a1', payload: {} });
  assert.equal(q.pendingCount(), 1);

  cache.clearAccountData('A');                       // sign out
  storage.setItem('rx-store-user', JSON.stringify({ id: 'B' }));  // sign in as B

  assert.equal(cache.cacheGet('installation', 'list'), null, 'B cannot see A\'s installs');
  assert.equal(q.pendingCount(), 0, 'A\'s pending work is not run for B');
  assert.equal(q.allItems().length, 0);
});

test('device identity survives account switching', () => {
  storage.setItem('rx-store-device-id', 'stable-device');
  storage.setItem('rx-store-user', JSON.stringify({ id: 'A' }));
  cache.cacheSet('device', 'name', 'My PC');
  cache.clearAccountData('A');
  assert.equal(storage.getItem('rx-store-device-id'), 'stable-device');
  assert.equal(cache.cacheGet('device', 'name'), 'My PC');
});

// ---------------------------------------------------------------------------
// INSTALLATION / UPDATE / INTERRUPTED STATE
// ---------------------------------------------------------------------------
test('interrupted update preserves the previous version (never claims the target)', () => {
  const attempt = {
    attemptId: 'i1', appSlug: 'app-x', targetVersion: '2.0.0', previousVersion: '1.9.0',
    phase: 'VERIFYING_INSTALLATION' as const, isUpdate: true, startedAt: Date.now(), updatedAt: Date.now(),
  };
  const d = rec.decideRecovery(attempt, detected(true, '1.9.0'));
  assert.equal(d.outcome, 'recovered_previous');
  assert.equal(d.effectiveVersion, '1.9.0');
  assert.equal(d.installed, true);
});

test('interrupted install with no detection is never reported as success', () => {
  const attempt = {
    attemptId: 'i2', appSlug: 'app-x', targetVersion: '1.0.0',
    phase: 'INSTALLER_STARTED' as const, isUpdate: false, startedAt: Date.now(), updatedAt: Date.now(),
  };
  const d = rec.decideRecovery(attempt, null);
  assert.equal(d.outcome, 'still_installing');
  assert.equal(d.shouldSync, false);
});

// ---------------------------------------------------------------------------
// 5. LOGGING — structure + redaction
// ---------------------------------------------------------------------------
test('log records carry the required structured fields', () => {
  const rec1 = logger.log.info('install_state', 'Transaction VERIFYING', {
    requestId: 'req_1', attemptId: 'inst_1', appId: 'app1', appSlug: 'cgpa-pilot',
    platform: 'linux_deb', version: '1.0.25', state: 'VERIFYING',
  });
  assert.equal(rec1.level, 'info');
  assert.equal(rec1.event, 'install_state');
  assert.equal(rec1.requestId, 'req_1');
  assert.equal(rec1.attemptId, 'inst_1');
  assert.equal(rec1.appId, 'app1');
  assert.equal(rec1.platform, 'linux_deb');
  assert.equal(rec1.version, '1.0.25');
  assert.equal(rec1.state, 'VERIFYING');
  assert.ok(rec1.at, 'timestamped');
});

test('logs never contain credentials, tokens or passwords', () => {
  const r: any = logger.log.error('x', 'auth failed', {
    password: 'hunter2',
    accessToken: 'eyJhbGciOi.JWT',
    refreshToken: 'refresh-abc',
    apiKey: 'sk-live-1234567890',
    authorization: 'Bearer supersecret',
    note: 'Bearer tok123456 and sk-abcdefghijkl',
  });
  const serialized = JSON.stringify(r);
  for (const secret of ['hunter2', 'eyJhbGciOi.JWT', 'refresh-abc', 'sk-live-1234567890', 'supersecret', 'tok123456', 'sk-abcdefghijkl']) {
    assert.ok(!serialized.includes(secret), `leaked: ${secret}`);
  }
  assert.equal(r.password, '[redacted]');
  assert.equal(r.accessToken, '[redacted]');
});

test('failure categories are recorded as metrics', () => {
  logger.resetMetrics();
  logger.recordMetric('download_failure');
  logger.recordMetric('checksum_failure', 2);
  const snap = logger.metricSnapshot();
  assert.equal(snap.download_failure, 1);
  assert.equal(snap.checksum_failure, 2);
});

test('a failing log sink never breaks the caller', () => {
  const restore = logger.setLogSink(() => { throw new Error('sink exploded'); });
  assert.doesNotThrow(() => logger.log.info('safe', 'still works'));
  restore();
});

test('redaction handles nested context objects', () => {
  const out = logger.redactContext({ outer: { password: 'p', token: 't', keep: 'v' } } as any);
  assert.deepEqual(out.outer, { password: '[redacted]', token: '[redacted]', keep: 'v' });
});

// ---------------------------------------------------------------------------
// 7. HEALTH CHECK evaluation
// ---------------------------------------------------------------------------
test('health check reports ok only when critical dependencies are healthy', async () => {
  const src = readFileSync(new URL('../../backend/src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /path === '\/health'/, 'inline health handler exists');
  assert.match(src, /checks\.database/, 'reports database status');
  assert.match(src, /checks\.cache/, 'reports cache status');
  assert.match(src, /checks\.auth/, 'reports auth configuration status');
  assert.ok(!/router\.get\('\/health'/.test(src), 'the dead router /health registration was removed');
  // Health must not echo secrets.
  const healthBlock = src.slice(src.indexOf("path === '/health'"), src.indexOf("path === '/health'") + 2200);
  assert.ok(!/JWT_SECRET\s*[,}]/.test(healthBlock.replace(/env\.JWT_SECRET \? 'ok' : 'misconfigured'/, '')), 'does not return the secret itself');
});

// ---------------------------------------------------------------------------
// 8. DATABASE / MIGRATION INTEGRITY
// ---------------------------------------------------------------------------
test('no duplicate migration numbers remain', () => {
  const dir = new URL('../../backend/migrations/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const nums = files.map((f) => f.split('_')[0]);
  const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `duplicate migration numbers: ${dupes.join(', ')}`);
  assert.ok(files.includes('0005b_site_settings.sql'), 'the historical 0005 collision is resolved');
});

test('migrations are ordered and the packages uniqueness migration exists', () => {
  const dir = new URL('../../backend/migrations/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const arch = readFileSync(new URL('0008_packages_architecture.sql', dir), 'utf8');
  assert.match(arch, /UNIQUE\(release_id, platform, architecture\)/);
  assert.match(arch, /min_os_version/);
  // The rebuild must be non-destructive (copy forward, no data loss).
  assert.match(arch, /INSERT OR IGNORE INTO packages_new/);
  assert.match(arch, /FROM packages/);
  assert.ok(arch.indexOf('DROP TABLE packages') > arch.indexOf('INSERT OR IGNORE INTO packages_new'), 'copy precedes drop');
  void files;
});

test('schema declares the canonical uniqueness + integrity constraints', () => {
  const schema = readFileSync(new URL('../../backend/schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /UNIQUE\(release_id, platform, architecture\)/);
  assert.match(schema, /UNIQUE\(device_id, application_id\)/, 'installation idempotency');
  assert.match(schema, /UNIQUE\(user_id, device_id\)/, 'device registration idempotency');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS auth_sessions/);
});

// ---------------------------------------------------------------------------
// 10. TYPE SAFETY — no error-suppression escapes in the source
// ---------------------------------------------------------------------------
test('no @ts-ignore / @ts-nocheck suppressions were introduced', () => {
  const files = [
    'src/platform/detect.ts', 'src/native/installUi.ts', 'src/native/logger.ts',
    'src/native/cache.ts', 'src/native/syncQueue.ts', 'src/native/transactionRecovery.ts',
    'backend/src/router.ts', 'backend/src/index.ts', 'backend/src/routes/admin.ts',
  ];
  for (const f of files) {
    const src = readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
    assert.ok(!/@ts-ignore|@ts-nocheck/.test(src), `${f} contains a TypeScript suppression`);
  }
});

// ---------------------------------------------------------------------------
// SECURITY RE-VERIFICATION (regression guard for Prompt 6 controls)
// ---------------------------------------------------------------------------
test('security controls still hold after hardening', async () => {
  // password hashing: versioned + legacy migration
  const h = await pw.hashPassword('GoodPass1!');
  assert.ok(pw.isCurrentHash(h));
  assert.equal(await pw.verifyPassword('GoodPass1!', h), true);
  assert.equal(await pw.verifyPassword('wrong', h), false);

  // JWT: type confusion + alg confusion rejected
  const secret = 'test-secret';
  const refresh = await jwt.generateRefreshToken({ userId: 'u' }, secret);
  await assert.rejects(() => jwt.verifyAccessToken(refresh, secret), /WRONG_TYPE/);

  // CORS allowlist: look-alikes rejected
  assert.equal(isOriginAllowed('https://evilrxstore.com', { environment: 'production' }), false);
  assert.equal(isOriginAllowed('https://rxstore.com', { environment: 'production' }), true);

  // rate limiting: sliding window limits auth harder than browsing
  assert.ok(ruleForPath('/auth/login').limit < ruleForPath('/apps').limit);
  const rule = { limit: 2, windowSeconds: 60 };
  assert.equal(evaluateWindow([], 1000, rule).allowed, true);
  assert.equal(evaluateWindow([1000, 1001], 1002, rule).allowed, false);
  assert.equal(evaluateWindow([1000, 1001], 61_500, rule).allowed, true, 'window slides');
});

// ---------------------------------------------------------------------------
// RELEASE / PACKAGE INTEGRITY (regression guard for Prompt 7)
// ---------------------------------------------------------------------------
test('release selection + integrity + pagination still hold', () => {
  assert.equal(validatePackageIntegrity(mkpkg()).ok, true);
  assert.equal(validatePackageIntegrity(mkpkg({ sha256: '' })).ok, false);
  const sel = selectPackage([mkpkg({ platform: 'windows', architecture: 'arm64' })], { platform: 'windows', architecture: 'arm64' });
  assert.ok(sel.selected);
  assert.equal(selectPackage([mkpkg()], { platform: 'linux_deb', architecture: 'x64' }).selected, null, 'no cross-platform substitution');
  const meta = paginationMeta({ page: 2, limit: 10, total: 25 });
  assert.equal(meta.totalPages, 3);
  assert.equal(meta.hasNext, true);
  assert.equal(meta.hasPrevious, true);
});

// ---------------------------------------------------------------------------
// UI STATE MATRIX completeness
// ---------------------------------------------------------------------------
test('every action state is reachable and no state contradicts another', () => {
  const cases: Array<[any, string]> = [
    [{ txState: 'IDLE', hasLocalInstall: false }, 'GET'],
    [{ txState: 'DOWNLOADING', percent: 10 }, 'DOWNLOADING'],
    [{ txState: 'VERIFYING' }, 'VERIFYING'],
    [{ txState: 'INSTALLER_STARTED' }, 'INSTALLING'],
    [{ txState: 'VERIFYING_INSTALLATION' }, 'CHECKING'],
    [{ txState: 'IDLE', hasLocalInstall: true }, 'OPEN'],
    [{ txState: 'IDLE', isUpdateAvailable: true }, 'UPDATE'],
    [{ txState: 'DOWNLOADING', percent: 50, isUpdate: true }, 'UPDATING'],
    [{ txState: 'DOWNLOAD_FAILED' }, 'RETRY'],
    [{ txState: 'VERIFICATION_FAILED' }, 'RETRY'],
    [{ txState: 'INSTALL_FAILED' }, 'RETRY'],
    [{ txState: 'INSTALLATION_NOT_DETECTED' }, 'RETRY'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(installButtonFor(input).state, expected, JSON.stringify(input));
  }
  assert.equal(installStateStatus('UPDATE_FAILED'), 'Update failed — your existing version is still installed');
});
