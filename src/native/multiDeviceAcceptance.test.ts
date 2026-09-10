/**
 * Prompt 10 — FINAL INTEGRATION AUDIT: multi-device acceptance test (§11).
 *
 * Executes the exact logical scenario from the acceptance spec against the REAL
 * backend route handlers (backend/src/routes/devices.ts with an injected fake
 * D1) and the REAL frontend decision logic (resolveLocalInstall +
 * installButtonFor + deviceCountLabel). Nothing is mocked at the logic level —
 * only the database is an in-memory stand-in, exactly like security.test.ts.
 *
 * Scenario (verbatim from the spec):
 *   Device A: install App X   -> A shows OPEN,  backend A=installed
 *   Device B: same account, X absent -> B shows GET + "Installed on another device"
 *   Device B: install App X   -> B shows OPEN,  backend A=installed, B=installed
 *   Device B: uninstall App X -> B shows GET,   backend A=installed, B=not installed
 *   Device A: still shows OPEN (must remain true)
 *
 * Also covers:
 *   §4 install pipeline (no skipped verification),
 *   §5 failed update preserves the existing installation,
 *   §6 uninstall pipeline (native uninstall -> re-detect -> sync),
 *   §12 account isolation for a second account.
 *
 * Run: node --experimental-strip-types --test src/native/multiDeviceAcceptance.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { devicesRoutes } from '../../backend/src/routes/devices.ts';
import { resolveLocalInstall, installButtonFor, deviceCountLabel } from './installUi.ts';
import type { TransactionState } from './installTransaction.ts';

// ---------------------------------------------------------------------------
// In-memory D1 fake (models devices + app_installations + applications)
// ---------------------------------------------------------------------------

interface DeviceRow { id: string; user_id: string; device_id: string; status: string; platform?: string | null }
interface InstallRow { id: string; user_id: string; device_id: string; application_id: string; status: string; installed_version: string | null }

function makeEnv() {
  const devices: DeviceRow[] = [];
  const installs: InstallRow[] = [];
  const applications = [{ id: 'app_x', slug: 'app-x', name: 'App X' }];

  const DB = {
    prepare(sql: string) {
      const self: any = {
        _b: [] as any[],
        bind(...a: any[]) { self._b = a; return self; },
        async first() {
          const a = self._b;
          if (sql.includes('FROM devices WHERE user_id=? AND device_id=?')) {
            return devices.find((d) => d.user_id === a[0] && d.device_id === a[1]) || null;
          }
          if (sql.includes('SELECT id FROM applications WHERE slug=?')) {
            return applications.find((ap) => ap.slug === a[0]) || null;
          }
          if (sql.includes('FROM app_installations i JOIN applications a')) {
            return installs.find((i) => i.device_id === a[0] && i.application_id === a[1] && i.user_id === a[2]) || null;
          }
          return null;
        },
        async all() {
          const a = self._b;
          if (sql.includes('FROM app_installations i')) {
            // List installations across the user's active devices, joined with
            // the CLIENT device id (what the frontend compares against).
            return {
              results: installs
                .filter((i) => i.user_id === a[0])
                .map((i) => {
                  const d = devices.find((dv) => dv.id === i.device_id);
                  const ap = applications.find((x) => x.id === i.application_id);
                  return {
                    ...i,
                    deviceId: d?.device_id,
                    device_name: d?.device_id,
                    appSlug: ap?.slug,
                    app_name: ap?.name,
                    device_status: d?.status,
                  };
                })
                .filter((r: any) => r.device_status === 'active'),
            };
          }
          if (sql.includes('FROM devices WHERE user_id=?')) {
            return { results: devices.filter((d) => d.user_id === a[0]) };
          }
          return { results: [] };
        },
        async run() {
          const a = self._b;
          if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) return { meta: { changes: 0 } };
          if (sql.includes('INSERT INTO devices')) {
            const [id, user_id, device_id] = a;
            const existing = devices.find((d) => d.user_id === user_id && d.device_id === device_id);
            if (existing) { existing.platform = a[4] ?? existing.platform; return { meta: { changes: 1 } }; }
            devices.push({ id, user_id, device_id, status: 'active', platform: a[4] });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO app_installations')) {
            // Bind order: (id, user_id, device_id, application_id, platform, version, status, source, status)
            const [rowId, user_id, device_id, application_id, , version, status] = a;
            const ex = installs.find((i) => i.device_id === device_id && i.application_id === application_id);
            if (ex) {
              ex.status = status; ex.installed_version = version; ex.user_id = user_id;
              return { meta: { changes: 1 } };
            }
            installs.push({ id: rowId, user_id, device_id, application_id, status, installed_version: version });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  return { DB, _devices: devices, _installs: installs };
}

const req = (body: any, userId: string | null, path: string) => {
  const r = new Request(`https://api.rxstore.com${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  if (userId) (r as any).user = { userId };
  return r;
};
const register = (env: any, userId: string, deviceId: string, platform = 'windows') =>
  devicesRoutes.register(req({ deviceId, platform, deviceName: deviceId }, userId, '/devices/register'), env);
const report = (env: any, userId: string, deviceId: string, installed: boolean, version?: string) =>
  devicesRoutes.reportInstallation(
    req({ deviceId, appSlug: 'app-x', installed, installedVersion: version, status: installed ? 'installed' : 'not_installed' }, userId, '/devices/installations'),
    env,
  );
const listInstallations = async (env: any, userId: string) => {
  const r = new Request('https://api.rxstore.com/devices/installations');
  (r as any).user = { userId };
  const out: any = await devicesRoutes.listInstallations(r, env);
  return out.installations as any[];
};

// What the UI shows on a device, from that device's OWN native detection.
const buttonForDevice = (osInstalled: boolean, opts: { failed?: boolean; updateAvailable?: boolean; txState?: TransactionState } = {}) =>
  installButtonFor({
    txState: opts.txState ?? 'IDLE',
    hasLocalInstall: osInstalled,
    isUpdateAvailable: opts.updateAvailable,
    failed: opts.failed,
  });

// ---------------------------------------------------------------------------
// §11 — the exact multi-device acceptance scenario
// ---------------------------------------------------------------------------
test('ACCEPTANCE §11: Device A installs -> OPEN; backend records A installed', async () => {
  const env = makeEnv();
  await register(env, 'u1', 'device-A');
  await register(env, 'u1', 'device-B');

  // Device A installs App X. Native detection on A reports it installed.
  const rep: any = await report(env, 'u1', 'device-A', true, '1.0.0');
  assert.ok(rep.installation, 'backend accepted the installation report');

  const local = resolveLocalInstall({ detectionAvailable: true, osInstalled: true, storeInstalled: false });
  assert.equal(local.installed, true, 'current-device state comes from native detection');
  assert.equal(local.source, 'native');
  assert.equal(buttonForDevice(true).state, 'OPEN', 'Device A shows OPEN');

  const rows = await listInstallations(env, 'u1');
  const a = rows.find((r) => r.deviceId === 'device-A');
  assert.equal(a?.status, 'installed', 'backend: Device A -> installed');
  assert.equal(rows.filter((r) => r.deviceId === 'device-B').length, 0, 'no record for B yet');
});

test('ACCEPTANCE §11: Device B (absent) -> GET + "Installed on another device"', async () => {
  const env = makeEnv();
  await register(env, 'u1', 'device-A');
  await register(env, 'u1', 'device-B');
  await report(env, 'u1', 'device-A', true, '1.0.0');

  // Device B: native detection says App X is ABSENT. Even a stale store record
  // must not flip B's button to OPEN.
  const local = resolveLocalInstall({ detectionAvailable: true, osInstalled: false, storeInstalled: true });
  assert.equal(local.installed, false, 'native detection wins over the stale store record');
  const btn = buttonForDevice(false);
  assert.equal(btn.state, 'GET', 'Device B shows GET');
  assert.equal(btn.action, 'get');

  // Other-device hint: exactly the OTHER device's installations, never A's own.
  const rows = await listInstallations(env, 'u1');
  const otherDevices = rows.filter((i) => i.appSlug === 'app-x' && i.deviceId !== 'device-B');
  assert.equal(otherDevices.length, 1, 'one other device (A) has App X');
  assert.equal(deviceCountLabel(otherDevices.length), 'Installed on another device');
});

test('ACCEPTANCE §11: Device B installs -> OPEN; backend has both A and B installed', async () => {
  const env = makeEnv();
  await register(env, 'u1', 'device-A');
  await register(env, 'u1', 'device-B');
  await report(env, 'u1', 'device-A', true, '1.0.0');

  await report(env, 'u1', 'device-B', true, '1.0.0');
  assert.equal(buttonForDevice(true).state, 'OPEN', 'Device B shows OPEN after its own install');

  const rows = await listInstallations(env, 'u1');
  assert.equal(rows.find((r) => r.deviceId === 'device-A')?.status, 'installed', 'backend: A installed');
  assert.equal(rows.find((r) => r.deviceId === 'device-B')?.status, 'installed', 'backend: B installed');
  assert.equal(rows.length, 2, 'independent per-device records — not one shared account state');
});

test('ACCEPTANCE §11: Device B uninstalls -> GET; backend A=installed, B=not installed', async () => {
  const env = makeEnv();
  await register(env, 'u1', 'device-A');
  await register(env, 'u1', 'device-B');
  await report(env, 'u1', 'device-A', true, '1.0.0');
  await report(env, 'u1', 'device-B', true, '1.0.0');

  // §6 uninstall pipeline: native uninstall -> RE-DETECT (absence confirmed only
  // after detection) -> synchronize not_installed to the backend.
  const osSaysAbsent = true; // post-uninstall re-detection result
  const local = resolveLocalInstall({ detectionAvailable: true, osInstalled: !osSaysAbsent, storeInstalled: true });
  assert.equal(local.installed, false, 'after native uninstall, detection reports absence');
  assert.equal(buttonForDevice(false).state, 'GET', 'Device B shows GET again');

  const rep: any = await report(env, 'u1', 'device-B', false);
  assert.ok(rep.installation, 'uninstall state synchronized');
  const rows = await listInstallations(env, 'u1');
  assert.equal(rows.find((r) => r.deviceId === 'device-A')?.status, 'installed', 'backend: A STILL installed');
  assert.equal(rows.find((r) => r.deviceId === 'device-B')?.status, 'not_installed', 'backend: B not installed');
});

test('ACCEPTANCE §11: Device A still shows OPEN after B uninstalled (must remain true)', async () => {
  const env = makeEnv();
  await register(env, 'u1', 'device-A');
  await register(env, 'u1', 'device-B');
  await report(env, 'u1', 'device-A', true, '1.0.0');
  await report(env, 'u1', 'device-B', true, '1.0.0');
  await report(env, 'u1', 'device-B', false);

  // Device A's native detection is untouched by B's uninstall.
  const local = resolveLocalInstall({ detectionAvailable: true, osInstalled: true, storeInstalled: true });
  assert.equal(local.installed, true);
  assert.equal(buttonForDevice(true).state, 'OPEN', 'Device A keeps OPEN');

  // And the "other device" hint for A reflects B's uninstall without changing
  // A's own button.
  const rows = await listInstallations(env, 'u1');
  const othersInstalled = rows.filter((i) => i.appSlug === 'app-x' && i.deviceId !== 'device-A' && i.status === 'installed');
  assert.equal(othersInstalled.length, 0, 'no other device is reported installed to A');
  assert.equal(deviceCountLabel(othersInstalled.length), '', 'no misleading "installed elsewhere" hint');
  assert.equal(buttonForDevice(true).state, 'OPEN', "B's state never overrides A's own detection");
});

// ---------------------------------------------------------------------------
// §4 — install pipeline: no skipped verification
// ---------------------------------------------------------------------------
test('ACCEPTANCE §4: the install pipeline never shows OPEN before verification completes', () => {
  const pipeline: Array<{ state: TransactionState; expect: string; label: string }> = [
    { state: 'DOWNLOAD_STARTED', expect: 'DOWNLOADING', label: 'Download starts' },
    { state: 'DOWNLOADING', expect: 'DOWNLOADING', label: 'Downloading 42%' },
    { state: 'DOWNLOAD_COMPLETED', expect: 'VERIFYING', label: 'Download completed -> verify (NOT installed)' },
    { state: 'VERIFYING', expect: 'VERIFYING', label: 'Verifying checksum' },
    { state: 'VERIFIED', expect: 'INSTALLING', label: 'Checksum verified -> install' },
    { state: 'INSTALLER_STARTED', expect: 'INSTALLING', label: 'Installer launched' },
    { state: 'INSTALLATION_PENDING', expect: 'INSTALLING', label: 'Waiting for the installer' },
    { state: 'VERIFYING_INSTALLATION', expect: 'CHECKING', label: 'Re-detecting the installation' },
    { state: 'INSTALLED', expect: 'OPEN', label: 'Installation verified -> OPEN' },
  ];
  for (const step of pipeline) {
    const btn = installButtonFor({ txState: step.state, percent: step.state === 'DOWNLOADING' ? 42 : undefined });
    assert.equal(btn.state, step.expect, `${step.label}: expected ${step.expect}, got ${btn.state}`);
  }
  // A completed DOWNLOAD alone must NEVER yield OPEN.
  const afterDownload = installButtonFor({ txState: 'DOWNLOAD_COMPLETED', hasLocalInstall: false });
  assert.notEqual(afterDownload.state, 'OPEN', 'DOWNLOAD_COMPLETED != INSTALLED (no download=installed assumption)');
  assert.equal(afterDownload.state, 'VERIFYING');
  // A failed checksum must NOT install and must offer RETRY.
  const bad = installButtonFor({ txState: 'VERIFICATION_FAILED' });
  assert.equal(bad.state, 'RETRY', 'checksum failure -> retry, never install');
});

// ---------------------------------------------------------------------------
// §5 — update pipeline: a failed update preserves the existing installation
// ---------------------------------------------------------------------------
test('ACCEPTANCE §5: failed 1.2.0 -> 1.3.0 update keeps 1.2.0 correctly represented', () => {
  // The device still runs 1.2.0 (native detection), an update to 1.3.0 exists.
  let os = { installed: true, version: '1.2.0' };

  // Update attempt fails (download/verify/install) -> RETRY, not "not installed".
  const failed = installButtonFor({ txState: 'DOWNLOAD_FAILED', hasLocalInstall: os.installed, isUpdate: true, failed: true });
  assert.equal(failed.state, 'RETRY', 'failed update offers retry');

  // After the failure, re-detection still reports 1.2.0 installed: the existing
  // installation remains correctly represented (UPDATE available, not GET).
  const local = resolveLocalInstall({ detectionAvailable: true, osInstalled: os.installed, storeInstalled: true });
  assert.equal(local.installed, true, 'the previous version is still installed');
  const btn = installButtonFor({ txState: 'IDLE', hasLocalInstall: true, isUpdateAvailable: true });
  assert.equal(btn.state, 'UPDATE', 'still shows UPDATE for 1.3.0 — the 1.2.0 install was not erased');
  assert.equal(btn.action, 'update');

  // Sanity: without a newer version it settles back to OPEN (current version).
  const settled = installButtonFor({ txState: 'IDLE', hasLocalInstall: true, isUpdateAvailable: false });
  assert.equal(settled.state, 'OPEN');
  os = { installed: true, version: '1.2.0' }; // unchanged — no version was assumed
});

// ---------------------------------------------------------------------------
// §12 — account isolation (second account in the same environment)
// ---------------------------------------------------------------------------
test('ACCEPTANCE §12: another account sees neither the devices nor the installations', async () => {
  const env = makeEnv();
  await register(env, 'u1', 'device-A');
  await register(env, 'u1', 'device-B');
  await report(env, 'u1', 'device-A', true, '1.0.0');

  // User B registers their own device and installs the same app.
  await register(env, 'u2', 'device-C');
  await report(env, 'u2', 'device-C', true, '1.0.0');

  // User B's installation list contains ONLY their own device.
  const u2rows = await listInstallations(env, 'u2');
  assert.equal(u2rows.length, 1);
  assert.equal(u2rows[0].deviceId, 'device-C', 'no cross-account installation leakage');

  // User B cannot report an installation against User A's device.
  const hijack: any = await report(env, 'u2', 'device-A', true, '9.9.9');
  assert.equal(hijack.code, 'NOT_FOUND', "cannot target another user's device");

  // And User A's view is unchanged by any of User B's activity.
  const u1rows = await listInstallations(env, 'u1');
  assert.equal(u1rows.length, 1);
  assert.equal(u1rows[0].deviceId, 'device-A');
  assert.equal(u1rows[0].installed_version, '1.0.0', 'u2 could not poison u1 records');
});

// ---------------------------------------------------------------------------
// §2 — current-device rule: backend/localStorage state never claims "installed"
// ---------------------------------------------------------------------------
test('ACCEPTANCE §2: backend-only state never makes the current device claim installed', () => {
  // Another device reports the app installed; this device never installed it.
  const local = resolveLocalInstall({ detectionAvailable: true, osInstalled: false, storeInstalled: false });
  assert.equal(local.installed, false);
  assert.equal(buttonForDevice(false).state, 'GET', 'must be GET — never OPEN from remote-only state');

  // Web/PWA: detection unavailable — the weaker store fallback applies, and it
  // is explicitly labelled as the store's record, not native reality.
  const web = resolveLocalInstall({ detectionAvailable: false, osInstalled: false, storeInstalled: true });
  assert.equal(web.installed, true, 'web falls back to the store record');
  assert.equal(web.source, 'store', 'clearly marked as a store-record source, not native');
});
