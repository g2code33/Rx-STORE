/**
 * Developer App Management & Release Submission tests (Phase 12 §27).
 *
 * Hermetic: real route handlers against an in-memory D1 fake + an in-memory
 * R2 stand-in. Covers the developer workflow (create app → draft release →
 * upload package → submit → status → changes → resubmit), the admin review
 * queue (approve/reject/request-changes with required reasons), the security
 * matrix (cross-org edits/uploads blocked, no client status changes, no
 * developer publish path), and the public marketplace visibility rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { developerAppRoutes, adminDeveloperAppRoutes } from './routes/developerApps.ts';
import { appsRoutes } from './routes/apps.ts';
import { adminRoutes } from './routes/admin.ts';

// ---------------------------------------------------------------------------
// In-memory D1 + R2 fakes
// ---------------------------------------------------------------------------

function makeEnv() {
  const db: any = {
    users: [
      { id: 'u1', name: 'Owner', email: 'owner@example.com', role: 'user' },
      { id: 'u2', name: 'Other', email: 'other@example.com', role: 'user' },
      { id: 'admin1', name: 'Admin', email: 'admin@example.com', role: 'admin' },
    ],
    developers: [{ id: 'dev_aaaaaaaa1', user_id: 'u1', application_id: null, status: 'ACTIVE', created_at: '2026-01-01' }],
    developer_profiles: [{ developer_id: 'dev_aaaaaaa1', publisher_name: 'Org A', website: null }],
    developer_members: [
      { id: 'dm1', developer_id: 'dev_aaaaaaaa1', user_id: 'u1', role: 'OWNER', created_at: '2026-01-01' },
    ],
    applications: [],
    releases: [],
    packages: [],
    developer_threads: [],
    developer_thread_messages: [],
    developer_audit_logs: [],
    audit_logs: [],
    notifications: [],
  };
  // fix the profile developer_id typo-safe
  db.developer_profiles[0].developer_id = 'dev_aaaaaaaa1';
  const storage: Record<string, ArrayBuffer> = {};

  const DB = {
    prepare(sql: string) {
      const self: any = {
        _b: [] as any[],
        bind(...a: any[]) { self._b = a; return self; },
        async first() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('FROM developer_members m JOIN developers d')) {
            const m = db.developer_members.find((x: any) => x.user_id === a[0]);
            if (!m) return null;
            const d = db.developers.find((x: any) => x.id === m.developer_id);
            return { member_id: m.id, role: m.role, member_since: m.created_at, ...d };
          }
          if (s.includes('SELECT publisher_name FROM developer_profiles')) {
            return db.developer_profiles.find((p: any) => p.developer_id === a[0]) || null;
          }
          if (s.includes('SELECT id FROM applications WHERE slug=?')) {
            return db.applications.find((x: any) => x.slug === a[0]) || null;
          }
          if (s.includes('SELECT * FROM applications WHERE id=?')) {
            return db.applications.find((x: any) => x.id === a[0]) || null;
          }
          if (s.includes('SELECT * FROM applications WHERE slug = ?')) {
            return db.applications.find((x: any) => x.slug === a[0]) || null;
          }
          if (s.includes('SELECT version, status, created_at FROM releases WHERE application_id=?')) {
            const rels = db.releases.filter((r: any) => r.application_id === a[0]);
            return rels[rels.length - 1] || null;
          }
          if (s.includes('SELECT * FROM releases WHERE id=?')) {
            return db.releases.find((r: any) => r.id === a[0]) || null;
          }
          if (s.includes('SELECT id FROM releases WHERE application_id=? AND version=?')) {
            const notId = s.includes('AND id != ?') ? a[2] : null;
            return db.releases.find((r: any) => r.application_id === a[0] && r.version === a[1] && r.id !== notId) || null;
          }
          if (s.includes('SELECT id FROM developer_threads WHERE related_release_id=?')) {
            return db.developer_threads.find((t: any) => t.related_release_id === a[0]) || null;
          }
          if (s.includes('FROM developer_threads WHERE related_app_id=?')) {
            return db.developer_threads.filter((t: any) => t.related_app_id === a[0])[0] || null;
          }
          if (s.includes('SELECT version, published_at FROM releases WHERE application_id=?')) {
            return db.releases.find((r: any) => r.application_id === a[0] && r.status === 'published') || null;
          }
          if (s.includes('SELECT r.*, a.name AS app_name')) {
            const r = db.releases.find((x: any) => x.id === a[0] && x.developer_id);
            if (!r) return null;
            const app = db.applications.find((x: any) => x.id === r.application_id);
            return { ...r, app_name: app?.name, app_slug: app?.slug, app_id: app?.id, app_platforms: app?.platforms, publisher_name: 'Org A' };
          }
          return null;
        },
        async all() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes("SELECT id FROM users WHERE role='admin'")) return { results: db.users.filter((u: any) => u.role === 'admin') };
          if (s.includes('SELECT user_id FROM developer_members WHERE developer_id=?')) {
            return { results: db.developer_members.filter((m: any) => m.developer_id === a[0]).map((m: any) => ({ user_id: m.user_id })) };
          }
          if (s.includes('SELECT * FROM applications WHERE developer_org_id=? ORDER BY created_at DESC')) {
            return { results: db.applications.filter((x: any) => x.developer_org_id === a[0]) };
          }
          if (s.includes('SELECT status, COUNT(*) AS c FROM releases WHERE application_id=? GROUP BY status')) {
            const by: Record<string, number> = {};
            for (const r of db.releases.filter((r: any) => r.application_id === a[0])) by[r.status] = (by[r.status] || 0) + 1;
            return { results: Object.entries(by).map(([status, c]) => ({ status, c })) };
          }
          if (s.includes('SELECT * FROM releases WHERE application_id=? ORDER BY created_at DESC')) {
            return { results: db.releases.filter((r: any) => r.application_id === a[0]) };
          }
          if (s.includes('SELECT platform, deployment_url, file_size FROM packages WHERE release_id=?')) {
            return { results: db.packages.filter((p: any) => p.release_id === a[0]).map((p: any) => ({ platform: p.platform, deployment_url: p.deployment_url, file_size: p.file_size })) };
          }
          if (s.includes('FROM packages WHERE release_id=? ORDER BY created_at ASC')) {
            return { results: db.packages.filter((p: any) => p.release_id === a[0]) };
          }
          if (s.includes('SELECT * FROM packages WHERE release_id=?')) {
            return { results: db.packages.filter((p: any) => p.release_id === a[0]) };
          }
          if (s.includes('SELECT id FROM packages WHERE release_id=? AND platform=? AND architecture=?')) {
            return { results: db.packages.filter((p: any) => p.release_id === a[0] && p.platform === a[1] && p.architecture === a[2]) };
          }
          if (s.includes('SELECT * FROM applications WHERE status=\'active\'')) {
            return { results: db.applications.filter((x: any) => x.status === 'active') };
          }
          if (s.includes('SELECT COUNT(*) as total FROM applications')) {
            return { results: [{ total: db.applications.filter((x: any) => x.status === 'active').length }] };
          }
          if (s.includes('FROM applications a LEFT JOIN developer_profiles p')) {
            const status = s.includes('AND a.status=?') ? a[0] : null;
            return {
              results: db.applications
                .filter((x: any) => x.developer_org_id && (!status || x.status === status))
                .map((x: any) => ({ ...x, publisher_name: db.developer_profiles.find((p: any) => p.developer_id === x.developer_org_id)?.publisher_name })),
            };
          }
          if (s.includes('FROM releases r JOIN applications a ON a.id = r.application_id')) {
            const status = s.includes('AND r.status=?') ? a[0] : null;
            return {
              results: db.releases
                .filter((r: any) => r.developer_id && (!status || r.status === status))
                .map((r: any) => {
                  const app = db.applications.find((x: any) => x.id === r.application_id);
                  return { ...r, app_name: app?.name, app_slug: app?.slug, publisher_name: db.developer_profiles.find((p: any) => p.developer_id === r.developer_id)?.publisher_name, package_count: db.packages.filter((p: any) => p.release_id === r.id).length };
                }),
            };
          }
          if (s.includes('SELECT r.*, a.name AS app_name')) {
            const r = db.releases.find((x: any) => x.id === a[0] && x.developer_id);
            if (!r) return { results: [] };
            const app = db.applications.find((x: any) => x.id === r.application_id);
            return { results: [{ ...r, app_name: app?.name, app_slug: app?.slug, app_id: app?.id, app_platforms: app?.platforms, publisher_name: 'Org A' }] };
          }
          return { results: [] };
        },
        async run() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          const now = new Date().toISOString();
          if (s.includes('INSERT INTO developer_audit_logs')) {
            db.developer_audit_logs.push({ id: a[0], developer_id: a[1], actor_user_id: a[2], action: a[3], created_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO audit_logs')) {
            db.audit_logs.push({ id: a[0], action: a[1], resource_type: a[2], resource_id: a[3] });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO notifications')) {
            db.notifications.push({ id: a[0], user_id: a[1], type: a[2], title: a[3] });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO applications')) {
            db.applications.push({
              id: a[0], slug: a[1], name: a[2], description: a[3], long_description: a[4], category: a[5],
              tags: a[6], developer: a[7], developer_id: a[8], icon: a[9], status: 'draft', platforms: a[10],
              website: a[11], developer_org_id: a[12], created_at: now, updated_at: now,
              current_version: null, download_count: 0, rating: 0, review_count: 0,
            });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO releases')) {
            db.releases.push({
              id: a[0], application_id: a[1], version: a[2], build_number: a[3], release_notes: a[4],
              feature_summary: a[5], call_to_action: a[6], release_type: a[7], channel: a[8],
              minimum_supported_version: a[9], status: 'draft', developer_id: a[10],
              created_at: now, updated_at: now, security_status: 'pending', verification_status: 'pending',
            });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO packages')) {
            // writePackageRow: upsert by (release_id, platform, architecture)
            const existing = db.packages.find((p: any) => p.release_id === a[2] && p.platform === a[3] && p.architecture === a[4]);
            const row = {
              id: a[0], application_id: a[1], release_id: a[2], platform: a[3], architecture: a[4],
              filename: a[5], storage_key: a[6], file_size: a[7], mime_type: a[8], sha256: a[9],
              version: a[10], package_type: a[11], min_os_version: a[12], min_android_sdk: a[13], status: a[14],
              security_scan_status: 'pending', signature_status: 'pending', deployment_url: null, created_at: now,
            };
            if (existing) Object.assign(existing, row);
            else db.packages.push(row);
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developer_threads')) {
            db.developer_threads.push({ id: a[0], developer_id: a[1], subject: a[2], related_app_id: a[3], related_release_id: a[4], status: 'AWAITING_ADMIN', action_required: 1, updated_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developer_thread_messages')) {
            db.developer_thread_messages.push({ id: a[0], thread_id: a[1], sender_user_id: a[2], sender_context: a[3], body: a[4], created_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.startsWith('UPDATE applications SET')) {
            const app = db.applications.find((x: any) => x.id === a[a.length - 1]);
            if (!app) return { meta: { changes: 0 } };
            for (const st of ['submitted', 'under_review', 'active', 'changes_requested', 'suspended', 'archived'] as const) {
              if (s.includes(`status='${st}'`)) app.status = st;
            }
            const m = s.match(/SET (.*) WHERE id=\?/);
            if (m && !s.includes("status='")) {
              const cols = m[1].split(', ').map((c) => c.split('=')[0].trim()).filter((c) => c !== 'updated_at');
              cols.forEach((c, i) => { (app as any)[c] = a[i]; });
            }
            return { meta: { changes: 1 } };
          }
          if (s.startsWith('UPDATE releases SET')) {
            const rel = db.releases.find((x: any) => x.id === a[a.length - 1]);
            if (!rel) return { meta: { changes: 0 } };
            for (const st of ['submitted', 'under_review', 'approved', 'rejected', 'changes_requested', 'withdrawn'] as const) {
              if (s.includes(`status='${st}'`)) {
                rel.status = st;
                if (st === 'submitted') rel.submitted_at = now;
                if (['approved', 'rejected', 'changes_requested'].includes(st)) rel.reviewed_at = now;
                if (st === 'published') rel.published_at = now;
              }
            }
            if (s.includes("status='published'")) { rel.status = 'published'; rel.published_at = now; }
            if (s.includes('reviewer_id=?')) { rel.reviewer_id = a[0]; rel.reviewed_at = now; }
            if (s.includes('review_reason=?')) rel.review_reason = a[s.includes('reviewer_id=?') ? 1 : 0];
            const m = s.match(/SET (.*) WHERE id=\?/);
            if (m && !s.includes("status='")) {
              const cols = m[1].split(', ').map((c) => c.split('=')[0].trim()).filter((c) => c !== 'updated_at');
              cols.forEach((c, i) => { (rel as any)[c] = a[i]; });
            }
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE packages SET security_scan_status')) {
            db.packages.forEach((p: any) => { if (p.release_id === a[0] && p.platform === a[1] && p.architecture === a[2]) { p.security_scan_status = 'pending'; p.signature_status = 'pending'; } });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE packages SET deployment_url=?')) {
            db.packages.forEach((p: any) => { if (p.release_id === a[1] && p.platform === a[2]) p.deployment_url = a[0]; });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE developer_threads SET status=?')) {
            const t = db.developer_threads.find((x: any) => x.id === a[2]); if (t) { t.status = a[0]; t.action_required = a[1]; }
            return { meta: { changes: 1 } };
          }
          if (s.includes("UPDATE developer_threads SET status='AWAITING_ADMIN'")) {
            const t = db.developer_threads.find((x: any) => x.id === a[0]); if (t) t.status = 'AWAITING_ADMIN';
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  const STORAGE = {
    put: async (key: string, value: ArrayBuffer) => { storage[key] = value; },
    head: async (key: string) => (storage[key] != null ? { size: storage[key].byteLength } : null),
  };
  return { DB, STORAGE, db, storage };
}

const req = (userId: string | null, body: any, path: string, method = 'POST') => {
  const r = new Request(`https://api.rxstore.com${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  if (userId) (r as any).user = { userId };
  return r;
};

const fileReq = (userId: string, path: string, file: File, platform: string, architecture: string) => {
  const form = new FormData();
  form.append('file', file);
  form.append('platform', platform);
  form.append('architecture', architecture);
  const r = new Request(`https://api.rxstore.com${path}`, { method: 'POST', body: form });
  (r as any).user = { userId };
  return r;
};

/** Seed: approved org-A developer with an APPROVED (active) app. */
async function seededApp() {
  const env = makeEnv();
  env.db.applications.push({
    id: 'app_seed', slug: 'seed-app', name: 'Seed App', description: 'An approved app', category: 'healthcare',
    tags: '[]', developer: 'Org A', developer_id: 'u1', icon: 'https://x/icon.png', status: 'active',
    platforms: '["web","windows","linux","android"]', website: null, developer_org_id: 'dev_aaaaaaaa1',
    created_at: '2026-01-02', updated_at: '2026-01-02', current_version: null, download_count: 0, rating: 0, review_count: 0,
  });
  return env;
}

