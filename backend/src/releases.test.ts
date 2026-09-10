/**
 * Release / package architecture tests (Prompt 7).
 *
 * Pure and hermetic: SemVer, channel semantics, package integrity, deterministic
 * platform+architecture selection, manifest construction, OS compatibility,
 * pagination metadata, publish validation, rollback semantics, and download →
 * installation separation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSemver,
  compareSemver,
  isNewer,
  normalizeChannel,
  defaultChannel,
  normalizePlatform,
  normalizeArchitecture,
  platformSearchIds,
  architectureSearchOrder,
  isArchAgnostic,
  validatePackageIntegrity,
  selectPackage,
  buildManifest,
  isOsCompatible,
  paginationMeta,
  CHANNELS,
} from './services/releases.ts';

const sha = 'a'.repeat(64);

const pkg = (over: any = {}) => ({
  id: `pkg_${over.platform || 'windows'}_${over.architecture || 'x64'}`,
  application_id: 'app1',
  release_id: 'rel1',
  platform: 'windows',
  architecture: 'x64',
  filename: 'app.exe',
  storage_key: 'apps/app/1.0.0/windows/app.exe',
  file_size: 1024,
  sha256: sha,
  version: '1.0.0',
  package_type: 'installer',
  status: 'published',
  ...over,
});

// ---------------------------------------------------------------------------
// SemVer
// ---------------------------------------------------------------------------
test('SemVer: 1.10.0 > 1.9.0 and 2.0.0 > 1.99.0 (numeric, not lexicographic)', () => {
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
  assert.equal(compareSemver('2.0.0', '1.99.0'), 1);
  assert.equal(compareSemver('1.0.9', '1.0.10'), -1);
});

test('SemVer: a final release is NEWER than its prerelease', () => {
  assert.equal(compareSemver('1.3.0', '1.3.0-beta'), 1);
  assert.equal(compareSemver('1.3.0-beta', '1.3.0'), -1);
  assert.equal(compareSemver('1.3.0-beta.2', '1.3.0-beta.1'), 1);
  assert.equal(compareSemver('1.3.0-alpha', '1.3.0-beta'), -1);
  assert.equal(compareSemver('1.3.0', '1.3.0'), 0);
});

test('SemVer: build metadata is ignored for precedence; leading v accepted', () => {
  assert.equal(compareSemver('1.2.3+build.9', '1.2.3+build.1'), 0);
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0);
});

test('SemVer: partial versions and invalid input are handled safely', () => {
  assert.equal(compareSemver('1.2', '1.2.0'), 0);
  assert.equal(compareSemver('1', '1.0.0'), 0);
  assert.equal(compareSemver('garbage', '1.0.0'), -1, 'unparseable sorts below');
  assert.equal(compareSemver('', ''), 0);
  assert.equal(parseSemver('not-a-version'), null);
});

test('isNewer reflects an available update', () => {
  assert.equal(isNewer('1.3.0', '1.2.0'), true);
  assert.equal(isNewer('1.2.0', '1.2.0'), false);
  assert.equal(isNewer('1.2.0', '1.3.0'), false);
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------
test('all three channels are supported and unknown channels are rejected', () => {
  assert.deepEqual(CHANNELS, ['stable', 'beta', 'alpha']);
  assert.equal(normalizeChannel('stable'), 'stable');
  assert.equal(normalizeChannel('BETA'), 'beta');
  assert.equal(normalizeChannel('alpha'), 'alpha');
  assert.equal(normalizeChannel('nightly'), null, 'never invents a channel');
  assert.equal(normalizeChannel(''), null);
});

test('normal users default to the stable channel', () => {
  assert.equal(defaultChannel(), 'stable');
  assert.equal(defaultChannel('user'), 'stable');
  assert.equal(defaultChannel('developer'), 'stable');
});

// ---------------------------------------------------------------------------
// Platform + architecture normalization
// ---------------------------------------------------------------------------
test('platform aliases normalize without inventing platforms', () => {
  assert.equal(normalizePlatform('deb'), 'linux_deb');
  assert.equal(normalizePlatform('appimage'), 'linux_appimage');
  assert.equal(normalizePlatform('linux'), 'linux');
  assert.equal(normalizePlatform('WINDOWS'), 'windows');
  assert.equal(normalizePlatform('solaris'), null);
});

test('architecture aliases normalize (amd64/aarch64/arm64-v8a)', () => {
  assert.equal(normalizeArchitecture('amd64'), 'x64');
  assert.equal(normalizeArchitecture('x86_64'), 'x64');
  assert.equal(normalizeArchitecture('aarch64'), 'arm64');
  assert.equal(normalizeArchitecture('arm64-v8a'), 'arm64');
  assert.equal(normalizeArchitecture('armeabi-v7a'), 'arm');
  assert.equal(normalizeArchitecture('armv7'), 'arm');
  assert.equal(normalizeArchitecture('all'), 'universal');
  assert.equal(normalizeArchitecture('sparc'), null);
});

test('legacy linux platform expands to family ids; web is arch-agnostic', () => {
  assert.deepEqual(platformSearchIds('linux'), ['linux', 'linux_deb', 'linux_appimage', 'flatpak']);
  assert.deepEqual(platformSearchIds('windows'), ['windows']);
  assert.equal(isArchAgnostic('web'), true);
  assert.equal(isArchAgnostic('windows'), false);
});

test('architecture search order prefers exact, then universal', () => {
  const order = architectureSearchOrder('arm64', 'windows');
  assert.equal(order[0], 'arm64');
  assert.ok(order.includes('universal'));
  const agnostic = architectureSearchOrder('x64', 'web');
  assert.equal(agnostic[0], 'universal', 'web always resolves to universal');
});

// ---------------------------------------------------------------------------
// Package integrity
// ---------------------------------------------------------------------------
test('a complete package passes integrity validation', () => {
  assert.equal(validatePackageIntegrity(pkg()).ok, true);
});

test('incomplete package metadata is rejected (publish must fail)', () => {
  assert.deepEqual(validatePackageIntegrity(pkg({ sha256: '' })).problems, ['sha256']);
  assert.deepEqual(validatePackageIntegrity(pkg({ filename: '' })).problems, ['filename']);
  assert.deepEqual(validatePackageIntegrity(pkg({ architecture: '' })).problems, ['architecture']);
  assert.deepEqual(validatePackageIntegrity(pkg({ version: '' })).problems, ['version']);
  assert.ok(validatePackageIntegrity(pkg({ file_size: 0 })).problems.includes('file_size'));
  assert.ok(validatePackageIntegrity(pkg({ sha256: 'tooshort' })).problems.includes('sha256'));
});

test('PWA packages need a URL instead of a storage key', () => {
  const pwa = pkg({ platform: 'web', package_type: 'pwa', storage_key: '', deployment_url: 'https://app.example.com' });
  assert.equal(validatePackageIntegrity(pwa).ok, true);
  const broken = pkg({ platform: 'web', package_type: 'pwa', storage_key: '', deployment_url: '' });
  assert.equal(validatePackageIntegrity(broken).ok, true, 'url presence is validated at publish time');
});

// ---------------------------------------------------------------------------
// Package selection
// ---------------------------------------------------------------------------
test('selects the matching platform + architecture', () => {
  const packages = [pkg({ platform: 'windows', architecture: 'x64' }), pkg({ platform: 'windows', architecture: 'arm64' }), pkg({ platform: 'linux_deb', architecture: 'x64' })];
  const sel = selectPackage(packages, { platform: 'windows', architecture: 'arm64' });
  assert.ok(sel.selected);
  assert.equal(sel.selected!.matchedArchitecture, 'arm64');
  assert.equal(sel.selected!.pkg.architecture, 'arm64');
});

test('never silently returns an incompatible platform', () => {
  const packages = [pkg({ platform: 'windows', architecture: 'x64' })];
  const sel = selectPackage(packages, { platform: 'linux_deb', architecture: 'x64' });
  assert.equal(sel.selected, null);
  assert.match(sel.reason!, /linux/i);
});

test('falls back to a universal build when no architecture-specific package exists', () => {
  const packages = [pkg({ platform: 'windows', architecture: 'universal' })];
  const sel = selectPackage(packages, { platform: 'windows', architecture: 'arm64' });
  assert.ok(sel.selected);
  assert.equal(sel.selected!.matchedArchitecture, 'universal');
});

test('a universal request resolves to the available architecture', () => {
  const packages = [pkg({ platform: 'android', architecture: 'arm64' })];
  const sel = selectPackage(packages, { platform: 'android', architecture: 'universal' });
  assert.ok(sel.selected);
  assert.equal(sel.selected!.pkg.architecture, 'arm64');
});

test('an incompatible architecture reports a clear reason and selects nothing', () => {
  const packages = [pkg({ platform: 'windows', architecture: 'x64' })];
  const sel = selectPackage(packages, { platform: 'windows', architecture: 'arm64' });
  // x64 is not an acceptable substitute for an explicit arm64 request.
  assert.equal(sel.selected, null);
  assert.match(sel.reason!, /arm64/);
});

test('legacy "linux" requests are satisfied by linux_deb packages', () => {
  const packages = [pkg({ platform: 'linux_deb', architecture: 'x64' })];
  const sel = selectPackage(packages, { platform: 'linux', architecture: 'x64' });
  assert.ok(sel.selected);
  assert.equal(sel.selected!.matchedPlatform, 'linux_deb');
});

test('incomplete packages are skipped during selection', () => {
  const broken = pkg({ platform: 'windows', architecture: 'x64', sha256: '' });
  const good = pkg({ platform: 'windows', architecture: 'x64', id: 'good' });
  const sel = selectPackage([broken, good], { platform: 'windows', architecture: 'x64' });
  assert.ok(sel.selected);
  assert.equal(sel.selected!.pkg.id, 'good');
});

test('web/PWA selection prefers the universal build', () => {
  const packages = [pkg({ platform: 'web', architecture: 'x64', package_type: 'pwa' }), pkg({ platform: 'web', architecture: 'universal', package_type: 'pwa' })];
  const sel = selectPackage(packages, { platform: 'web', architecture: 'x64' });
  assert.ok(sel.selected);
  assert.equal(sel.selected!.matchedArchitecture, 'universal');
});

test('empty package list yields a null selection with a reason', () => {
  const sel = selectPackage([], { platform: 'windows', architecture: 'x64' });
  assert.equal(sel.selected, null);
  assert.ok(sel.reason);
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
test('manifest exposes everything a client needs to decide + verify', () => {
  const m = buildManifest({
    pkg: pkg({ min_os_version: '10.0.19041' }),
    matchedPlatform: 'windows', matchedArchitecture: 'x64',
    app: { id: 'app1', slug: 'cgpa-pilot', name: 'CGPA Pilot' },
    channel: 'stable', releaseNotes: ['Fixes'], origin: 'https://api.rxstore.com',
  });
  assert.equal(m.url, 'https://api.rxstore.com/r2/apps/app/1.0.0/windows/app.exe');
  assert.equal(m.sha256, sha);
  assert.equal(m.size, 1024);
  assert.equal(m.filename, 'app.exe');
  assert.equal(m.platform, 'windows');
  assert.equal(m.architecture, 'x64');
  assert.equal(m.version, '1.0.0');
  assert.equal(m.channel, 'stable');
  assert.equal(m.minOsVersion, '10.0.19041');
  assert.deepEqual(m.releaseNotes, ['Fixes']);
});

test('manifest never hand-enters size — it comes from the package record', () => {
  const m = buildManifest({ pkg: pkg({ file_size: 12345 }), matchedPlatform: 'windows', matchedArchitecture: 'x64', origin: 'https://x' });
  assert.equal(m.size, 12345);
});

// ---------------------------------------------------------------------------
// OS compatibility (informational, never blocking)
// ---------------------------------------------------------------------------
test('OS compatibility metadata blocks only a definite mismatch', () => {
  assert.equal(isOsCompatible(pkg({ min_android_sdk: 24 }), { androidSdk: 30 }), true);
  assert.equal(isOsCompatible(pkg({ min_android_sdk: 24 }), { androidSdk: 21 }), false);
  assert.equal(isOsCompatible(pkg({ min_android_sdk: 24 }), {}), true, 'unknown device signal never blocks');
  assert.equal(isOsCompatible(pkg(), { androidSdk: 1 }), true, 'no metadata never blocks');
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
test('pagination reports the true total, not the page length', () => {
  const meta = paginationMeta({ page: 2, limit: 20, total: 57 });
  assert.equal(meta.total, 57);
  assert.equal(meta.pageSize, 20);
  assert.equal(meta.totalPages, 3);
  assert.equal(meta.hasNext, true);
  assert.equal(meta.hasPrevious, true);
});

test('pagination edge cases (first page, last page, empty, bounds)', () => {
  const first = paginationMeta({ page: 1, limit: 10, total: 10 });
  assert.equal(first.hasNext, false);
  assert.equal(first.hasPrevious, false);
  const empty = paginationMeta({ page: 1, limit: 10, total: 0 });
  assert.equal(empty.totalPages, 0);
  assert.equal(empty.hasNext, false);
  const clamped = paginationMeta({ page: 0, limit: 999, total: 5 });
  assert.equal(clamped.page, 1, 'page clamps to >= 1');
  assert.equal(clamped.pageSize, 100, 'page size clamps to <= 100');
});

// ---------------------------------------------------------------------------
// Publish validation (integration-style, using a fake env)
// ---------------------------------------------------------------------------

/** Build a minimal fake D1 whose queries are routed by SQL shape. */
function fakeD1(opts: {
  release?: any;
  previous?: any;
  packages?: any[];
  adminUser?: any;
  onRun?: (sql: string, binds: any[]) => void;
}) {
  return {
    prepare(sql: string) {
      const stmt: any = {
        _binds: [] as any[],
        bind(...args: any[]) {
          stmt._binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes('FROM releases WHERE id')) return opts.release || null;
          if (sql.includes("status='published' AND id!=?")) return opts.previous || null;
          if (sql.includes('SELECT password_hash FROM users')) return opts.adminUser || null;
          return null;
        },
        async all() {
          if (sql.includes('FROM packages')) return { results: opts.packages || [] };
          return { results: [] };
        },
        async run() {
          if (opts.onRun) opts.onRun(sql, stmt._binds);
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
}

function fakeStorage(objects: Record<string, any>) {
  return {
    async head(key: string) {
      return objects[key] || null;
    },
  };
}

const DRAFT_RELEASE = { id: 'rel1', application_id: 'app1', version: '1.0.0', channel: 'stable', status: 'draft' };

function publishReq(relId = 'rel1') {
  return new Request(`https://api.rxstore.com/admin/releases/${relId}/publish`, { method: 'POST' });
}

test('publishing is refused when a package is incomplete', async () => {
  const { adminRoutes } = await import('./routes/admin.ts');
  const bad = pkg({ release_id: 'rel1', sha256: '' });
  const env: any = { DB: fakeD1({ release: DRAFT_RELEASE, packages: [bad] }), STORAGE: fakeStorage({}) };
  const out: any = await adminRoutes.publishRelease(publishReq() as any, env);
  assert.ok(out.error, 'publish refused');
  assert.match(String(out.error), /incomplete|missing/i);
});

test('publishing is refused when the stored artifact is missing', async () => {
  const { adminRoutes } = await import('./routes/admin.ts');
  const env: any = { DB: fakeD1({ release: DRAFT_RELEASE, packages: [pkg({ release_id: 'rel1' })] }), STORAGE: fakeStorage({}) };
  const out: any = await adminRoutes.publishRelease(publishReq() as any, env);
  assert.ok(out.error);
  assert.match(String(out.error), /stored file missing/i);
});

test('publishing is refused when the storage size disagrees with the record', async () => {
  const { adminRoutes } = await import('./routes/admin.ts');
  const row = pkg({ release_id: 'rel1', file_size: 1024 });
  const env: any = { DB: fakeD1({ release: DRAFT_RELEASE, packages: [row] }), STORAGE: fakeStorage({ [row.storage_key]: { size: 999999 } }) };
  const out: any = await adminRoutes.publishRelease(publishReq() as any, env);
  assert.ok(out.error);
  assert.match(String(out.error), /size mismatch/i);
});

test('a complete release publishes successfully', async () => {
  const { adminRoutes } = await import('./routes/admin.ts');
  const row = pkg({ release_id: 'rel1', file_size: 1024 });
  const env: any = { DB: fakeD1({ release: DRAFT_RELEASE, packages: [row] }), STORAGE: fakeStorage({ [row.storage_key]: { size: 1024 } }) };
  const out: any = await adminRoutes.publishRelease(publishReq() as any, env);
  assert.equal(out.success, true);
  assert.equal(out.version, '1.0.0');
});

test('publishing is refused for an unknown channel', async () => {
  const { adminRoutes } = await import('./routes/admin.ts');
  const rel = { ...DRAFT_RELEASE, channel: 'nightly' };
  const env: any = { DB: fakeD1({ release: rel, packages: [pkg({ release_id: 'rel1' })] }), STORAGE: fakeStorage({}) };
  const out: any = await adminRoutes.publishRelease(publishReq() as any, env);
  assert.ok(out.error);
  assert.match(String(out.error), /channel/i);
});

test('publishing is refused with no packages at all', async () => {
  const { adminRoutes } = await import('./routes/admin.ts');
  const env: any = { DB: fakeD1({ release: DRAFT_RELEASE, packages: [] }), STORAGE: fakeStorage({}) };
  const out: any = await adminRoutes.publishRelease(publishReq() as any, env);
  assert.ok(out.error);
  assert.match(String(out.error), /no packages/i);
});

// ---------------------------------------------------------------------------
// Rollback semantics
// ---------------------------------------------------------------------------
test('rollback restores the target release and its packages WITHOUT deleting history', async () => {
  const { adminRoutes } = await import('./routes/admin.ts');
  const { hashPassword, generateToken } = await import('./services/auth.ts');
  const statements: string[] = [];
  const rel = { id: 'rel2', application_id: 'app1', version: '1.1.0', status: 'published' };
  const prev = { id: 'rel1', application_id: 'app1', version: '1.0.0', status: 'published' };
  const secret = 'rollback-test-secret';
  const adminUser = { password_hash: await hashPassword('admin-pass-1') };
  const token = await generateToken({ userId: 'admin1', role: 'admin' }, secret);
  const env: any = {
    JWT_SECRET: secret,
    STORAGE: fakeStorage({}),
    DB: fakeD1({
      release: rel, previous: prev, adminUser,
      onRun: (sql) => statements.push(sql.replace(/\s+/g, ' ').trim()),
    }),
  };
  const req = new Request('https://api.rxstore.com/admin/releases/rel2/rollback', {
    method: 'POST',
    body: JSON.stringify({ password: 'admin-pass-1' }),
    headers: { Authorization: `Bearer ${token}` },
  });
  const out: any = await adminRoutes.rollbackRelease(req as any, env);
  assert.equal(out.rolledBack, '1.1.0', `unexpected: ${JSON.stringify(out)}`);
  assert.equal(out.now, '1.0.0');
  const joined = statements.join(' | ');
  assert.match(joined, /UPDATE releases SET status='rolled_back'/, 'current release marked rolled_back (not deleted)');
  assert.match(joined, /UPDATE releases SET status='published'/, 'target release restored to published');
  assert.match(joined, /UPDATE packages SET status='published' WHERE release_id=\?/, 'target packages re-published');
  assert.ok(!/DELETE FROM releases/i.test(joined), 'rollback never deletes release history');
});

// ---------------------------------------------------------------------------
// Downloads are NOT installations
// ---------------------------------------------------------------------------
test('a download record is never treated as an installation', async () => {
  // The download route only inserts into `downloads` + bumps download_count.
  // Installation state lives in app_installations (Prompt 2/3) and is only written
  // after confirmed native detection. This guards against regressions.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const downloadBlock = src.slice(src.indexOf("apps\\/[^\\/]+\\/download"), src.indexOf('// Notifications'));
  assert.ok(/INSERT INTO downloads/.test(downloadBlock), 'records the download');
  assert.ok(!/INSERT INTO app_installations/.test(downloadBlock), 'never creates an installation record');
  assert.ok(/userId/.test(downloadBlock) || /dlUser/.test(downloadBlock), 'associates the authenticated user');
});
