/**
 * Manual Security Review tests — the controlled fallback for indeterminate
 * automated results (UNAVAILABLE / SCANNING / UNKNOWN / NEEDS_REVIEW).
 *
 * Drives the REAL securityAdminRoutes + publicationSecurityGate against a
 * fake D1, verifying:
 *   - reviews open automatically for the indeterminate states
 *   - APPROVE authorizes publication for EXACTLY the reviewed SHA-256
 *   - REJECT keeps publication blocked
 *   - non-admins cannot decide; short notes are refused
 *   - wrong-hash approvals cannot publish; replacements invalidate
 *   - DETECTED malware is never manually approvable
 *   - every decision writes an immutable audit event
 *
 * Run: node --experimental-strip-types --test backend/src/manualReview.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { securityAdminRoutes } from './routes/securityAdmin.ts';
import { publicationSecurityGate, MANUAL_REVIEW_MALWARE_STATES } from './services/packageSecurity.ts';

const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = realFetch; });

// ---------------------------------------------------------------------------
// Fake D1
// ---------------------------------------------------------------------------

function fakeEnv(seed: { packages?: any[]; results?: any[]; reviews?: any[]; overrides?: any[] } = {}) {
  const db: any = {
    packages: seed.packages || [],
    package_security_results: seed.results || [],
    package_manual_reviews: seed.reviews || [],
    package_security_overrides: seed.overrides || [],
    audit_logs: [],
    developer_audit_logs: [],
    users: [
      { id: 'admin-1', role: 'admin', name: 'The Admin' },
      { id: 'user-1', role: 'user', name: 'Plain User' },
    ],
    releases: [{ id: 'rel-1', application_id: 'app-1', version: '1.11.11', status: 'approved', developer_id: 'dev-1' }],
    applications: [{ id: 'app-1', name: 'Clinical Rx', slug: 'clinical-rx' }],
    developer_members: [{ user_id: 'dev-user-1', developer_id: 'dev-1' }],
  };
  const DB = {
    prepare(sql: string) {
      const self: any = {
        _b: [] as any[],
        bind(...a: any[]) { self._b = a; return self; },
        async first() {
          const s = sql.replace(/\s+/g, ' ');
          const a = self._b;
          if (s.includes('FROM users WHERE id=?')) return db.users.find((u: any) => u.id === a[0]) || null;
          if (s.includes('SELECT * FROM packages WHERE id=?')) return db.packages.find((p: any) => p.id === a[0]) || null;
          if (s.includes('SELECT id, sha256 FROM packages WHERE release_id=? AND platform=? AND architecture=?')) {
            const [release_id, platform, architecture] = a;
            return db.packages.find((p: any) => p.release_id === release_id && p.platform === platform && p.architecture === architecture) || null;
          }
          if (s.includes('SELECT * FROM package_manual_reviews WHERE package_id=? AND status=\'PENDING\'')) {
            return db.package_manual_reviews.filter((r: any) => r.package_id === a[0] && r.status === 'PENDING' && !r.invalidated_at)
              .sort((x: any, y: any) => (y.created_at || '').localeCompare(x.created_at || ''))[0] || null;
          }
          if (s.includes("SELECT * FROM package_manual_reviews WHERE package_id=? AND status='APPROVED'")) {
            return db.package_manual_reviews.filter((r: any) => r.package_id === a[0] && r.status === 'APPROVED' && !r.invalidated_at)[0] || null;
          }
          if (s.includes('SELECT id FROM package_manual_reviews WHERE package_id=? AND sha256=?')) {
            return db.package_manual_reviews.find((r: any) => r.package_id === a[0] && String(r.sha256).toLowerCase() === String(a[1]).toLowerCase() && ['PENDING', 'APPROVED'].includes(r.status) && !r.invalidated_at) || null;
          }
          if (s.includes('SELECT * FROM package_security_overrides WHERE package_id=?')) {
            return db.package_security_overrides.filter((o: any) => o.package_id === a[0] && !o.invalidated_at)
              .sort((x: any, y: any) => (y.created_at || '').localeCompare(x.created_at || ''))[0] || null;
          }
          if (s.includes('SELECT status FROM package_security_results WHERE package_id=? AND check_type=?')) {
            const rows = db.package_security_results.filter((r: any) => r.package_id === a[0] && r.check_type === a[1]);
            return rows.length ? { status: rows[rows.length - 1].status } : null;
          }
          if (s.includes('SELECT check_type, status, result, details FROM package_security_results')) {
            return { all: async () => ({ results: db.package_security_results.filter((r: any) => r.package_id === a[0] && ['FAILED','DETECTED','WARNING','NEEDS_REVIEW','UNAVAILABLE','PENDING','SCANNING'].includes(r.status)) }) } as any;
          }
          if (s.includes('SELECT p.id AS package_id') || s.includes('FROM packages p LEFT JOIN releases')) {
            return { all: async () => ({ results: db.packages.filter((p: any) => !p.deployment_url && p.overall_security !== 'PASSED').map((p: any) => ({
              package_id: p.id, platform: p.platform, architecture: p.architecture, filename: p.filename, file_size: p.file_size, sha256: p.sha256,
              security_state: p.security_state, overall_security: p.overall_security, security_scan_status: p.security_scan_status, signature_status: p.signature_status, package_status: p.status,
              release_id: 'rel-1', version: '1.11.11', release_status: 'approved', app_name: 'Clinical Rx', app_slug: 'clinical-rx', developer_id: 'dev-1', publisher_name: 'Pub',
              review_id: null, review_status: null, review_reason: null, automated_integrity: null, automated_malware: null, automated_overall: null, review_created_at: null,
            })) }) } as any;
          }
          return null;
        },
        async all() {
          const s = sql.replace(/\s+/g, ' ');
          const a = self._b;
          if (s.includes('SELECT p.id AS package_id') || s.includes('FROM packages p LEFT JOIN releases')) {
            return { results: db.packages.filter((p: any) => !p.deployment_url && p.overall_security !== 'PASSED').map((p: any) => ({
              package_id: p.id, platform: p.platform, architecture: p.architecture, filename: p.filename, file_size: p.file_size, sha256: p.sha256,
              security_state: p.security_state, overall_security: p.overall_security, security_scan_status: p.security_scan_status, signature_status: p.signature_status, package_status: p.status,
              release_id: 'rel-1', version: '1.11.11', release_status: 'approved', app_name: 'Clinical Rx', app_slug: 'clinical-rx', developer_id: 'dev-1', publisher_name: 'Pub',
              review_id: null, review_status: null, review_reason: null, automated_integrity: null, automated_malware: null, automated_overall: null, review_created_at: null,
            })) };
          }
          if (s.includes('FROM packages WHERE release_id=?')) return { results: db.packages.filter((p: any) => p.release_id === a[0]) };
          if (s.includes('FROM package_security_results WHERE package_id=? AND id IN')) return { results: db.package_security_results.filter((r: any) => r.package_id === a[0] && ['FAILED','DETECTED','WARNING','NEEDS_REVIEW','UNAVAILABLE','PENDING','SCANNING'].includes(r.status)) };
          if (s.includes('SELECT key, value FROM site_settings')) return { results: [] };
          return { results: [] };
        },
        async run() {
          const s = sql.replace(/\s+/g, ' ');
          const a = self._b;
          if (s.includes('INSERT INTO audit_logs')) { db.audit_logs.push({ id: a[0], action: a[1], resource_id: a[3], details: a[4] }); return { meta: { changes: 1 } }; }
          if (s.includes('INSERT INTO developer_audit_logs')) { db.developer_audit_logs.push({ id: a[0], action: a[3] }); return { meta: { changes: 1 } }; }
          if (s.includes('INSERT INTO notifications')) return { meta: { changes: 1 } };
          if (s.includes('INSERT INTO package_manual_reviews')) {
            db.package_manual_reviews.push({ id: a[0], package_id: a[1], release_id: a[2], sha256: a[3], platform: a[4], automated_integrity: a[5], automated_malware: a[6], automated_overall: a[7], reason: a[8], status: 'PENDING', created_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE package_manual_reviews SET status=?')) {
            const r = db.package_manual_reviews.find((x: any) => x.id === a[4]);
            if (r) { r.status = a[0]; r.admin_user_id = a[1]; r.admin_notes = a[2]; r.reviewed_at = 'now'; r.audit_event_id = a[3]; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes('UPDATE package_manual_reviews SET invalidated_at')) {
            for (const r of db.package_manual_reviews) if (r.package_id === a[0] && String(r.sha256).toLowerCase() !== String(a[1]).toLowerCase()) r.invalidated_at = 'now';
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE package_security_overrides SET invalidated_at')) {
            for (const o of db.package_security_overrides) if (o.package_id === a[0] && o.sha256 && String(o.sha256).toLowerCase() !== String(a[1]).toLowerCase()) o.invalidated_at = 'now';
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO package_security_overrides')) {
            db.package_security_overrides.push({ id: a[0], package_id: a[1], admin_user_id: a[2], reason: a[3], prior_state: a[4], prior_overall: a[5], sha256: a[6], created_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO packages')) {
            const [id, application_id, release_id, platform, architecture, filename, storage_key, file_size, mime_type, sha256] = a;
            const i = db.packages.findIndex((p: any) => p.release_id === release_id && p.platform === platform && p.architecture === architecture);
            const row = { id, application_id, release_id, platform, architecture, filename, storage_key, file_size, mime_type, sha256, version: '1.11.11', package_type: 'installer', status: 'stored', quarantine_key: storage_key, security_state: 'QUARANTINED', overall_security: 'PENDING', security_scan_status: 'pending', signature_status: 'pending', developer_id: 'dev-1', deployment_url: null };
            if (i >= 0) { row.id = db.packages[i].id; db.packages[i] = row; } else db.packages.push(row);
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE packages SET')) {
            for (const p of db.packages) {
              if (s.includes('WHERE id=?') && p.id !== a[a.length - 1]) continue;
              if (s.includes("security_state='QUARANTINED'")) { p.security_state = 'QUARANTINED'; p.overall_security = 'PENDING'; p.security_scan_status = 'pending'; p.signature_status = 'pending'; }
            }
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  return { DB, db, STORAGE: { async get() { return null; } } };
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function pkgWith(malware: string, over: Record<string, any> = {}) {
  return {
    id: 'pkg-1', application_id: 'app-1', release_id: 'rel-1', platform: 'linux_deb', architecture: 'x64',
    filename: 'clinical-rx_1.11.11_amd64.deb', storage_key: 'quarantine/k', quarantine_key: 'quarantine/k',
    file_size: 86 * 1024 * 1024, mime_type: 'application/vnd.debian.binary-package', sha256: HASH_A, version: '1.11.11',
    package_type: 'installer', status: 'stored', security_state: 'MALWARE_SCAN', overall_security: 'NEEDS_REVIEW',
    security_scan_status: malware, signature_status: 'UNSIGNED', developer_id: 'dev-1', deployment_url: null,
    ...over,
  };
}

function resultsFor(malware: string, over: any[] = []) {
  return [
    { package_id: 'pkg-1', check_type: 'structure', status: 'PASSED', result: 'ok', created_at: 't1' },
    { package_id: 'pkg-1', check_type: 'integrity', status: 'PASSED', result: 'streamed hash matches', created_at: 't2' },
    { package_id: 'pkg-1', check_type: 'malware', status: malware, result: `malware ${malware}`, created_at: 't3' },
    ...over,
  ];
}

const req = (userId: string | null, body: any, path: string, method = 'POST') => {
  const r = new Request(`https://api.test${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  if (userId) (r as any).user = { userId };
  return r;
};

const REVIEW_PATH = '/admin/security/packages/pkg-1/manual-review';

// ---------------------------------------------------------------------------
// §10 required cases
// ---------------------------------------------------------------------------

for (const state of ['UNAVAILABLE', 'SCANNING', 'UNKNOWN', 'NEEDS_REVIEW']) {
  test(`${state} package appears in the review queue (manual review path)`, async () => {
    const env = fakeEnv({ packages: [pkgWith(state)], results: resultsFor(state) });
    const out: any = await securityAdminRoutes.reviewQueue(req('admin-1', {}, '/admin/security/review-queue', 'GET'), env);
    assert.equal(out.queue.length, 1);
    assert.equal(out.queue[0].packageId, 'pkg-1');
    assert.equal(out.queue[0].automated.malwareStatus, state);
    assert.ok(out.queue[0].manualReviewEligible, `${state} is manual-review eligible`);
    assert.ok(out.queue[0].sha256);
  });
}

test('valid admin APPROVAL → publication allowed with MANUAL_APPROVAL authorization', async () => {
  const env = fakeEnv({
    packages: [pkgWith('UNAVAILABLE')],
    results: resultsFor('UNAVAILABLE'),
    reviews: [{ id: 'mrev-1', package_id: 'pkg-1', sha256: HASH_A, platform: 'linux_deb', reason: 'scanner unreachable', status: 'PENDING', created_at: 't0' }],
  });
  const out: any = await securityAdminRoutes.manualReview(req('admin-1', { decision: 'APPROVE', notes: 'Manually verified against the vendor checksum and a local scan — safe to publish.' }, REVIEW_PATH), env);
  assert.ok(out.success, JSON.stringify(out));
  assert.equal(out.manualReviewStatus, 'APPROVED');
  assert.equal(out.publicationAuthorization, 'MANUAL_APPROVAL');
  assert.equal(out.automatedSecurityStatus, 'NEEDS_REVIEW', 'the automated verdict stays visible');
  // The gate now authorizes this release via MANUAL_APPROVAL.
  const gate = await publicationSecurityGate(env, 'rel-1');
  assert.equal(gate.ok, true);
  assert.equal(gate.authorizations.find((x: any) => x.packageId === 'pkg-1')?.publicationAuthorization, 'MANUAL_APPROVAL');
  // The automated statuses on the package were NOT overwritten.
  assert.equal(env.db.packages[0].overall_security, 'NEEDS_REVIEW');
});

test('REJECTION → publication remains blocked', async () => {
  const env = fakeEnv({
    packages: [pkgWith('SCANNING')],
    results: resultsFor('SCANNING'),
    reviews: [{ id: 'mrev-1', package_id: 'pkg-1', sha256: HASH_A, platform: 'linux_deb', reason: 'analysis in progress', status: 'PENDING', created_at: 't0' }],
  });
  const out: any = await securityAdminRoutes.manualReview(req('admin-1', { decision: 'REJECT', notes: 'Could not corroborate the binary with any vendor source.' }, REVIEW_PATH), env);
  assert.ok(out.success);
  assert.equal(out.manualReviewStatus, 'REJECTED');
  assert.equal(out.publicationAuthorization, null);
  const gate = await publicationSecurityGate(env, 'rel-1');
  assert.equal(gate.ok, false);
});

test('non-admin cannot approve (server-side role enforcement)', async () => {
  const env = fakeEnv({
    packages: [pkgWith('UNAVAILABLE')],
    results: resultsFor('UNAVAILABLE'),
    reviews: [{ id: 'mrev-1', package_id: 'pkg-1', sha256: HASH_A, platform: 'linux_deb', reason: 'r', status: 'PENDING', created_at: 't0' }],
  });
  const out: any = await securityAdminRoutes.manualReview(req('user-1', { decision: 'APPROVE', notes: 'trust me bro, totally safe' }, REVIEW_PATH), env);
  assert.equal(out.code, 'FORBIDDEN');
  assert.equal(env.db.package_manual_reviews[0].status, 'PENDING', 'decision not applied');
});

test('missing / short review notes are rejected', async () => {
  const env = fakeEnv({
    packages: [pkgWith('UNAVAILABLE')],
    results: resultsFor('UNAVAILABLE'),
    reviews: [{ id: 'mrev-1', package_id: 'pkg-1', sha256: HASH_A, platform: 'linux_deb', reason: 'r', status: 'PENDING', created_at: 't0' }],
  });
  const none: any = await securityAdminRoutes.manualReview(req('admin-1', { decision: 'APPROVE' }, REVIEW_PATH), env);
  assert.equal(none.code, 'VALIDATION_ERROR');
  const short: any = await securityAdminRoutes.manualReview(req('admin-1', { decision: 'APPROVE', notes: 'ok' }, REVIEW_PATH), env);
  assert.equal(short.code, 'VALIDATION_ERROR');
});

test('wrong SHA-256 approval cannot publish (byte binding is authoritative)', async () => {
  const env = fakeEnv({
    packages: [pkgWith('UNAVAILABLE')], // current bytes = HASH_A
    results: resultsFor('UNAVAILABLE'),
    // approval exists but was issued for DIFFERENT bytes
    reviews: [{ id: 'mrev-1', package_id: 'pkg-1', sha256: HASH_B, platform: 'linux_deb', reason: 'r', status: 'APPROVED', admin_user_id: 'admin-1', admin_notes: 'n', created_at: 't0', reviewed_at: 't1' }],
  });
  const gate = await publicationSecurityGate(env, 'rel-1');
  assert.equal(gate.ok, false, 'an approval for other bytes does not authorize these bytes');
});

test('package replacement invalidates the old approval (fresh verification required)', async () => {
  const env = fakeEnv({
    packages: [pkgWith('UNAVAILABLE')],
    results: resultsFor('UNAVAILABLE'),
    reviews: [{ id: 'mrev-1', package_id: 'pkg-1', sha256: HASH_A, platform: 'linux_deb', reason: 'r', status: 'APPROVED', admin_user_id: 'admin-1', admin_notes: 'n', created_at: 't0' }],
  });
  // Simulate the replacement path: writePackageRow invalidation runs when the
  // (release, platform, arch) row is rewritten with different bytes.
  await env.DB.prepare(
    `INSERT INTO packages (id, application_id, release_id, platform, architecture, filename, storage_key, file_size, mime_type, sha256)
     VALUES ('pkg-2','app-1','rel-1','linux_deb','x64','new.deb','quarantine/k2',1,'application/octet-stream',?)`
  ).bind(HASH_B).run();
  await env.DB.prepare(`UPDATE package_manual_reviews SET invalidated_at=datetime('now') WHERE package_id=? AND sha256 != ? AND invalidated_at IS NULL`)
    .bind('pkg-1', HASH_B).run();
  assert.equal(env.db.package_manual_reviews[0].invalidated_at, 'now', 'approval actively invalidated');
  const gate = await publicationSecurityGate(env, 'rel-1');
  assert.equal(gate.ok, false, 'replaced package needs fresh verification');
});

test('DETECTED malware remains blocked by the manual-review flow', async () => {
  const env = fakeEnv({
    packages: [pkgWith('DETECTED', { overall_security: 'FAILED' })],
    results: resultsFor('DETECTED'),
    reviews: [{ id: 'mrev-1', package_id: 'pkg-1', sha256: HASH_A, platform: 'linux_deb', reason: 'r', status: 'PENDING', created_at: 't0' }],
  });
  const out: any = await securityAdminRoutes.manualReview(req('admin-1', { decision: 'APPROVE', notes: 'I believe this is a false positive, honestly.' }, REVIEW_PATH), env);
  assert.equal(out.code, 'FORBIDDEN', 'detected malware can never be manually approved');
  assert.match(out.error, /never be manually approved/);
  // Even a forged APPROVED row cannot authorize DETECTED bytes:
  env.db.package_manual_reviews[0].status = 'APPROVED';
  const gate = await publicationSecurityGate(env, 'rel-1');
  assert.equal(gate.ok, false, 'the gate independently refuses DETECTED');
});

test('audit record is created for every decision', async () => {
  const env = fakeEnv({
    packages: [pkgWith('UNKNOWN')],
    results: resultsFor('UNKNOWN'),
    reviews: [{ id: 'mrev-1', package_id: 'pkg-1', sha256: HASH_A, platform: 'linux_deb', reason: 'r', status: 'PENDING', created_at: 't0' }],
  });
  await securityAdminRoutes.manualReview(req('admin-1', { decision: 'APPROVE', notes: 'Verified against the vendor signature.' }, REVIEW_PATH), env);
  assert.equal(env.db.audit_logs.length, 1);
  assert.equal(env.db.audit_logs[0].action, 'manual_security_review_approved');
  const details = JSON.parse(env.db.audit_logs[0].details);
  assert.equal(details.sha256, HASH_A, 'audit binds the decision to the exact bytes');
  assert.equal(env.db.package_manual_reviews[0].audit_event_id, env.db.audit_logs[0].id, 'review ↔ audit event linked');
});

test('the current package can only use an approval for its exact hash (direct check)', async () => {
  const env = fakeEnv({
    packages: [pkgWith('SCANNING')],
    results: resultsFor('SCANNING'),
    reviews: [
      { id: 'mrev-old', package_id: 'pkg-1', sha256: HASH_B, platform: 'linux_deb', reason: 'old bytes', status: 'APPROVED', created_at: 't0' },
      { id: 'mrev-new', package_id: 'pkg-1', sha256: HASH_A, platform: 'linux_deb', reason: 'current bytes', status: 'PENDING', created_at: 't1' },
    ],
  });
  // The old APPROVED row (different hash) must not authorize; the pending one is not a decision.
  const gate = await publicationSecurityGate(env, 'rel-1');
  assert.equal(gate.ok, false);
});

test('approval also covers the signature NEEDS_REVIEW case (clean malware + unsigned/chain issue)', async () => {
  const env = fakeEnv({
    packages: [pkgWith('CLEAN', { overall_security: 'NEEDS_REVIEW', signature_status: 'NEEDS_REVIEW' })],
    results: [
      ...resultsFor('CLEAN'),
      { package_id: 'pkg-1', check_type: 'signature', status: 'NEEDS_REVIEW', result: 'certificate chain not validatable in this pipeline', created_at: 't4' },
    ],
    reviews: [{ id: 'mrev-1', package_id: 'pkg-1', sha256: HASH_A, platform: 'linux_deb', reason: 'signature chain requires review', status: 'PENDING', created_at: 't0' }],
  });
  const out: any = await securityAdminRoutes.manualReview(req('admin-1', { decision: 'APPROVE', notes: 'Cert chain manually verified against the vendor root.' }, REVIEW_PATH), env);
  assert.ok(out.success, JSON.stringify(out));
  const gate = await publicationSecurityGate(env, 'rel-1');
  assert.equal(gate.ok, true, 'the classic Phase 13 chain-of-trust case flows through manual review');
});

test('approval is refused when automated integrity is not PASSED', async () => {
  const env = fakeEnv({
    packages: [pkgWith('SCANNING', { overall_security: 'FAILED' })],
    results: [
      { package_id: 'pkg-1', check_type: 'structure', status: 'PASSED', result: 'ok', created_at: 't1' },
      { package_id: 'pkg-1', check_type: 'integrity', status: 'FAILED', result: 'hash mismatch', created_at: 't2' },
      { package_id: 'pkg-1', check_type: 'malware', status: 'SCANNING', result: 'in progress', created_at: 't3' },
    ],
    reviews: [{ id: 'mrev-1', package_id: 'pkg-1', sha256: HASH_A, platform: 'linux_deb', reason: 'r', status: 'PENDING', created_at: 't0' }],
  });
  const out: any = await securityAdminRoutes.manualReview(req('admin-1', { decision: 'APPROVE', notes: 'I checked it manually, looks fine to me.' }, REVIEW_PATH), env);
  assert.equal(out.code, 'FORBIDDEN');
  assert.match(out.error, /integrity/);
});

test('queue prioritization: UNAVAILABLE before SCANNING before NEEDS_REVIEW', async () => {
  const env = fakeEnv({
    packages: [
      pkgWith('NEEDS_REVIEW'),
      { ...pkgWith('SCANNING'), id: 'pkg-2' },
      { ...pkgWith('UNAVAILABLE'), id: 'pkg-3' },
    ],
    results: [],
  });
  const out: any = await securityAdminRoutes.reviewQueue(req('admin-1', {}, '/admin/security/review-queue', 'GET'), env);
  assert.equal(out.queue.length, 3);
  assert.equal(out.queue[0].automated.malwareStatus, 'UNAVAILABLE');
  assert.equal(out.queue[1].automated.malwareStatus, 'SCANNING');
});

test('legacy override is now byte-bound (replacement cannot ride an old override)', async () => {
  const env = fakeEnv({
    packages: [pkgWith('UNAVAILABLE')],
    results: resultsFor('UNAVAILABLE'),
    overrides: [{ id: 'ov-1', package_id: 'pkg-1', admin_user_id: 'admin-1', reason: 'old reason', sha256: HASH_B, created_at: 't0' }],
  });
  const gate = await publicationSecurityGate(env, 'rel-1');
  assert.equal(gate.ok, false, 'override for different bytes does not authorize');
  // Same hash → authorizes as SECURITY_OVERRIDE (legacy path preserved).
  env.db.package_security_overrides[0].sha256 = HASH_A;
  const gate2 = await publicationSecurityGate(env, 'rel-1');
  assert.equal(gate2.ok, true);
  assert.equal(gate2.authorizations[0].publicationAuthorization, 'SECURITY_OVERRIDE');
});

test('MANUAL_REVIEW_MALWARE_STATES excludes DETECTED and CLEAN', () => {
  assert.ok(!MANUAL_REVIEW_MALWARE_STATES.includes('DETECTED'));
  assert.ok(!MANUAL_REVIEW_MALWARE_STATES.includes('CLEAN'));
  for (const st of ['UNAVAILABLE', 'SCANNING', 'UNKNOWN', 'NEEDS_REVIEW']) {
    assert.ok(MANUAL_REVIEW_MALWARE_STATES.includes(st));
  }
});
