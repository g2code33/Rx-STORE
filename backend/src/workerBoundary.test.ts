/**
 * Worker-level CORS/error-boundary tests — the production 503-without-CORS
 * failure mode. Drives the REAL Worker fetch handler (default export of
 * backend/src/index.ts) with fake bindings, verifying:
 *   - OPTIONS preflight for the publish route succeeds with CORS
 *   - an internal failure (throwing DB) becomes 500 JSON WITH CORS + request id
 *   - the publish route's own failures stay structured + CORS-enabled
 *   - a security-blocked publish stays a structured 400 (never 200)
 *   - an unauthorized origin is NOT granted CORS
 *
 * Run: node --experimental-strip-types --test backend/src/workerBoundary.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import worker from './index.ts';
import { generateToken } from './services/auth.ts';

const ORIGIN = 'https://rx-store-web.pages.dev';
const EVIL = 'https://evil.example';
const JWT = 'test-jwt-secret-for-boundary';

let adminToken: string;
beforeEach(async () => {
  adminToken = await generateToken({ userId: 'admin-1', role: 'admin' }, JWT);
});

/** Bindings whose DB throws on EVERY query — forces internal failures. */
function throwingEnv(msg = 'D1 exploded') {
  return {
    DB: { prepare() { throw new Error(msg); } },
    STORAGE: { async get() { throw new Error('R2 exploded'); }, async head() { throw new Error('R2 exploded'); } },
    CACHE: { async get() { return null; }, async put() {} },
    JWT_SECRET: JWT,
    ENVIRONMENT: 'production',
    CORS_ALLOWED_ORIGINS: 'https://rx-store-web.pages.dev',
  };
}

