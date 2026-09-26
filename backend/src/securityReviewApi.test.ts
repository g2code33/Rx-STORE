/**
 * Security Review authorization hardening tests — verifies the backend
 * cannot be bypassed through direct API requests (the UI is never the
 * enforcement).
 *
 * Run: node --experimental-strip-types --test backend/src/securityReviewApi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { securityAdminRoutes } from './routes/securityAdmin.ts';
import { publicationSecurityGate } from './services/packageSecurity.ts';

const HASH = 'a'.repeat(64);

function fakeEnv() {
  const db: any = {
    packages: [{
      id: 'pkg-1', application_id: 'app-1', release_id: 'rel-1', platform: 'linux_deb', architecture: 'x64',
      filename: 'f.deb', storage_key: 'k', quarantine_key: 'k', file_size: 1, mime_type: 'm', sha256: HASH,
      version: '1', package_type: 'installer', status: 'stored', security_state: 'MALWARE_SCAN',
      overall_security: 'NEEDS_REVIEW', security_scan_status: 'UNAVAILABLE', signature_status: 'UNSIGNED',
      developer_id: 'dev-1', deployment_url: null, created_at: '2026-09-26 00:00:00',
    }],
    package_security_results: [
      { package_id: 'pkg-1', check_type: 'integrity', status: 'PASSED', result: 'ok', created_at: 't1' },
      { package_id: 'pkg-1', check_type: 'malware', status: 'UNAVAILABLE', result: 'scanner unreachable', created_at: 't2' },
    ],
    package_manual_reviews: [
      { id: 'mrev-1', package_id: 'pkg-1', release_id: 'rel-1', sha256: HASH, platform: 'linux_deb',
        automated_integrity: 'PASSED', automated_malware: 'UNAVAILABLE', automated_overall: 'NEEDS_REVIEW',
        reason: 'scanner unreachable', status: 'PENDING', created_at: 't0' },
    ],
    package_security_overrides: [],
    audit_logs: [],
    users: [
      { id: 'admin-1', role: 'admin', name: 'Admin' },
      { id: 'dev-user', role: 'developer', name: 'Dev' },
      { id: 'normie', role: 'user', name: 'User' },
    ],
    releases: [{ id: 'rel-1', application_id: 'app-1', version: '1.0', status: 'approved', developer_id: 'dev-1' }],
    applications: [{ id: 'app-1', name: 'App', slug: 'app' }],
    developer_members: [],
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
          if (s.includes("SELECT * FROM package_manual_reviews WHERE package_id=? AND status='PENDING'")) {
            return db.package_manual_reviews.filter((r: any) => r.package_id === a[0] && r.status === 'PENDING' && !r.invalidated_at)[0] || null;
          }
          if (s.includes("SELECT * FROM package_manual_reviews WHERE package_id=? AND status='APPROVED'")) {
            return db.package_manual_reviews.filter((r: any) => r.package_id === a[0] && r.status === 'APPROVED' && !r.invalidated_at)[0] || null;
          }
          if (s.includes('SELECT status FROM package_security_results WHERE package_id=? AND check_type=?')) {
            const rows = db.package_security_results.filter((r: any) => r.package_id === a[0] && r.check_type === a[1]);
            return rows.length ? { status: rows[rows.length - 1].status } : null;
          }
          if (s.includes('FROM package_security_overrides WHERE package_id=?')) return null;
          return null;
        },
        async all() {
          const s = sql.replace(/\s+/g, ' ');
          const a = self._b;
          if (s.includes('FROM packages WHERE release_id=?')) return { results: db.packages.filter((p: any) => p.release_id === a[0]) };
          if (s.includes('FROM package_security_results WHERE package_id=? AND id IN')) return { results: db.package_security_results.filter((r: any) => r.package_id === a[0] && ['NEEDS_REVIEW', 'UNAVAILABLE'].includes(r.status)) };
          return { results: [] };
        },
        async run() {
          const s = sql.replace(/\s+/g, ' ');
          const a = self._b;
          if (s.includes('INSERT INTO audit_logs')) { db.audit_logs.push({ id: a[0], action: a[1] }); return { meta: { changes: 1 } }; }
          if (s.includes('UPDATE package_manual_reviews SET status=?')) {
            const r = db.package_manual_reviews.find((x: any) => x.id === a[4]);
            if (r) { r.status = a[0]; r.admin_user_id = a[1]; r.admin_notes = a[2]; r.reviewed_at = 'now'; r.audit_event_id = a[3]; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  return { DB, db };
}

const req = (userId: string | null, body: any) => {
  const r = new Request('https://api.test/admin/security/packages/pkg-1/manual-review', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (userId) (r as any).user = { userId };
  return r;
};

test('direct API as a NON-ADMIN (user role) is refused even with a valid session shape', async () => {
  const env = fakeEnv();
  const out: any = await securityAdminRoutes.manualReview(req('normie', { decision: 'APPROVE', notes: 'I am definitely an admin, trust me.' }), env);
  assert.equal(out.code, 'FORBIDDEN');
  assert.equal(env.db.package_manual_reviews[0].status, 'PENDING');
});

test('direct API as a DEVELOPER is refused (role check, not just JWT gate)', async () => {
  const env = fakeEnv();
  const out: any = await securityAdminRoutes.manualReview(req('dev-user', { decision: 'APPROVE', notes: 'It is my own package, approve it.' }), env);
  assert.equal(out.code, 'FORBIDDEN');
});

test('direct API with NO identity at all is refused', async () => {
  const env = fakeEnv();
  const out: any = await securityAdminRoutes.manualReview(req(null, { decision: 'APPROVE', notes: 'anonymous approval' }), env);
  assert.equal(out.code, 'UNAUTHORIZED');
});

test('direct API with a spoofed admin id that does not exist is refused', async () => {
  const env = fakeEnv();
  const out: any = await securityAdminRoutes.manualReview(req('ghost-admin', { decision: 'APPROVE', notes: 'spoofed identity' }), env);
  assert.equal(out.code, 'FORBIDDEN');
});

test('decision payload tampering: invalid decision values are refused', async () => {
  const env = fakeEnv();
  const out: any = await securityAdminRoutes.manualReview(req('admin-1', { decision: 'PUBLISH', notes: 'just publish it' }), env);
  assert.equal(out.code, 'VALIDATION_ERROR');
  const out2: any = await securityAdminRoutes.manualReview(req('admin-1', { decision: 'CLEAN', notes: 'mark it clean' }), env);
  assert.equal(out2.code, 'VALIDATION_ERROR');
});

test('empty-notes approval is refused via direct API (no UI-required field can be skipped)', async () => {
  const env = fakeEnv();
  const out: any = await securityAdminRoutes.manualReview(req('admin-1', { decision: 'APPROVE', notes: '' }), env);
  assert.equal(out.code, 'VALIDATION_ERROR');
  const out2: any = await securityAdminRoutes.manualReview(req('admin-1', { decision: 'APPROVE' }), env);
  assert.equal(out2.code, 'VALIDATION_ERROR');
});

test('the gate stays closed for a package with a PENDING review (no decision = no publication)', async () => {
  const env = fakeEnv();
  const gate = await publicationSecurityGate(env, 'rel-1');
  assert.equal(gate.ok, false);
});

test('genuine admin approval still works through the direct API path', async () => {
  const env = fakeEnv();
  const out: any = await securityAdminRoutes.manualReview(req('admin-1', { decision: 'APPROVE', notes: 'Verified independently against the vendor release.' }), env);
  assert.ok(out.success);
  assert.equal(out.publicationAuthorization, 'MANUAL_APPROVAL');
  const gate = await publicationSecurityGate(env, 'rel-1');
  assert.equal(gate.ok, true);
  assert.equal(gate.authorizations[0].publicationAuthorization, 'MANUAL_APPROVAL');
  // The automated verdict was NOT converted to CLEAN anywhere.
  assert.equal(env.db.packages[0].security_scan_status, 'UNAVAILABLE');
});
