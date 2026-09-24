/**
 * Unit tests for startup session restoration (auth persistence phase).
 *
 * These encode the RX Store session contract:
 *   - a stored, valid credential restores the authenticated user on launch
 *   - an EXPIRED access token is refreshed silently — never a sign-out
 *   - a network/offline failure keeps credentials (retry later)
 *   - ONLY an explicit server rejection (revoked/invalid session) clears them
 *
 * Plus the application-UPDATE regressions (an update must never sign out):
 *   1. update → version change → restore → still signed in
 *   2. update → access token expired → refresh → still signed in
 *   3. update → server revoked the session → refresh → signed out (correct)
 *
 * The "new app version" is simulated by constructing a FRESH deps object over
 * the same persisted storage — exactly what a relaunched bundle does. The
 * restoration logic must depend only on the persisted state, never on in-memory
 * state from the previous version.
 *
 * Run: node --experimental-strip-types --test src/native/sessionRestore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { restoreSession, type RestoreDeps, type RefreshOutcome } from './sessionRestore.ts';

/** Persistent "device storage" shared across simulated app versions. */
interface DeviceStorage {
  access: string | null;
  refresh: string | null;
  cleared: number;
}

interface ServerModel {
  /** What the server does when the stored refresh credential is presented. */
  refreshBehaviour: RefreshOutcome;
  /** What /users/me does: accept, reject the STALE token only, reject all, or drop the connection. */
  meBehaviour: 'ok' | 'reject-stale' | 'reject-always' | 'network';
  user: { id: string; name: string; email: string };
  rotatedRefresh: string;
}

/**
 * Build RestoreDeps exactly like AuthContext does — reading from the persisted
 * storage, hitting the (simulated) server. Each call = one app launch.
 */
function launchAppVersion(storage: DeviceStorage, srv: ServerModel): RestoreDeps {
  return {
    hasAccessToken: () => !!storage.access,
    hasRefreshToken: () => !!storage.refresh,
    async fetchMe() {
      if (srv.meBehaviour === 'network') throw new TypeError('fetch failed');
      // A real server rejects the EXPIRED access token but accepts the fresh
      // one issued moments later — 'reject-stale' models exactly that.
      const stale = storage.access === 'access-v1';
      if (srv.meBehaviour === 'reject-always' || (srv.meBehaviour === 'reject-stale' && stale)) {
        const e: any = new Error('Invalid or expired token');
        e.status = 401;
        throw e;
      }
      return { user: srv.user };
    },
    async attemptRefresh(): Promise<RefreshOutcome> {
      if (srv.refreshBehaviour === 'ok') {
        // Rotation: new pair issued; client persists both (never deletes first).
        storage.access = 'new-access-token';
        storage.refresh = srv.rotatedRefresh;
        return 'ok';
      }
      // 'rejected' → restoreSession clears the stored credentials itself.
      return srv.refreshBehaviour;
    },
    clearCredentials: () => {
      storage.access = null;
      storage.refresh = null;
      storage.cleared++;
    },
    isNetworkError: (e: any) => !e?.status,
  };
}

function freshDevice(): DeviceStorage {
  return { access: 'access-v1', refresh: 'rxr_credential_v1', cleared: 0 };
}

const server = (over: Partial<ServerModel> = {}): ServerModel => ({
  refreshBehaviour: 'ok',
  meBehaviour: 'ok',
  user: { id: 'u-1', name: 'Ama Mensah', email: 'ama@example.com' },
  rotatedRefresh: 'rxr_rotated_v2',
  ...over,
});

// ---------------------------------------------------------------------------
// Core restoration behaviour
// ---------------------------------------------------------------------------

test('valid access token → authenticated (fast path, no refresh needed)', async () => {
  const device = freshDevice();
  const result = await restoreSession(launchAppVersion(device, server()));
  assert.equal(result.status, 'authenticated');
  assert.equal((result as any).user.id, 'u-1');
  assert.equal(device.cleared, 0);
  assert.equal(device.refresh, 'rxr_credential_v1', 'credential untouched');
});

test('expired access token → silent refresh → authenticated (never a sign-out)', async () => {
  const device = freshDevice();
  // /users/me rejects the (expired) access token; the refresh session is fine.
  const srv = server({ meBehaviour: 'reject-stale', refreshBehaviour: 'ok' });
  const result = await restoreSession(launchAppVersion(device, srv));
  assert.equal(result.status, 'authenticated');
  assert.equal(device.refresh, 'rxr_rotated_v2', 'rotated credential persisted');
  assert.equal(device.access, 'new-access-token');
});

test('no access token but valid refresh → refresh → authenticated', async () => {
  const device = freshDevice();
  device.access = null; // access token expired away entirely / never stored
  const result = await restoreSession(launchAppVersion(device, server({ refreshBehaviour: 'ok' })));
  assert.equal(result.status, 'authenticated');
});