// ---------------------------------------------------------------------------
// Developer workflow
// ---------------------------------------------------------------------------

test('create app: stable id + slug, DRAFT status, org-owned, audited', async () => {
  const env = makeEnv();
  const out: any = await developerAppRoutes.createApp(req('u1', {
    name: 'Test App', description: 'A test application', category: 'healthcare',
    platforms: ['web', 'windows'], icon: 'https://x/i.png',
  }, '/developers/apps'), env);
  assert.ok(out.app.id, 'stable app id');
  assert.equal(out.app.slug, 'test-app');
  assert.equal(out.app.status, 'draft');
  const row = env.db.applications[0];
  assert.equal(row.id, out.app.id, 'id is the permanent identifier (name changes never break it)');
  assert.equal(row.developer_org_id, 'dev_aaaaaaaa1');
  assert.ok(env.db.developer_audit_logs.some((l: any) => l.action === 'developer_app_created'));
});

test('create app validates category, platforms and icon', async () => {
  const env = makeEnv();
  const bad: any = await developerAppRoutes.createApp(req('u1', { name: 'X', description: 'An app', category: 'nope', platforms: [] }, '/developers/apps'), env);
  assert.equal(bad.code, 'VALIDATION_ERROR');
});

test('app metadata can be edited while draft, and status can NEVER be set by the client', async () => {
  const env = await seededApp();
  env.db.applications[0].status = 'draft';
  const out: any = await developerAppRoutes.updateApp(req('u1', { name: 'New Name', status: 'active' }, '/developers/apps/app_seed', 'PATCH'), env);
  assert.equal(out.success, true);
  assert.equal(env.db.applications[0].name, 'New Name');
  assert.equal(env.db.applications[0].status, 'draft', 'client-supplied status is ignored');
});

