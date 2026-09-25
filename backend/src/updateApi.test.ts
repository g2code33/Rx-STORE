/**
 * Extended /updates/check contract tests (Developer SDK phase).
 *
 * Drives the REAL updatesRoutes.checkUpdate against a fake D1 covering:
 *   - the full extended response (ids, slug, links, policy fields, checkedAt)
 *   - mandatory via app_versions.mandatory (synced publish flag)
 *   - minimumSupportedVersion + below-minimum → mandatory
 *   - paid applications NEVER expose a binary URL (Phase 22 stays intact)
 *   - free applications still expose their public package URL
 *   - no update / unknown app / missing parameters
 *
 * Run: node --experimental-strip-types --test backend/src/updateApi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { updatesRoutes } from './routes/updates.ts';

function fakeEnv() {
  const apps = new Map<string, any>();
  const versions = new Map<string, any>(); // key: `${appId}:${version}`
  const releases = new Map<string, any>(); // key: `${appId}:${version}`

  const DB = {
    prepare(sql: string) {
      return {
        _binds: [] as any[],
        bind(...args: any[]) { this._binds = args; return this; },
        async first() {
          const a = this._binds;
          if (sql.includes('FROM applications WHERE slug')) return apps.get(String(a[0])) || null;
          if (sql.includes('FROM app_versions')) return versions.get(`${a[0]}:${a[1]}`) || null;
          if (sql.includes('FROM releases')) return releases.get(`${a[0]}:${a[1]}`) || null;
          return null;
        },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 0 } }; },
      };
    },
  };
  return { DB, apps, versions, releases, RX_STORE_WEB_URL: 'https://rx-store-web.pages.dev' };
}

function seedApp(env: any, over: Record<string, unknown> = {}) {
  const app = {
    id: 'app_pharma',
    name: 'PharmaTRACK',
    slug: 'pharmatrack',
    current_version: '1.1.5',
    price_type: 'free',
    price_amount: 0,
    ...over,
  };
  env.apps.set(app.slug, app);
  env.versions.set(`${app.id}:1.1.5`, {
    id: 'v115', app_id: app.id, version: '1.1.5',
    mandatory: 0,
    release_notes: JSON.stringify(['Bug fixes', 'Performance improvements']),
    files: JSON.stringify({
      android: { url: 'apps/pharmatrack-1.1.5.apk', size: 12345678, checksum: 'a'.repeat(64) },
    }),
  });
  env.releases.set(`${app.id}:1.1.5`, {
    id: 'rel115', application_id: app.id, version: '1.1.5',
    channel: 'stable', minimum_supported_version: null, status: 'published',
  });
  return app;
}

function check(env: any, qs: string) {
  return updatesRoutes.checkUpdate(new Request(`https://api.test/updates/check${qs}`), env);
}

test('extended response: full SDK contract for an available update (free app)', async () => {
  const env = fakeEnv();
  seedApp(env);
  const data: any = await check(env, '?app=pharmatrack&currentVersion=1.1.4&platform=android&arch=arm64');
  assert.equal(data.appId, 'app_pharma');
  assert.equal(data.app, 'PharmaTRACK');
  assert.equal(data.slug, 'pharmatrack');
  assert.equal(data.currentVersion, '1.1.4');
  assert.equal(data.latestVersion, '1.1.5');
  assert.equal(data.platform, 'android');
  assert.equal(data.architecture, 'arm64');
  assert.equal(data.channel, 'stable');
  assert.equal(data.updateAvailable, true);
  assert.equal(data.mandatory, false);
  assert.equal(data.minimumSupportedVersion, null);
  assert.equal(data.updateRequired, false);
  assert.deepEqual(data.releaseNotes, ['Bug fixes', 'Performance improvements']);
  assert.equal(data.fileSize, 12345678);
  assert.equal(data.checksum, `sha256:${'a'.repeat(64)}`, 'checksum normalized with sha256: prefix');
  assert.equal(data.storeUrl, 'https://rx-store-web.pages.dev/app/pharmatrack');
  assert.equal(data.deepLink, 'rxstore://app/pharmatrack');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(data.checkedAt), 'checkedAt is an ISO timestamp');
  // Free public package: the r2-relative URL is expanded to the public /r2/ path.
  assert.equal(data.downloadURL, 'https://api.test/r2/apps/pharmatrack-1.1.5.apk');
});

test('no update: same shape, updateAvailable false, no binary fields', async () => {
  const env = fakeEnv();
  seedApp(env);
  const data: any = await check(env, '?app=pharmatrack&currentVersion=1.1.5&platform=android');
  assert.equal(data.updateAvailable, false);
  assert.equal(data.mandatory, false);
  assert.equal(data.fileSize, null);
  assert.equal(data.checksum, null);
  assert.equal(data.downloadURL, undefined);
  assert.equal(data.storeUrl, 'https://rx-store-web.pages.dev/app/pharmatrack');
  assert.equal(data.deepLink, 'rxstore://app/pharmatrack');
});

test('mandatory flag from the synced app_versions row is authoritative', async () => {
  const env = fakeEnv();
  seedApp(env);
  env.versions.get('app_pharma:1.1.5').mandatory = 1;
  const data: any = await check(env, '?app=pharmatrack&currentVersion=1.1.4&platform=android');
  assert.equal(data.updateAvailable, true);
  assert.equal(data.mandatory, true);
});

test('minimumSupportedVersion from the canonical release makes older clients mandatory', async () => {
  const env = fakeEnv();
  seedApp(env);
  env.releases.get('app_pharma:1.1.5').minimum_supported_version = '1.1.2';
  const old: any = await check(env, '?app=pharmatrack&currentVersion=1.1.0&platform=android');
  assert.equal(old.updateAvailable, true);
  assert.equal(old.mandatory, true, 'below minimum → mandatory');
  assert.equal(old.updateRequired, true);
  assert.equal(old.minimumSupportedVersion, '1.1.2');
  // A client INSIDE the supported range is not forced.
  const ok: any = await check(env, '?app=pharmatrack&currentVersion=1.1.4&platform=android');
  assert.equal(ok.updateRequired, false);
  assert.equal(ok.mandatory, false);
});

test('channel comes from the canonical release row (fallback stable)', async () => {
  const env = fakeEnv();
  seedApp(env);
  env.releases.get('app_pharma:1.1.5').channel = 'beta';
  const data: any = await check(env, '?app=pharmatrack&currentVersion=1.1.4&platform=android&channel=stable');
  assert.equal(data.channel, 'beta', 'server release channel wins over the client hint');
});

test('PAID applications never expose a binary download URL (SDK safety)', async () => {
  const env = fakeEnv();
  seedApp(env, { price_type: 'paid', price_amount: 49 });
  const data: any = await check(env, '?app=pharmatrack&currentVersion=1.1.4&platform=android');
  assert.equal(data.updateAvailable, true);
  assert.equal(data.downloadURL, null, 'no public binary URL for paid apps');
  assert.equal(JSON.stringify(data).includes('/r2/apps/pharmatrack'), false, 'no R2 package path anywhere in the response');
  // The SDK only needs the destinations — still present.
  assert.equal(data.storeUrl, 'https://rx-store-web.pages.dev/app/pharmatrack');
  assert.equal(data.deepLink, 'rxstore://app/pharmatrack');
  assert.equal(data.checksum, `sha256:${'a'.repeat(64)}`, 'metadata (checksum) is fine to expose');
});

test('unknown application → coded NOT_FOUND (404 at the dispatch layer)', async () => {
  const env = fakeEnv();
  const data: any = await check(env, '?app=ghost&currentVersion=1.0.0&platform=android');
  assert.equal(data.code, 'NOT_FOUND');
  assert.equal(data.error, 'Application not found');
});

test('missing parameters → coded VALIDATION_ERROR (400 at the dispatch layer)', async () => {
  const env = fakeEnv();
  const data: any = await check(env, '?app=pharmatrack&platform=android');
  assert.equal(data.code, 'VALIDATION_ERROR');
  assert.match(String(data.error), /Missing required parameters/);
});

test('draft/rolled-back releases never influence the public update contract', async () => {
  const env = fakeEnv();
  seedApp(env);
  // A draft release claiming a NEWER version + mandatory must be ignored…
  env.releases.set('app_pharma:1.1.6', {
    id: 'rel116', application_id: 'app_pharma', version: '1.1.6',
    channel: 'beta', minimum_supported_version: '1.1.5', status: 'draft',
  });
  // …and a rolled-back release row for the CURRENT version is ignored too
  // (metadata falls back to stable defaults instead of the dead release).
  env.releases.get('app_pharma:1.1.5').status = 'rolled_back';
  const data: any = await check(env, '?app=pharmatrack&currentVersion=1.1.4&platform=android');
  assert.equal(data.latestVersion, '1.1.5', 'application.current_version (publish-gated) stays authoritative');
  assert.equal(data.channel, 'stable', 'rolled-back release channel ignored → default stable');
  assert.equal(data.minimumSupportedVersion, null, 'rolled-back release min-supported ignored');
  assert.equal(data.mandatory, false, 'no mandatory leakage from non-published rows');
});

test('platform aliases keep working (deb → linux_deb file selection)', async () => {
  const env = fakeEnv();
  seedApp(env);
  env.versions.get('app_pharma:1.1.5').files = JSON.stringify({
    linux_deb: { url: 'apps/rx_1.1.5.deb', size: 99, checksum: 'b'.repeat(64) },
  });
  const data: any = await check(env, '?app=pharmatrack&currentVersion=1.1.4&platform=deb');
  assert.equal(data.platform, 'linux_deb');
  assert.equal(data.downloadURL, 'https://api.test/r2/apps/rx_1.1.5.deb');
});