test('no credentials at all → signed out (first launch / after sign-out)', async () => {
  const device: DeviceStorage = { access: null, refresh: null, cleared: 0 };
  const result = await restoreSession(launchAppVersion(device, server()));
  assert.equal(result.status, 'signed-out');
});

test('server revoked the session → credentials cleared → signed out', async () => {
  const device = freshDevice();
  const srv = server({ meBehaviour: 'reject-always', refreshBehaviour: 'rejected' });
  const result = await restoreSession(launchAppVersion(device, srv));
  assert.equal(result.status, 'signed-out');
  assert.equal(device.cleared, 1, 'stored credentials cleared exactly once');
  assert.equal(device.refresh, null);
});

test('offline launch → credentials KEPT → offline (retry later, never signed out)', async () => {
  const device = freshDevice();
  const srv = server({ meBehaviour: 'network', refreshBehaviour: 'network' });
  const result = await restoreSession(launchAppVersion(device, srv));
  assert.equal(result.status, 'offline');
  assert.equal(device.cleared, 0, 'a connectivity problem must not clear credentials');
  assert.equal(device.refresh, 'rxr_credential_v1', 'credential survives the outage');
  // …and when connectivity returns, the SAME persisted credential restores the user.
  const retry = await restoreSession(launchAppVersion(device, server({ refreshBehaviour: 'ok' })));
  assert.equal(retry.status, 'authenticated', 'restored after reconnect');
});

test('refresh OK but profile fetch fails on the network → offline (not signed out)', async () => {
  const device = freshDevice();
  device.access = null;
  // Refresh succeeds, then the network dies before /users/me answers.
  const deps = launchAppVersion(device, server({ refreshBehaviour: 'ok' }));
  deps.fetchMe = async () => { throw new TypeError('fetch failed'); };
  const result = await restoreSession(deps);
  assert.equal(result.status, 'offline');
  assert.equal(device.cleared, 0);
});

test('fresh server-issued access token still rejected → genuinely invalid → signed out', async () => {
  const device = freshDevice();
  device.access = null;
  // Refresh succeeds but /users/me STILL rejects the brand-new token
  // (account deleted server-side, for example) → session is genuinely dead.
  const srv = server({ refreshBehaviour: 'ok', meBehaviour: 'reject-always' });
  const result = await restoreSession(launchAppVersion(device, srv));
  assert.equal(result.status, 'signed-out');
  assert.equal(device.cleared, 1);
});

// ---------------------------------------------------------------------------
// APPLICATION UPDATE REGRESSIONS (update ≠ logout)
// ---------------------------------------------------------------------------

test('REGRESSION: app version change → new bundle restores from persisted storage → still signed in', async () => {
  // v1: user signs in; credential persisted.
  const device = freshDevice();
  assert.ok(device.refresh);
  // v2 installed over v1 (APK/.deb/installer/PWA redeploy). The ONLY thing
  // that changed is the code — persisted storage carries over untouched.
  const result = await restoreSession(launchAppVersion(device, server()));
  assert.equal(result.status, 'authenticated', 'no login screen between versions');
  assert.equal(device.cleared, 0);
});

test('REGRESSION: app update while the access token was already expired → refresh → still signed in', async () => {
  const device = freshDevice();
  // The user last opened the app 3 days ago; the 24h access token is expired.
  const srv = server({ meBehaviour: 'reject-stale', refreshBehaviour: 'ok' });
  const result = await restoreSession(launchAppVersion(device, srv));
  assert.equal(result.status, 'authenticated');
  assert.equal(device.refresh, 'rxr_rotated_v2', 'new rotated credential persisted');
  assert.equal(device.cleared, 0, 'expired access token is NOT a logout condition');
});

test('REGRESSION: app update after the server revoked the session → refresh rejected → signed out (correct)', async () => {
  const device = freshDevice();
  // Admin revoked sessions / user pressed "sign out all devices" on another
  // device BEFORE this device updated.
  const srv = server({ meBehaviour: 'reject-always', refreshBehaviour: 'rejected' });
  const result = await restoreSession(launchAppVersion(device, srv));
  assert.equal(result.status, 'signed-out', 'the server stays authoritative');
  assert.equal(device.refresh, null, 'dead credential removed');
});

test('REGRESSION: failed update / rollback — the previous version still restores the session', async () => {
  // v1 signed in; the v2 update FAILED and v1 launches again. v1 must still
  // restore: nothing about the failed update touched storage or the server.
  const device = freshDevice();
  const result = await restoreSession(launchAppVersion(device, server()));
  assert.equal(result.status, 'authenticated');
  assert.equal(device.refresh, 'rxr_credential_v1', 'credential untouched by the failed update');
});