test('app submission requires complete metadata and lists every missing field', async () => {
  const env = makeEnv();
  await developerAppRoutes.createApp(req('u1', { name: 'Incomplete', description: 'A description long enough', category: 'healthcare', platforms: ['web'] }, '/developers/apps'), env);
  const appId = env.db.applications[0].id;
  env.db.applications[0].platforms = '[]'; // simulate incomplete metadata for the listing check
  const out: any = await developerAppRoutes.submitApp(req('u1', {}, `/developers/apps/${appId}/submit`), env);
  assert.equal(out.code, 'VALIDATION_ERROR');
  assert.ok(out.errors.includes('Icon URL'));
  assert.ok(out.errors.includes('At least one supported platform'));
});

test('release creation: draft; duplicate version and bad semver rejected', async () => {
  const env = await seededApp();
  const out: any = await developerAppRoutes.createRelease(req('u1', { version: '1.2.0', buildNumber: '42', releaseNotes: ['First'] }, '/developers/apps/app_seed/releases'), env);
  assert.equal(out.release.status, 'draft');
  assert.equal(out.release.version, '1.2.0');

  const dup: any = await developerAppRoutes.createRelease(req('u1', { version: '1.2.0' }, '/developers/apps/app_seed/releases'), env);
  assert.equal(dup.code, 'VALIDATION_ERROR');
  assert.ok(String(dup.error).includes('already exists'));

  const badSemver: any = await developerAppRoutes.createRelease(req('u1', { version: 'banana' }, '/developers/apps/app_seed/releases'), env);
  assert.equal(badSemver.code, 'VALIDATION_ERROR');
});

