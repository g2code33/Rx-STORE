/**
 * App-row normalization tests — the `.join is not a function` crash class.
 *
 * Two production crashes came from partially-normalized rows:
 *   - `(x.platforms || []).join is not a function`   (Developer App Detail)
 *   - `(a.screenshots || []).join is not a function` (Admin → Apps → editor)
 * These tests pin the ONE normalizer every app-returning endpoint now uses, so
 * a new JSON column cannot reintroduce the bug.
 *
 * Run: node --experimental-strip-types --test backend/src/appRowNormalize.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listColumn, objectListColumn, normalizeAppRow } from './services/appRowNormalize.ts';
import { adminListApps } from './routes/admin.ts';
import { adminConnectionsOverview, adminSetConnectionStatus, ensureGithubTables } from './services/githubReleases.ts';

test('listColumn: JSON arrays, legacy comma strings, junk and nulls', () => {
  assert.deepEqual(listColumn('["web","android"]'), ['web', 'android']);
  assert.deepEqual(listColumn(['a', 'b']), ['a', 'b']);
  assert.deepEqual(listColumn('linux,web'), ['linux', 'web']);
  assert.deepEqual(listColumn(' linux , web '), ['linux', 'web']);
  assert.deepEqual(listColumn(null), []);
  assert.deepEqual(listColumn(''), []);
  assert.deepEqual(listColumn('{"a":1}'), [], 'an object is not a list');
  assert.deepEqual(listColumn(undefined), []);
});

test('objectListColumn: keeps object arrays, drops anything else', () => {
  assert.deepEqual(objectListColumn('[{"name":"a"}]'), [{ name: 'a' }]);
  assert.deepEqual(objectListColumn('not json'), []);
  assert.deepEqual(objectListColumn('42'), []);
});

test('normalizeAppRow: EVERY list column is a real array — .join/.map can never crash', () => {
  const row = normalizeAppRow({
    id: 'a1', slug: 's', name: 'N', category: 'healthcare', status: 'active',
    platforms: 'web,android',           // legacy comma string
    screenshots: '["https://x/1.png"]',
    tags: null,
    features: 'not-json',
    release_notes: '["First release"]',
    current_version: '2.1.0',
    price_type: 'free', price_amount: 0,
    download_count: 7, review_count: 2,
  });
  for (const key of ['platforms', 'screenshots', 'tags', 'features', 'releaseNotes', 'release_notes']) {
    assert.ok(Array.isArray(row[key]), `${key} must be an array (got ${typeof row[key]})`);
    // The exact expression that crashed in production:
    assert.equal(typeof row[key].join(','), 'string');
  }
  assert.deepEqual(row.platforms, ['web', 'android']);
  assert.deepEqual(row.releaseNotes, ['First release']);
  assert.deepEqual(row.tags, []);
  assert.equal(row.version, '2.1.0');
  assert.equal(row.currentVersion, '2.1.0');
  assert.equal(row.downloadCount, 7);
});

test('normalizeAppRow: keeps only valid display platforms, never crashes on rubbish', () => {
  const row = normalizeAppRow({ platforms: '["web","linux_deb","android","andriod"]', screenshots: 'plain,string,list' });
  assert.deepEqual(row.platforms, ['web', 'android'], 'package ids and typos are dropped from the display list');
  assert.deepEqual(row.screenshots, ['plain', 'string', 'list']);
});

function envWith(apps: any[], connections: any[] = [], releases: any[] = []) {
  const tables: Record<string, any[]> = { applications: apps, github_repo_connections: connections, github_releases: releases };
  const DB = {
    prepare(sql: string) {
      const s = sql.replace(/\s+/g, ' ');
      return {
        _binds: [] as any[],
        bind(...a: any[]) { this._binds = a; return this; },
        async run() {
          const a = this._binds;
          if (s.includes('CREATE TABLE') || s.includes('CREATE INDEX') || s.includes('CREATE UNIQUE INDEX')) return { meta: { changes: 0 } };
          if (s.includes('UPDATE github_repo_connections SET status=?')) {
            const c = tables.github_repo_connections.find((x) => x.id === a[2]);
            if (c) { c.status = a[0]; c.last_error = a[1]; }
            return { meta: { changes: c ? 1 : 0 } };
          }
          if (s.includes("UPDATE github_releases SET status='blocked'")) {
            let n = 0;
            for (const r of tables.github_releases) if (r.connection_id === a[1] && ['detected', 'verifying', 'pending_approval'].includes(r.status)) { r.status = 'blocked'; r.block_reason = a[0]; n++; }
            return { meta: { changes: n } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          const a = this._binds;
          if (s.includes('FROM github_repo_connections WHERE application_id')) return tables.github_repo_connections.find((c) => c.application_id === a[0]) || null;
          return null;
        },
        async all() {
          if (s.includes('FROM applications WHERE deleted_at IS NULL')) return { results: tables.applications };
          if (s.includes('FROM github_repo_connections')) return { results: tables.github_repo_connections };
          if (s.includes('FROM github_releases')) return { results: tables.github_releases };
          return { results: [] };
        },
      };
    },
  };
  return { DB, tables };
}

test('adminListApps + adminConnectionsOverview: admin views carry no raw JSON strings', async () => {
  const env = envWith([
    { id: 'app1', slug: 'first', name: 'First', status: 'active', platforms: 'web,android', screenshots: '["https://x/1.png"]', tags: null, features: null, release_notes: null, price_type: 'free', price_amount: 0, current_version: '1.0.0', developer_org_id: 'org1' },
    { id: 'app2', slug: 'second', name: 'Second', status: 'under_review', platforms: '["web"]', screenshots: '[]', tags: '[]', features: '[]', release_notes: '[]', price_type: 'paid', price_amount: 20, current_version: '', developer_org_id: 'org1' },
  ], [
    { id: 'c1', application_id: 'app1', repository_id: '123', repository_full_name: 'octo/app', installation_id: '9', status: 'active', channel: 'stable', last_event: 'release.published', last_event_at: 'now', last_sync_at: null, latest_detected_version: '1.2.0', last_error: null, created_at: 'now' },
  ], [
    { application_id: 'app1', version: '1.2.0', status: 'pending_approval', detected_at: '2026-10-21' },
  ]);
  await ensureGithubTables(env);

  const listed = await adminListApps(env);
  assert.equal(listed.length, 2);
  for (const app of listed) {
    for (const k of ['platforms', 'tags', 'screenshots', 'features', 'releaseNotes']) {
      assert.ok(Array.isArray(app[k]), `${app.slug}.${k} must be an array`);
    }
  }

  const overview = await adminConnectionsOverview(env);
  assert.equal(overview.totals.applications, 2);
  assert.equal(overview.totals.connected, 1);
  assert.equal(overview.totals.notConnected, 1);
  assert.equal(overview.totals.paid, 1);
  const first = overview.apps.find((a: any) => a.appId === 'app1');
  assert.equal(first.connection.repository, 'octo/app');
  assert.equal(first.latestRelease.version, '1.2.0');
});

test('adminSetConnectionStatus: suspend stops detection + blocks queued releases; reinstate restores', async () => {
  const env = envWith(
    [{ id: 'app1', slug: 'first', name: 'First', status: 'active', price_type: 'free', price_amount: 0, developer_org_id: 'org1' }],
    [{ id: 'c1', application_id: 'app1', repository_id: '123', repository_full_name: 'octo/app', installation_id: '9', status: 'active', channel: 'stable' }],
    [{ id: 'r1', application_id: 'app1', connection_id: 'c1', version: '1.2.0', status: 'pending_approval' }],
  );
  await ensureGithubTables(env);
  const admin = { userId: 'admin-1', label: 'admin:test' };

  // Reason is mandatory for suspension.
  const noReason = await adminSetConnectionStatus(env, admin, 'app1', 'suspend', '');
  assert.equal(noReason.ok, false);
  assert.equal((noReason as any).code, 'VALIDATION_ERROR');

  const suspended = await adminSetConnectionStatus(env, admin, 'app1', 'suspend', 'Suspicious release activity reported by two developers.');
  assert.equal(suspended.ok, true);
  assert.equal(env.tables.github_repo_connections[0].status, 'revoked');
  assert.equal(env.tables.github_releases[0].status, 'blocked', 'queued releases are blocked while suspended');

  const reinstated = await adminSetConnectionStatus(env, admin, 'app1', 'reinstate', '');
  assert.equal(reinstated.ok, true);
  assert.equal(env.tables.github_repo_connections[0].status, 'active');

  // An app without a connection is a clean NOT_FOUND.
  const missing = await adminSetConnectionStatus(env, admin, 'app2', 'suspend', 'no such connection here');
  assert.equal((missing as any).code, 'NOT_FOUND');
});