/** Bindings with an in-memory DB for the publish flow. */
function publishEnv(seed: { releases?: any[]; packages?: any[] } = {}) {
  const db: any = {
    users: [{ id: 'admin-1', role: 'admin', password_hash: 'x', name: 'Admin', email: 'a@x.com' }],
    releases: seed.releases || [],
    packages: seed.packages || [],
    site_settings: [], notifications: [], audit_logs: [], package_security_results: [],
    package_manual_reviews: [], package_security_overrides: [], scanner_cache: [],
    applications: [{ id: 'app-1', slug: 'clinical-rx', name: 'Clinical Rx', platforms: '["linux"]', status: 'active' }],
    downloads: [], app_versions: [], devices: [], app_installations: [], developer_members: [],
  };
  const DB = {
    prepare(sql: string) {
      const self: any = {
        _b: [] as any[],
        bind(...a: any[]) { self._b = a; return self; },
        async first() {
          const s = sql.replace(/\s+/g, ' ');
          const a = self._b;
          if (s.includes('SELECT password_hash FROM users')) return db.users.find((u: any) => u.id === a[0]) || null;
          if (s.includes('FROM releases WHERE id=?')) return db.releases.find((r: any) => r.id === a[0]) || null;
          if (s.includes('SELECT * FROM packages WHERE id=?')) return db.packages.find((p: any) => p.id === a[0]) || null;
          if (s.includes("status='APPROVED' AND invalidated_at IS NULL")) return null;
          if (s.includes('SELECT status FROM package_security_results WHERE package_id=? AND check_type=?')) {
            const rows = db.package_security_results.filter((r: any) => r.package_id === a[0] && r.check_type === a[1]);
            return rows.length ? { status: rows[rows.length - 1].status } : null;
          }
          if (s.includes('FROM package_security_overrides WHERE package_id=?')) return null;
          if (s.includes('SELECT id FROM package_manual_reviews WHERE package_id=? AND sha256=?')) return null;
          if (s.includes('SELECT slug, name FROM applications WHERE id=?')) return db.applications[0];
          return null;
        },
        async all() {
          const s = sql.replace(/\s+/g, ' ');
          const a = self._b;
          if (s.includes('FROM packages WHERE release_id=?')) return { results: db.packages.filter((p: any) => p.release_id === a[0]) };
          if (s.includes('FROM packages p') || s.includes('SELECT p.id AS package_id')) return { results: [] };
          if (s.includes('FROM package_security_results WHERE package_id=? AND id IN')) return { results: [] };
          if (s.includes('SELECT key, value FROM site_settings')) return { results: [] };
          if (s.includes('FROM downloads WHERE app_id=?')) return { results: [] };
          return { results: [] };
        },
        async run() {
          const s = sql.replace(/\s+/g, ' ');
          const a = self._b;
          if (s.includes('INSERT INTO audit_logs') || s.includes('INSERT INTO notifications')) return { meta: { changes: 1 } };
          if (s.includes('INSERT INTO package_security_results')) { db.package_security_results.push({ package_id: a[1], check_type: a[5], status: a[6] }); return { meta: { changes: 1 } }; }
          if (s.includes('UPDATE packages')) {
            for (const p of db.packages) {
              const m = s.match(/security_state='([A-Z_]+)'/); if (m) p.security_state = m[1];
              const m2 = s.match(/overall_security='([A-Z_]+)'/); if (m2) p.overall_security = m2[1];
              const m3 = s.match(/security_scan_status='(\w+)'/); if (m3) p.security_scan_status = m3[1];
              if (s.includes('status=?') && s.includes('WHERE release_id=?')) p.status = a[0];
            }
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE releases')) { const r = db.releases.find((x: any) => x.id === a[a.length - 1]); if (r) { r.status = 'published'; r.published_at = 'now'; } return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  return {
    DB, __db: db,
    STORAGE: {
      async get(key: string) {
        const blob = db.__r2?.[key];
        if (!blob) return null;
        const copy = blob.slice();
        return { size: blob.length, body: new Response(copy).body, arrayBuffer: async () => copy.slice().buffer };
      },
      async head(key: string) { const b = db.__r2?.[key]; return b ? { size: b.length } : null; },
      async put(key: string, v: Uint8Array) { (db.__r2 = db.__r2 || {})[key] = v; },
    },
    CACHE: { async get() { return null; }, async put() {} },
    JWT_SECRET: JWT,
    ENVIRONMENT: 'production',
    CORS_ALLOWED_ORIGINS: 'https://rx-store-web.pages.dev',
    MALWARE_SCANNER: '', // no scanner: pipeline malware = UNAVAILABLE (blocked, honest)
  };
}

function req(method: string, path: string, token?: string, origin = ORIGIN, body?: any) {
  return new Request(`https://rx-store-api.calcitoninpay.workers.dev${path}`, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'Access-Control-Request-Method': method,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const PUBLISH = '/v1/admin/releases/rel-1/publish';

// ---------------------------------------------------------------------------
// A/F. OPTIONS preflight for the publish route from the production origin
// ---------------------------------------------------------------------------

test('OPTIONS preflight for /publish succeeds with CORS for the production origin', async () => {
  // A real browser preflight is an OPTIONS request.
  const res = await worker.fetch(req('OPTIONS', PUBLISH, adminToken) as any, throwingEnv() as any);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.ok((res.headers.get('Access-Control-Allow-Methods') || '').includes('POST'));
});

// ---------------------------------------------------------------------------
// D/E. Internal failure → structured 500 JSON WITH CORS + request id
// ---------------------------------------------------------------------------

test('an internal DB failure becomes 500 JSON WITH CORS + X-Request-Id (never an opaque error page)', async () => {
  // getRelease has an uncaught query → escapes the route → the TOP-LEVEL
  // boundary catches it: structured JSON, CORS, request id.
  const res = await worker.fetch(req('GET', '/v1/admin/releases/rel-1', adminToken) as any, throwingEnv('TypeError: x is not a function') as any);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'CORS present on the 500');
  assert.ok(res.headers.get('X-Request-Id'), 'request id present');
  const j: any = await res.json();
  assert.equal(j.success, false);
  assert.equal(j.error.code, 'INTERNAL');
  assert.ok(j.error.requestId);
});

test('the publish route converts its own internal failures into structured 500s with CORS', async () => {
  // The publish dispatch's try/catch: release lookup throws → 500 JSON + CORS.
  const res = await worker.fetch(req('POST', PUBLISH, adminToken) as any, throwingEnv('TypeError: x is not a function') as any);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const j: any = await res.json();
  assert.equal(j.error.code, 'INTERNAL');
  assert.match(j.error.message, /request id/);
});

// ---------------------------------------------------------------------------
// B. Security-blocked publish stays a STRUCTURED 400 (never 200, never opaque)
// ---------------------------------------------------------------------------

test('a security-blocked publish returns a structured 400 with the real blockers + CORS', async () => {
  const env = publishEnv({
    releases: [{ id: 'rel-1', application_id: 'app-1', version: '1.11.11', channel: 'stable', status: 'approved', developer_id: null }],
    packages: [{
      id: 'pkg-1', release_id: 'rel-1', application_id: 'app-1', platform: 'linux_deb', architecture: 'x64',
      filename: 'clinical-rx_1.11.11_amd64.deb', storage_key: 'quarantine/k', quarantine_key: 'quarantine/k',
      file_size: 8, sha256: 'a'.repeat(64), version: '1.11.11', package_type: 'installer', status: 'stored',
      security_state: 'MALWARE_SCAN', overall_security: 'NEEDS_REVIEW', security_scan_status: 'pending',
      signature_status: 'pending', developer_id: null, deployment_url: null,
    }],
  });
  const res = await worker.fetch(req('POST', PUBLISH, adminToken) as any, env as any);
  assert.equal(res.status, 400, 'blocked publication is a 400 — never a 200 and never opaque');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const j: any = await res.json();
  assert.equal(j.success, false);
  assert.match(j.error.message, /Security verification blocked publication/);
  assert.match(j.error.message, /clinical-rx_1.11.11_amd64\.deb/);
});

// ---------------------------------------------------------------------------
// G. Unauthorized origin is NOT granted CORS
// ---------------------------------------------------------------------------

test('an unauthorized origin receives no Access-Control-Allow-Origin', async () => {
  const res = await worker.fetch(req('GET', '/v1/admin/releases/rel-1', adminToken, EVIL) as any, publishEnv() as any);
  assert.notEqual(res.headers.get('Access-Control-Allow-Origin'), EVIL);
  // And the OPTIONS preflight for the evil origin is also refused.
  const pre = await worker.fetch(req('OPTIONS', PUBLISH, adminToken, EVIL) as any, publishEnv() as any);
  assert.notEqual(pre.headers.get('Access-Control-Allow-Origin'), EVIL);
});

// ---------------------------------------------------------------------------
// Sanity: /health responds (worker boots with the normalized imports)
// ---------------------------------------------------------------------------

test('the Worker boots and /health responds with CORS', async () => {
  const res = await worker.fetch(new Request('https://rx-store-api.calcitoninpay.workers.dev/v1/health', { headers: { Origin: ORIGIN } }) as any, publishEnv() as any);
  assert.ok(res.status === 200 || res.status === 503, `health responded ${res.status}`);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

// ---------------------------------------------------------------------------
// D. Transient infrastructure failure → 503 JSON + CORS (spec §12D)
// ---------------------------------------------------------------------------

test('a transient (D1/network) failure becomes 503 SERVICE_UNAVAILABLE JSON WITH CORS + request id', async () => {
  const res = await worker.fetch(req('POST', PUBLISH, adminToken) as any, throwingEnv('D1 exploded') as any);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'CORS present on the 503');
  assert.ok(res.headers.get('X-Request-Id'));
  const j: any = await res.json();
  assert.equal(j.error.code, 'SERVICE_UNAVAILABLE');
  assert.match(j.error.message, /temporary/);
  assert.ok(j.error.requestId);
});

// ---------------------------------------------------------------------------
// E. Non-transient internal failure → 500 JSON + CORS (spec §12E)
// ---------------------------------------------------------------------------

test('a non-transient internal failure becomes 500 INTERNAL JSON WITH CORS', async () => {
  const res = await worker.fetch(req('POST', PUBLISH, adminToken) as any, throwingEnv('TypeError: undefined is not a function') as any);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const j: any = await res.json();
  assert.equal(j.error.code, 'INTERNAL');
});

// ---------------------------------------------------------------------------
// §7. /health exposes runtime version metadata (no secrets)
// ---------------------------------------------------------------------------

test('/health exposes service, environment and securityPipelineVersion', async () => {
  const res = await worker.fetch(new Request('https://rx-store-api.calcitoninpay.workers.dev/v1/health', { headers: { Origin: ORIGIN } }) as any, publishEnv() as any);
  const j: any = await res.json();
  assert.equal(j.service, 'rx-store-api');
  assert.equal(j.environment, 'production');
  assert.match(j.securityPipelineVersion, /^\d{4}-\d{2}-\d{2}\./);
  assert.ok(!JSON.stringify(j).includes('JWT'), 'no secrets in health output');
});