test('releases cannot be created for an app that is not approved/listed', async () => {
  const env = await seededApp();
  env.db.applications[0].status = 'draft';
  const out: any = await developerAppRoutes.createRelease(req('u1', { version: '1.0.0' }, '/developers/apps/app_seed/releases'), env);
  assert.equal(out.code, 'FORBIDDEN');
});

test('package upload: server-computed size + sha256, security stays pending, stored in R2', async () => {
  const env = await seededApp();
  await developerAppRoutes.createRelease(req('u1', { version: '1.2.0', buildNumber: '42', releaseNotes: ['n'] }, '/developers/apps/app_seed/releases'), env);
  const relId = env.db.releases[0].id;
  const bytes = new TextEncoder().encode('PK-fake-exe-content');
  const file = new File([bytes], 'setup.exe', { type: 'application/octet-stream' });
  const out: any = await developerAppRoutes.uploadPackage(fileReq('u1', `/developers/releases/${relId}/packages`, file, 'windows', 'x64'), env);
  assert.ok(out.package.sha256, 'sha256 present');
  assert.match(out.package.sha256, /^[a-f0-9]{64}$/, 'real server-side hash');
  const pkg = env.db.packages[0];
  assert.equal(pkg.file_size, bytes.byteLength, 'size from the uploaded bytes, never the client');
  assert.equal(pkg.security_scan_status, 'pending', 'never automatically safe');
  assert.equal(pkg.signature_status, 'pending');
  assert.ok(env.storage[pkg.storage_key], 'bytes actually stored');
  assert.ok(env.db.developer_audit_logs.some((l: any) => l.action === 'developer_package_uploaded'));
});

test('package upload rejects wrong extensions, wrong platforms and locked releases', async () => {
  const env = await seededApp();
  await developerAppRoutes.createRelease(req('u1', { version: '1.2.0', buildNumber: '42', releaseNotes: ['n'] }, '/developers/apps/app_seed/releases'), env);
  const relId = env.db.releases[0].id;

  const badExt: any = await developerAppRoutes.uploadPackage(fileReq('u1', `/developers/releases/${relId}/packages`, new File([new TextEncoder().encode('x')], 'setup.sh'), 'windows', 'x64'), env);
  assert.equal(badExt.code, 'VALIDATION_ERROR');
  assert.ok(String(badExt.error).includes('.exe'));

  // macos maps to the 'ios' display platform, which this app does not list
  const badPlatform: any = await developerAppRoutes.uploadPackage(fileReq('u1', `/developers/releases/${relId}/packages`, new File([new TextEncoder().encode('x')], 'app.dmg'), 'macos', 'x64'), env);
  assert.equal(badPlatform.code, 'VALIDATION_ERROR');
  assert.ok(String(badPlatform.error).includes('does not list'));

  // web is a URL platform, not a file
  const urlPlatform: any = await developerAppRoutes.uploadPackage(fileReq('u1', `/developers/releases/${relId}/packages`, new File([new TextEncoder().encode('x')], 'site.zip'), 'web', 'universal'), env);
  assert.equal(urlPlatform.code, 'VALIDATION_ERROR');

  // locked once submitted
  env.db.releases[0].status = 'submitted';
  const locked: any = await developerAppRoutes.uploadPackage(fileReq('u1', `/developers/releases/${relId}/packages`, new File([new TextEncoder().encode('x')], 'setup.exe'), 'windows', 'x64'), env);
  assert.equal(locked.code, 'FORBIDDEN');
});

test('deployment URL package: https enforced, stored with pending security', async () => {
  const env = await seededApp();
  await developerAppRoutes.createRelease(req('u1', { version: '1.2.0', buildNumber: '42', releaseNotes: ['n'] }, '/developers/apps/app_seed/releases'), env);
  const relId = env.db.releases[0].id;
  const bad: any = await developerAppRoutes.setDeploymentUrl(req('u1', { url: 'http://insecure.example', platform: 'web' }, `/developers/releases/${relId}/deployment-url`), env);
  assert.equal(bad.code, 'VALIDATION_ERROR');
  const ok: any = await developerAppRoutes.setDeploymentUrl(req('u1', { url: 'https://app.example.com', platform: 'web' }, `/developers/releases/${relId}/deployment-url`), env);
  assert.ok(ok.package);
  const pkg = env.db.packages.find((p: any) => p.platform === 'web');
  assert.equal(pkg.deployment_url, 'https://app.example.com');
  assert.equal(pkg.security_scan_status, 'pending');
});

test('release submission blocks incomplete releases and lists everything missing', async () => {
  const env = await seededApp();
  await developerAppRoutes.createRelease(req('u1', { version: '1.2.0' }, '/developers/apps/app_seed/releases'), env);
  const relId = env.db.releases[0].id;
  const out: any = await developerAppRoutes.submitRelease(req('u1', {}, `/developers/releases/${relId}/submit`), env);
  assert.equal(out.code, 'VALIDATION_ERROR');
  assert.ok(out.errors.includes('Build number'));
  assert.ok(out.errors.some((e: string) => e.startsWith('Release notes')));
  assert.ok(out.errors.some((e: string) => e.startsWith('At least one package')));
});

test('a complete release submits: locked, timestamped, thread created, admins notified', async () => {
  const env = await seededApp();
  await developerAppRoutes.createRelease(req('u1', { version: '1.2.0', buildNumber: '42', releaseNotes: ['Fixed things'] }, '/developers/apps/app_seed/releases'), env);
  const relId = env.db.releases[0].id;
  await developerAppRoutes.uploadPackage(fileReq('u1', `/developers/releases/${relId}/packages`, new File([new TextEncoder().encode('exe-bytes')], 'setup.exe'), 'windows', 'x64'), env);
  await developerAppRoutes.setDeploymentUrl(req('u1', { url: 'https://app.example.com', platform: 'web' }, `/developers/releases/${relId}/deployment-url`), env);

  const out: any = await developerAppRoutes.submitRelease(req('u1', {}, `/developers/releases/${relId}/submit`), env);
  assert.equal(out.release.status, 'submitted');
  const rel = env.db.releases[0];
  assert.ok(rel.submitted_at, 'submission timestamp recorded');
  assert.equal(rel.status, 'submitted');
  assert.ok(env.db.developer_threads.some((t: any) => t.related_release_id === relId), 'communication thread exists');
  assert.ok(env.db.developer_thread_messages.some((m: any) => m.body.includes('submitted for review')));
  assert.ok(env.db.notifications.some((n: any) => n.user_id === 'admin1'), 'admins notified');

  // Fields are now locked.
  const edit: any = await developerAppRoutes.updateRelease(req('u1', { buildNumber: '99' }, `/developers/releases/${relId}`, 'PATCH'), env);
  assert.equal(edit.code, 'FORBIDDEN');
});

// ---------------------------------------------------------------------------
// Admin review queue
// ---------------------------------------------------------------------------

async function submittedRelease() {
  const env = await seededApp();
  await developerAppRoutes.createRelease(req('u1', { version: '1.2.0', buildNumber: '42', releaseNotes: ['Fixed things'] }, '/developers/apps/app_seed/releases'), env);
  const relId = env.db.releases[0].id;
  await developerAppRoutes.uploadPackage(fileReq('u1', `/developers/releases/${relId}/packages`, new File([new TextEncoder().encode('exe-bytes')], 'setup.exe'), 'windows', 'x64'), env);
  await developerAppRoutes.setDeploymentUrl(req('u1', { url: 'https://app.example.com', platform: 'web' }, `/developers/releases/${relId}/deployment-url`), env);
  await developerAppRoutes.submitRelease(req('u1', {}, `/developers/releases/${relId}/submit`), env);
  return { env, relId };
}

test('admin queue lists submitted releases with package + security status', async () => {
  const { env } = await submittedRelease();
  const queue: any = await adminDeveloperAppRoutes.listReleases(req('admin1', null, '/admin/developers/releases', 'GET'), env);
  assert.equal(queue.releases.length, 1);
  assert.equal(queue.releases[0].status, 'submitted');
  assert.equal(queue.releases[0].packageCount, 2, 'windows file + web deployment URL');
  assert.equal(queue.releases[0].publisherName, 'Org A');

  const detail: any = await adminDeveloperAppRoutes.getRelease(req('admin1', null, `/admin/developers/releases/${env.db.releases[0].id}`, 'GET'), env);
  assert.equal(detail.packages.length, 2);
  assert.equal(detail.packages[0].security_scan_status, 'pending');
  assert.equal(detail.packages[0].sha256.length, 64);
});

test('admin review flow: review -> approve (approval != publication)', async () => {
  const { env, relId } = await submittedRelease();
  const review: any = await adminDeveloperAppRoutes.startReleaseReview(req('admin1', {}, `/admin/developers/releases/${relId}/review`), env);
  assert.equal(review.release.status, 'under_review');
  const approve: any = await adminDeveloperAppRoutes.approveRelease(req('admin1', {}, `/admin/developers/releases/${relId}/approve`), env);
  assert.equal(approve.release.status, 'approved');
  assert.equal(env.db.releases[0].status, 'approved');
  assert.notEqual(env.db.releases[0].status, 'published', 'approval alone does NOT publish');
  assert.ok(env.db.developer_audit_logs.some((l: any) => l.action === 'developer_release_approved'));
  // The thread carries the admin's message.
  assert.ok(env.db.developer_thread_messages.some((m: any) => m.sender_context === 'ADMIN' && m.body.includes('approved')));
});

test('admin reject/request-changes REQUIRE reasons; records and history preserved', async () => {
  const { env, relId } = await submittedRelease();
  const noReason: any = await adminDeveloperAppRoutes.rejectRelease(req('admin1', {}, `/admin/developers/releases/${relId}/reject`), env);
  assert.equal(noReason.code, 'VALIDATION_ERROR');

  const changes: any = await adminDeveloperAppRoutes.requestReleaseChanges(req('admin1', { reason: 'Please add release notes detailing the fix.' }, `/admin/developers/releases/${relId}/request-changes`), env);
  assert.equal(changes.release.status, 'changes_requested');
  assert.equal(env.db.releases[0].review_reason, 'Please add release notes detailing the fix.');

  // Developer can edit again and resubmit (history preserved — same record).
  const edit: any = await developerAppRoutes.updateRelease(req('u1', { buildNumber: '43' }, `/developers/releases/${relId}`, 'PATCH'), env);
  assert.equal(edit.success, true);
  const resubmit: any = await developerAppRoutes.submitRelease(req('u1', {}, `/developers/releases/${relId}/submit`), env);
  assert.equal(resubmit.release.status, 'submitted');

  const rejected: any = await adminDeveloperAppRoutes.rejectRelease(req('admin1', { reason: 'Not a good fit for the store.' }, `/admin/developers/releases/${relId}/reject`), env);
  assert.equal(rejected.release.status, 'rejected');
  assert.equal(env.db.releases.length, 1, 'the rejected release record is PRESERVED, not deleted');
});

test('admin app review: approve lists the app; suspend unlists it', async () => {
  const env = await seededApp();
  env.db.applications[0].status = 'submitted';
  const approve: any = await adminDeveloperAppRoutes.approveApp(req('admin1', {}, '/admin/developers/apps/app_seed/approve'), env);
  assert.equal(approve.app.status, 'active');
  const suspend: any = await adminDeveloperAppRoutes.suspendApp(req('admin1', {}, '/admin/developers/apps/app_seed/suspend'), env);
  assert.equal(suspend.app.status, 'suspended');
  const back: any = await adminDeveloperAppRoutes.reinstateApp(req('admin1', {}, '/admin/developers/apps/app_seed/reinstate'), env);
  assert.equal(back.app.status, 'active');
});

test('publishing a developer release REQUIRES prior approval (existing publish endpoint guard)', async () => {
  const { env, relId } = await submittedRelease();
  // The guard in adminRoutes.publishRelease: developer release not yet approved.
  const blocked: any = await adminRoutes.publishRelease(req('admin1', {}, `/admin/releases/${relId}/publish`), env);
  assert.ok(String(blocked.error).includes('approved before publishing'));
  // Approve, then the guard passes (the rest of publishRelease runs; here we
  // only assert the guard no longer blocks — full publish is covered by the
  // existing release tests + the published-only download filter).
  await adminDeveloperAppRoutes.approveRelease(req('admin1', {}, `/admin/developers/releases/${relId}/approve`), env);
  const attempt: any = await adminRoutes.publishRelease(req('admin1', {}, `/admin/releases/${relId}/publish`), env);
  assert.notEqual(String(attempt.error || ''), 'Developer-submitted releases must be approved before publishing');
});

// ---------------------------------------------------------------------------
// Security: cross-org + privilege boundaries
// ---------------------------------------------------------------------------

test('another developer cannot edit or upload to org A\'s app/release', async () => {
  const { env, relId } = await submittedRelease();
  // u2 has no membership at all.
  const editApp: any = await developerAppRoutes.updateApp(req('u2', { name: 'Hacked' }, '/developers/apps/app_seed', 'PATCH'), env);
  assert.equal(editApp.code, 'FORBIDDEN');

  // u2 with their OWN org still cannot touch org A's release.
  env.db.developers.push({ id: 'dev_bbbbbbbb2', user_id: 'u2', status: 'ACTIVE', created_at: '2026-01-01' });
  env.db.developer_members.push({ id: 'dm2', developer_id: 'dev_bbbbbbbb2', user_id: 'u2', role: 'OWNER', created_at: '2026-01-01' });
  env.db.releases[0].status = 'draft';
  const upload: any = await developerAppRoutes.uploadPackage(fileReq('u2', `/developers/releases/${relId}/packages`, new File([new TextEncoder().encode('evil')], 'evil.exe'), 'windows', 'x64'), env);
  assert.equal(upload.code, 'NOT_FOUND', "another org's release is indistinguishable from a missing one");
  const editRel: any = await developerAppRoutes.updateRelease(req('u2', { buildNumber: '0' }, `/developers/releases/${relId}`, 'PATCH'), env);
  assert.equal(editRel.code, 'NOT_FOUND');
});

test('no developer-facing approve/publish path exists (admin-gated only)', () => {
  assert.equal((developerAppRoutes as any).approveRelease, undefined);
  assert.equal((developerAppRoutes as any).publishRelease, undefined);
  assert.equal((developerAppRoutes as any).rejectRelease, undefined);
  assert.ok((adminDeveloperAppRoutes as any).approveRelease, 'admin side has it');
});

// ---------------------------------------------------------------------------
// Public marketplace visibility
// ---------------------------------------------------------------------------

test('draft/submitted/rejected apps are invisible in the public catalog AND by slug', async () => {
  const env = await seededApp();
  // A developer draft app.
  await developerAppRoutes.createApp(req('u1', { name: 'Secret Draft', description: 'Not public yet', category: 'healthcare', platforms: ['web'], icon: 'https://x/i.png' }, '/developers/apps'), env);
  const draft = env.db.applications.find((a: any) => a.slug === 'secret-draft');

  const list: any = await appsRoutes.list(new Request('https://api.rxstore.com/apps'), env);
  assert.ok(!list.apps.some((a: any) => a.id === draft.id), 'draft not in the public list');
  assert.ok(list.apps.some((a: any) => a.id === 'app_seed'), 'active app still listed');

  const detail: any = await appsRoutes.detail(new Request('https://api.rxstore.com/apps/secret-draft'), env);
  assert.equal(detail.error, 'Application not found', 'draft unreachable by slug');

  // Submitted and suspended likewise.
  draft.status = 'submitted';
  const detail2: any = await appsRoutes.detail(new Request('https://api.rxstore.com/apps/secret-draft'), env);
  assert.equal(detail2.error, 'Application not found');
  draft.status = 'suspended';
  const detail3: any = await appsRoutes.detail(new Request('https://api.rxstore.com/apps/secret-draft'), env);
  assert.equal(detail3.error, 'Application not found');
});

test('withdraw: developer can withdraw a submission and the record survives', async () => {
  const { env, relId } = await submittedRelease();
  const out: any = await developerAppRoutes.withdrawRelease(req('u1', {}, `/developers/releases/${relId}/withdraw`), env);
  assert.equal(out.release.status, 'withdrawn');
  assert.equal(env.db.releases.length, 1);
  assert.ok(env.db.developer_audit_logs.some((l: any) => l.action === 'developer_release_withdrawn'));
});
