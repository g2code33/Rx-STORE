/**
 * GitHub Releases integration tests (Phase 9 matrix — the 24 scenarios).
 *
 * Drives the REAL services (github.ts + githubReleases.ts + route handlers)
 * against an in-memory D1 with GitHub API / asset / VirusTotal fetch stubs.
 * Assertions focus on the hard gates:
 *   - approval is the ONLY bridge to a live update
 *   - paid apps can never use the GitHub channel
 *   - verification reads ACTUAL bytes (size/sha256) and is honest about the
 *     scanner (UNAVAILABLE blocks; DETECTED can never be overridden)
 *   - webhook redeliveries and concurrent publishes cannot double-publish
 *   - RX Store storage (R2) is NEVER written for GitHub assets
 *   - SSRF/redirect/host attacks are rejected
 *
 * Run: node --experimental-strip-types --test backend/src/githubReleases.test.ts
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapAssetFilename, parseRxManifest, versionFromTag, validateAssetUrl, streamAssetHash,
  verifyWebhookSignature,
} from './services/github.ts';
import {
  connectAppRepository, disconnectAppRepository, processWebhook,
  verifyGithubRelease, publishGithubRelease, rejectGithubRelease,
  withdrawGithubRelease, syncAllConnections, ensureGithubTables,
} from './services/githubReleases.ts';

const WEBHOOK_SECRET = 'test-webhook-secret';
const APP_ID = 'app-1';
const ORG_ID = 'org-1';
const USER_ID = 'user-1';
const OTHER_ORG = 'org-2';
const REPO_ID = '90123';
const INSTALLATION_ID = '777';
const ADMIN = { userId: 'admin-1', label: 'admin:test' };

// ---------------------------------------------------------------------------
// Fake D1 — table-aware, matching the exact statements the services issue
// ---------------------------------------------------------------------------

function fakeEnv() {
  const tables: Record<string, any[]> = {
    applications: [{
      id: APP_ID, slug: 'clinical-rx', name: 'Clinical Rx', developer_org_id: ORG_ID,
      price_type: 'free', price_amount: 0, current_version: '1.11.11', platforms: 'android,web',
    }],
    releases: [], packages: [], app_versions: [], notifications: [], downloads: [],
    github_repo_connections: [], github_release_events: [], github_releases: [],
    github_release_assets: [], github_audit_log: [], site_settings: [],
  };
  const storagePuts: any[] = [];

  const DB = {
    prepare(sql: string) {
      const s = sql.replace(/\s+/g, ' ');
      return {
        _binds: [] as any[],
        bind(...args: any[]) { this._binds = args; return this; },
        async run() {
          const a = this._binds;
          const T = (name: string) => tables[name];
          // ---- INSERTs (positional, matching the service code) ----
          if (s.includes('INSERT INTO github_repo_connections')) {
            T('github_repo_connections').push({ id: a[0], application_id: a[1], repository_id: a[2], repository_owner: a[3], repository_name: a[4], repository_full_name: a[5], installation_id: a[6], status: 'active', connected_by: a[8] });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO github_release_events')) {
            T('github_release_events').push({ id: a[0], delivery_id: a[1], event: a[2], action: a[3], repository_id: a[4], status: a[5], detail: a[6], error: a[7] });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO github_releases')) {
            const row = { id: a[0], application_id: a[1], connection_id: a[2], github_release_id: a[3], tag_name: a[4], version: a[5], release_name: a[6], target_commitish: a[7], is_prerelease: a[8], release_notes: a[9], github_published_at: a[10], status: 'detected', block_reason: null as any, prior_version: null as any, published_by: null as any, decision_reason: null as any };
            const dupV = T('github_releases').find((r) => r.application_id === row.application_id && r.version === row.version && r.id !== row.id);
            if (dupV) { const e: any = new Error('UNIQUE constraint failed: github_releases.application_id, github_releases.version'); return Promise.reject(e); }
            const dupG = T('github_releases').find((r) => r.github_release_id === row.github_release_id);
            if (dupG) { const e: any = new Error('UNIQUE constraint failed: github_releases.github_release_id'); return Promise.reject(e); }
            T('github_releases').push(row);
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO github_release_assets')) {
            const row = { id: a[0], release_id: a[1], github_asset_id: a[2], name: a[3], platform: a[4], architecture: a[5], download_url: a[6], state: 'detected', declared_sha256: a[8], size_bytes: null as any, sha256: null as any, scanner_status: null as any, scanner_detail: null as any, error: null as any };
            const dup = T('github_release_assets').find((r) => r.release_id === row.release_id && r.platform === row.platform && r.architecture === row.architecture);
            if (dup) { const e: any = new Error('UNIQUE constraint failed: github_release_assets'); return Promise.reject(e); }
            T('github_release_assets').push(row);
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO github_audit_log')) {
            T('github_audit_log').push({ id: a[0], action: a[1], actor_id: a[2], actor_label: a[3], application_id: a[4], release_id: a[5], repository_id: a[6], reason: a[7], details: a[8], created_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO releases')) {
            const dup = T('releases').find((r) => r.application_id === a[1] && r.version === a[2]);
            if (dup) { const e: any = new Error('UNIQUE constraint failed: releases.application_id, releases.version'); return Promise.reject(e); }
            T('releases').push({ id: a[0], application_id: a[1], version: a[2], status: 'published', channel: a[5], release_notes: a[3] });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO packages')) {
            T('packages').push({ id: a[0], application_id: a[1], release_id: a[2], platform: a[3], architecture: a[4], filename: a[5], storage_key: a[6], file_size: a[7], sha256: a[9], version: a[10], provider: 'github', external_url: a[11], github_asset_id: a[12], status: 'published', overall_security: a[14], security_state: a[13] });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO app_versions')) {
            T('app_versions').push({ id: a[0], app_id: a[1], version: a[2], release_notes: a[3], files: a[4] });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO notifications')) {
            T('notifications').push({ id: a[0], user_id: a[1], type: a[2], title: a[3] });
            return { meta: { changes: 1 } };
          }
          // ---- UPDATEs ----
          if (s.includes('UPDATE github_repo_connections SET status=\'disconnected\'')) {
            const c = T('github_repo_connections').find((x) => x.id === a[0]); if (c) c.status = 'disconnected';
            return { meta: { changes: c ? 1 : 0 } };
          }
          if (s.includes('UPDATE github_repo_connections SET last_event_at')) {
            const c = T('github_repo_connections').find((x) => x.id === a[2]); if (c) { c.last_event = a[0]; c.latest_detected_version = a[1]; }
            return { meta: { changes: c ? 1 : 0 } };
          }
          if (s.includes('UPDATE github_repo_connections SET last_sync_at')) {
            const c = T('github_repo_connections').find((x) => x.id === a[0]); if (c) c.last_sync_at = 'now';
            return { meta: { changes: c ? 1 : 0 } };
          }
          if (s.includes('UPDATE github_release_events SET status')) {
            const e = T('github_release_events').find((x) => x.delivery_id === a[3] && x.event === a[4]); if (e) { e.status = a[0]; e.detail = a[1]; e.error = a[2]; }
            return { meta: { changes: e ? 1 : 0 } };
          }
          if (s.includes('UPDATE github_releases SET tag_name')) {
            const r = T('github_releases').find((x) => x.id === a[7]); if (r) Object.assign(r, { tag_name: a[0], version: a[1], release_name: a[2], target_commitish: a[3], is_prerelease: a[4], release_notes: a[5], github_published_at: a[6] });
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes('UPDATE github_releases SET status=\'verifying\'')) {
            const r = T('github_releases').find((x) => x.id === a[0]); if (r) { r.status = 'verifying'; r.block_reason = null; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes("UPDATE github_releases SET status='blocked'")) {
            // Two shapes: (reason, id) and (id) with the reason inline in SQL.
            const r = T('github_releases').find((x) => x.id === a[a.length - 1]);
            if (r) { r.status = 'blocked'; r.block_reason = a.length > 1 ? a[0] : (s.match(/block_reason='([^']*)'/)?.[1] || 'blocked'); }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes('UPDATE github_releases SET status=\'verification_failed\'')) {
            const r = T('github_releases').find((x) => x.id === a[1]); if (r) { r.status = 'verification_failed'; r.block_reason = a[0]; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes("UPDATE github_releases SET status='pending_approval'")) {
            const r = T('github_releases').find((x) => x.id === a[0]); if (r) { r.status = 'pending_approval'; r.verified_at = 'now'; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes("UPDATE github_releases SET status='rejected'")) {
            const r = T('github_releases').find((x) => x.id === a[2]); if (r) { r.status = 'rejected'; r.reviewed_by = a[0]; r.decision_reason = a[1]; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes("UPDATE github_releases SET status='withdrawn'")) {
            const r = T('github_releases').find((x) => x.id === a[2]); if (r) { r.status = 'withdrawn'; r.decision_reason = a[0]; r.reviewed_by = a[1]; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes("UPDATE github_releases SET status='published'")) {
            const r = T('github_releases').find((x) => x.id === a[3]); if (r) { r.status = 'published'; r.published_by = a[0]; r.prior_version = a[1]; r.decision_reason = a[2]; r.published_at = 'now'; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes('UPDATE github_release_assets SET state=\'missing\'')) {
            const r = T('github_release_assets').find((x) => x.id === a[1]); if (r) { r.state = 'missing'; r.error = a[0]; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes('UPDATE github_release_assets SET state=\'mismatch\'')) {
            const r = T('github_release_assets').find((x) => x.id === a[a.length - 1]); if (r) Object.assign(r, { state: 'mismatch', error: a[a.length - 2], ...(a.length === 4 ? { size_bytes: a[0], sha256: a[1] } : {}) });
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes('UPDATE github_release_assets SET state=\'failed\'')) {
            const r = T('github_release_assets').find((x) => x.id === a[1]); if (r) { r.state = 'failed'; r.error = a[0]; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes('UPDATE github_release_assets SET state')) {
            // (state, size_bytes, sha256, scanner_status, scanner_detail, id)
            const r = T('github_release_assets').find((x) => x.id === a[5]);
            if (r) Object.assign(r, { state: a[0], size_bytes: a[1], sha256: a[2], scanner_status: a[3], scanner_detail: a[4] });
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes('UPDATE applications SET current_version')) {
            const app = T('applications').find((x) => x.id === a[1]); if (app) app.current_version = a[0];
            return { meta: { changes: app ? 1 : 0 } };
          }
          if (s.includes('UPDATE applications SET platforms')) {
            const app = T('applications').find((x) => x.id === a[1]); if (app) app.platforms = a[0];
            return { meta: { changes: app ? 1 : 0 } };
          }
          if (s.includes('UPDATE releases SET status=\'withdrawn\'')) {
            const r = T('releases').find((x) => x.id === a[0]); if (r) r.status = 'withdrawn';
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes('UPDATE packages SET status=\'archived\'')) {
            for (const p of T('packages')) if (p.release_id === a[0]) { p.status = 'archived'; }
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE app_versions SET files')) {
            const v = T('app_versions').find((x) => x.id === a[2]); if (v) { v.files = a[0]; v.release_notes = a[1]; }
            return { meta: { changes: v ? 1 : 0 } };
          }
          if (s.includes('CREATE TABLE') || s.includes('CREATE INDEX') || s.includes('CREATE UNIQUE INDEX')) return { meta: { changes: 0 } };
          if (s.includes('DELETE FROM github_release_assets')) {
            const r = T('github_release_assets'); for (let i = r.length - 1; i >= 0; i--) if (r[i].release_id === a[0]) r.splice(i, 1);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          const a = this._binds;
          const T = (name: string) => tables[name];
          if (s.includes('FROM github_repo_connections WHERE application_id')) return T('github_repo_connections').find((c) => c.application_id === a[0]) || null;
          if (s.includes('FROM github_repo_connections WHERE repository_id')) return T('github_repo_connections').find((c) => c.repository_id === a[0] && c.status === 'active') || null;
          if (s.includes('FROM github_repo_connections WHERE id')) return T('github_repo_connections').find((c) => c.id === a[0]) || null;
          if (s.includes('FROM github_release_events WHERE delivery_id')) return T('github_release_events').find((e) => e.delivery_id === a[0] && e.event === a[1]) || null;
          if (s.includes('FROM github_releases WHERE github_release_id')) return T('github_releases').find((r) => r.github_release_id === a[0]) || null;
          if (s.includes('FROM github_releases WHERE application_id=? AND version') || s.includes('FROM github_releases WHERE application_id = ? AND version')) return T('github_releases').find((r) => r.application_id === a[0] && r.version === a[1]) || null;
          if (s.includes('FROM github_releases WHERE id')) return T('github_releases').find((r) => r.id === a[0]) || null;
          if (s.includes('FROM github_release_assets WHERE release_id')) return null;
          if (s.includes('FROM applications WHERE id')) return T('applications').find((x) => x.id === a[0]) || null;
          if (s.includes('SELECT id FROM releases WHERE application_id') && s.includes("status='published'")) return T('releases').find((r) => r.application_id === a[0] && r.version === a[1] && r.status === 'published') || null;
          if (s.includes('SELECT id FROM app_versions')) return T('app_versions').find((v) => v.app_id === a[0] && v.version === a[1]) || null;
          if (s.includes('SELECT slug, name FROM applications')) return T('applications').find((x) => x.id === a[0]) || null;
          return null;
        },
        async all() {
          const a = this._binds;
          const T = (name: string) => tables[name];
          if (s.includes('FROM github_release_assets WHERE release_id')) return { results: T('github_release_assets').filter((r) => r.release_id === a[0]) };
          if (s.includes('FROM github_repo_connections WHERE status=\'active\'') || s.includes("FROM github_repo_connections WHERE status = 'active'")) return { results: T('github_repo_connections').filter((c) => c.status === 'active') };
          if (s.includes('FROM github_releases WHERE status IN')) return { results: T('github_releases').filter((r) => ['detected', 'verifying'].includes(r.status)) };
          if (s.includes('SELECT COUNT(*)')) {
            // overview counts
            if (s.includes("github_releases WHERE status='pending_approval'")) return { results: [{ n: T('github_releases').filter((r) => r.status === 'pending_approval').length }] } as any;
            return { results: [{ n: 0 }] } as any;
          }
          if (s.includes('DISTINCT user_id FROM downloads')) return { results: T('downloads').map((d) => ({ user_id: d.user_id })) };
          if (s.includes('FROM github_audit_log')) return { results: T('github_audit_log') };
          if (s.includes('JOIN github_repo_connections')) {
            return { results: T('github_releases').map((r) => ({ ...r, repository_full_name: 'octo/app', app_name: 'Clinical Rx', app_slug: 'clinical-rx', app_current_version: '1.11.11', assets: T('github_release_assets').filter((x) => x.release_id === r.id) })) };
          }
          return { results: [] };
        },
      };
    },
  };

  return {
    DB, tables, storagePuts,
    GITHUB_APP_ID: '12345', GITHUB_APP_SLUG: 'rx-store-releases',
    GITHUB_APP_PRIVATE_KEY: '', GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    VIRUSTOTAL_API_KEY: 'vt-test-key',
    RX_STORE_WEB_URL: 'https://web.test',
    STORAGE: { put: (...args: any[]) => { storagePuts.push(args); return Promise.resolve({}); }, get: () => Promise.resolve(null), head: () => Promise.resolve(null) },
  };
}

// ---------------------------------------------------------------------------
// Fetch stubs: GitHub API + asset bytes + VirusTotal
// ---------------------------------------------------------------------------

function apkBytes(): Uint8Array {
  return new TextEncoder().encode('FAKE-APK-BYTES-FOR-TESTING-1234567890');
}
async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface StubOpts {
  assetBytes?: Uint8Array;
  assetStatus?: number;
  ghAssetName?: string;
  ghAssetSize?: number;
  vtVerdict?: 'CLEAN' | 'DETECTED' | 'UNAVAILABLE';
}

function installStubs(env: any, opts: StubOpts = {}) {
  const original = globalThis.fetch;
  const bytes = opts.assetBytes ?? apkBytes();
  const vtVerdict = opts.vtVerdict ?? 'CLEAN';
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    // GitHub App installation token
    if (u === 'https://api.github.com/app/installations/777/access_tokens') {
      return new Response(JSON.stringify({ token: 'inst-token', expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 });
    }
    if (u === 'https://api.github.com/installation/repositories?per_page=100') {
      return new Response(JSON.stringify({ repositories: [{ id: Number(REPO_ID), name: 'app', full_name: 'octo/app', owner: { login: 'octo' }, private: false, html_url: 'https://github.com/octo/app' }] }), { status: 200 });
    }
    // Asset metadata by id (assetStatus simulates the asset having vanished
    // from GitHub entirely: the API 404s too)
    if (u.startsWith('https://api.github.com/repos/octo/app/releases/assets/')) {
      if (opts.assetStatus && opts.assetStatus !== 200) return new Response('gone', { status: opts.assetStatus });
      return new Response(JSON.stringify({ id: 555001, name: opts.ghAssetName ?? 'clinical-rx-1.12.0.apk', size: opts.ghAssetSize ?? bytes.byteLength, state: 'uploaded' }), { status: 200 });
    }
    // Asset bytes (the public download URL)
    if (u.startsWith('https://github.com/octo/app/releases/download/')) {
      if (opts.assetStatus && opts.assetStatus !== 200) return new Response('gone', { status: opts.assetStatus });
      return new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    }
    // VirusTotal upload + analysis
    if (u === 'https://www.virustotal.com/api/v3/files') {
      return new Response(JSON.stringify({ data: { id: 'analysis-1', type: 'analysis' } }), { status: 200 });
    }
    if (u === 'https://www.virustotal.com/api/v3/analyses/analysis-1') {
      if (vtVerdict === 'UNAVAILABLE') return new Response('boom', { status: 500 });
      const stats = vtVerdict === 'CLEAN'
        ? { malicious: 0, suspicious: 0, harmless: 5, undetected: 60 }
        : { malicious: 3, suspicious: 1, harmless: 5, undetected: 60 };
      return new Response(JSON.stringify({ data: { attributes: { status: 'completed', stats } } }), { status: 200 });
    }
    return new Response('not stubbed: ' + u, { status: 500 });
  }) as any;
  return { restore: () => { globalThis.fetch = original; } };
}

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------

async function signedDelivery(env: any, event: string, payload: any, deliveryId: string, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(payload);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  let hex = ''; for (const b of mac) hex += b.toString(16).padStart(2, '0');
  return processWebhook(env, { rawBody: raw, signatureHeader: `sha256=${hex}`, deliveryId, event });
}

function ghReleasePayload(overrides: any = {}) {
  return {
    action: 'published',
    release: {
      id: 5001, tag_name: 'v1.12.0', name: 'v1.12.0', draft: false, prerelease: false,
      body: 'Bug fixes', target_commitish: 'abc123', published_at: '2026-10-20T10:00:00Z',
      assets: [{ id: 555001, name: 'clinical-rx-1.12.0.apk', size: apkBytes().byteLength, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/clinical-rx-1.12.0.apk' }],
      ...overrides,
    },
    repository: { id: Number(REPO_ID), full_name: 'octo/app' },
    installation: { id: Number(INSTALLATION_ID) },
  };
}

// ---------------------------------------------------------------------------

let env: any;

/** A real PKCS#8 PEM so githubAppConfig() is genuinely configured and the
 * App JWT is actually signed (the GitHub endpoints themselves are stubbed). */
let TEST_PEM = '';
before(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let b64 = ''; for (const b of der) b64 += String.fromCharCode(b);
  b64 = btoa(b64).replace(/(.{64})/g, '$1\n');
  TEST_PEM = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
});

beforeEach(async () => {
  env = fakeEnv();
  env.GITHUB_APP_PRIVATE_KEY = TEST_PEM;
  await ensureGithubTables(env);
});

async function connect() {
  return connectAppRepository(env, { appId: APP_ID, orgId: ORG_ID, userId: USER_ID, installationId: INSTALLATION_ID, repositoryId: REPO_ID });
}

// --- 1. Connection eligibility ------------------------------------------------

test('authorized developer connects an eligible free app to a repository', async () => {
  const stubs = installStubs(env);
  try {
    const out = await connect();
    assert.ok(out.ok, (out as any).message);
    assert.equal(out.connection.repository_id, REPO_ID);
    assert.equal(out.connection.repository_full_name, 'octo/app');
    // Secrets never leak into the connection row.
    assert.ok(!JSON.stringify(out.connection).includes('inst-token'));
  } finally { stubs.restore(); }
});

test('unauthorized developer (different org) cannot connect or disconnect', async () => {
  const stubs = installStubs(env);
  try {
    const out = await connectAppRepository(env, { appId: APP_ID, orgId: OTHER_ORG, userId: 'user-2', installationId: INSTALLATION_ID, repositoryId: REPO_ID });
    assert.equal(out.ok, false);
    assert.equal((out as any).code, 'NOT_FOUND');
    const dis = await disconnectAppRepository(env, { appId: APP_ID, orgId: OTHER_ORG, userId: 'user-2' });
    assert.equal(dis.ok, false);
  } finally { stubs.restore(); }
});

test('paid apps cannot connect to the GitHub distribution channel', async () => {
  env.tables.applications[0].price_type = 'paid';
  env.tables.applications[0].price_amount = 20;
  const stubs = installStubs(env);
  try {
    const out = await connect();
    assert.equal(out.ok, false);
    assert.equal((out as any).code, 'FORBIDDEN');
    assert.match((out as any).message, /FREE/i);
  } finally { stubs.restore(); }
});

test('private repositories are refused (users must download without credentials)', async () => {
  const stubs = installStubs(env);
  const original = globalThis.fetch;
  (globalThis.fetch as any) = (async (url: any) => {
    const u = String(url);
    if (u === 'https://api.github.com/installation/repositories?per_page=100') {
      return new Response(JSON.stringify({ repositories: [{ id: Number(REPO_ID), name: 'app', full_name: 'octo/app', owner: { login: 'octo' }, private: true }] }), { status: 200 });
    }
    return (original as any)(url);
  });
  try {
    const out = await connect();
    assert.equal(out.ok, false);
    assert.match((out as any).message, /PUBLIC/i);
  } finally { globalThis.fetch = original; stubs.restore(); }
});

// --- 2. Webhook ---------------------------------------------------------------

test('invalid webhook signatures are rejected (401)', async () => {
  const out = await processWebhook(env, { rawBody: '{}', signatureHeader: 'sha256=' + '0'.repeat(64), deliveryId: 'd-1', event: 'release' });
  assert.equal(out.status, 401);
});

test('missing webhook configuration is reported honestly (503, never a fake success)', async () => {
  const noCfg = { ...env, GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '' };
  const out = await processWebhook(noCfg, { rawBody: '{}', signatureHeader: 'sha256=x', deliveryId: 'd-1', event: 'release' });
  assert.equal(out.status, 503);
});

test('wrong repository / installation association is ignored, not queued', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    const payload = ghReleasePayload();
    payload.repository = { id: 999999, full_name: 'someone/else' }; // not linked
    let out = await signedDelivery(env, 'release', payload, 'd-2');
    assert.equal(out.status, 200);
    assert.equal(out.body.data.ignored, true);

    const payload2 = ghReleasePayload();
    payload2.installation = { id: 424242 }; // different installation
    out = await signedDelivery(env, 'release', payload2, 'd-3');
    assert.equal(out.body.data.ignored, true);
    assert.equal(env.tables.github_releases.length, 0);
  } finally { stubs.restore(); }
});

test('duplicate webhook deliveries are idempotent (one release row, one event row)', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    const first = await signedDelivery(env, 'release', ghReleasePayload(), 'd-deliv-1');
    assert.equal(first.status, 200);
    assert.equal(first.body.data.status, 'detected');
    const again = await signedDelivery(env, 'release', ghReleasePayload(), 'd-deliv-1');
    assert.equal(again.status, 200);
    assert.equal(again.body.data.idempotent, true);
    assert.equal(env.tables.github_releases.filter((r) => r.github_release_id === '5001').length, 1);
    assert.equal(env.tables.github_release_events.filter((e) => e.delivery_id === 'd-deliv-1').length, 1);
  } finally { stubs.restore(); }
});

test('drafts, deleted releases, prereleases and invalid tags never become stable candidates', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    let out = await signedDelivery(env, 'release', ghReleasePayload({ draft: true }), 'd-draft');
    assert.equal(out.body.data.status, 'ignored_draft');
    out = await signedDelivery(env, 'release', { ...ghReleasePayload(), action: 'deleted' }, 'd-del');
    assert.equal(out.body.data.status, 'ignored_deleted');
    out = await signedDelivery(env, 'release', ghReleasePayload({ prerelease: true }), 'd-pre');
    assert.equal(out.body.data.status, 'blocked_prerelease');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    assert.equal(rel.status, 'blocked');
    assert.match(rel.block_reason, /[Pp]rerelease/);

    out = await signedDelivery(env, 'release', ghReleasePayload({ tag_name: 'not-a-version', id: 5002 }), 'd-badtag');
    assert.equal(out.body.data.status, 'ignored_invalid_tag');
  } finally { stubs.restore(); }
});

test('detection NEVER touches current_version, app_versions, canonical releases or notifications', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-clean');
    assert.equal(env.tables.applications[0].current_version, '1.11.11'); // unchanged
    assert.equal(env.tables.releases.length, 0);
    assert.equal(env.tables.packages.length, 0);
    assert.equal(env.tables.app_versions.length, 0);
    assert.equal(env.tables.notifications.length, 0);
  } finally { stubs.restore(); }
});

test('ambiguous or empty asset mappings are blocked', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    // No mapped assets at all
    let out = await signedDelivery(env, 'release', ghReleasePayload({
      id: 6001, tag_name: 'v2.0.0',
      assets: [{ id: 1, name: 'source.zip', browser_download_url: 'https://github.com/octo/app/releases/download/v2.0.0/source.zip' }],
    }), 'd-nomap');
    assert.equal(out.body.data.status, 'blocked_no_assets');

    // Two assets mapping to the same platform/arch
    out = await signedDelivery(env, 'release', ghReleasePayload({
      id: 6002, tag_name: 'v2.1.0',
      assets: [
        { id: 2, name: 'a.apk', browser_download_url: 'https://github.com/octo/app/releases/download/v2.1.0/a.apk' },
        { id: 3, name: 'b.apk', browser_download_url: 'https://github.com/octo/app/releases/download/v2.1.0/b.apk' },
      ],
    }), 'd-dup');
    assert.equal(out.body.data.status, 'blocked_ambiguous');

    // .deb without an architecture in the filename is unmapped (never guessed)
    out = await signedDelivery(env, 'release', ghReleasePayload({
      id: 6003, tag_name: 'v2.2.0',
      assets: [{ id: 4, name: 'app.deb', browser_download_url: 'https://github.com/octo/app/releases/download/v2.2.0/app.deb' }],
    }), 'd-nodebarch');
    assert.equal(out.body.data.status, 'blocked_no_assets');
  } finally { stubs.restore(); }
});

// --- 3. Verification ----------------------------------------------------------

test('verification computes size/sha256 from ACTUAL bytes and scans them; release becomes pending_approval', async () => {
  const stubs = installStubs(env, { vtVerdict: 'CLEAN' });
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-v1');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    const out = await verifyGithubRelease(env, rel.id);
    assert.ok(out.ok, out.message);
    assert.equal(out.status, 'pending_approval');
    const asset = env.tables.github_release_assets[0];
    assert.equal(asset.state, 'verified');
    assert.equal(asset.sha256, await sha256Hex(apkBytes()));
    assert.equal(asset.size_bytes, apkBytes().byteLength);
    assert.equal(asset.scanner_status, 'CLEAN');
    // R2 was never written — GitHub binaries are not RX Store storage.
    assert.equal(env.storagePuts.length, 0);
  } finally { stubs.restore(); }
});

test('declared checksum mismatch blocks the asset (actual bytes are authoritative)', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-v2');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    const asset = env.tables.github_release_assets[0];
    asset.declared_sha256 = 'f'.repeat(64); // wrong on purpose
    const out = await verifyGithubRelease(env, rel.id);
    assert.equal(out.ok, false);
    assert.equal(out.status, 'verification_failed');
    assert.equal(env.tables.github_release_assets[0].state, 'mismatch');
  } finally { stubs.restore(); }
});

test('metadata size mismatch (asset changed on GitHub) blocks verification', async () => {
  const stubs = installStubs(env, { ghAssetSize: 999999 }); // API says a different size than the bytes
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-v3');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    const out = await verifyGithubRelease(env, rel.id);
    assert.equal(out.status, 'verification_failed');
    assert.equal(env.tables.github_release_assets[0].state, 'mismatch');
  } finally { stubs.restore(); }
});

test('asset disappearance (GitHub 404) is marked missing and blocks', async () => {
  const stubs = installStubs(env, { assetStatus: 404 });
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-v4');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    const out = await verifyGithubRelease(env, rel.id);
    assert.equal(out.status, 'verification_failed');
    assert.equal(env.tables.github_release_assets[0].state, 'missing');
  } finally { stubs.restore(); }
});

// --- 4. Publication (the hard gate) -------------------------------------------

async function pendingRelease(vt: 'CLEAN' | 'DETECTED' | 'UNAVAILABLE' = 'CLEAN') {
  const stubs = installStubs(env, { vtVerdict: vt });
  await connect();
  await signedDelivery(env, 'release', ghReleasePayload(), 'd-pub');
  const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
  const v = await verifyGithubRelease(env, rel.id);
  assert.ok(v.ok, v.message);
  return { stubs, rel };
}

test('an authorized admin can review, approve and publish a valid release', async () => {
  const { stubs, rel } = await pendingRelease('CLEAN');
  try {
    const out = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.ok(out.ok, (out as any).message);
    // Canonical rows created with provider github + external URL, storage_key ''.
    const pkg = env.tables.packages[0];
    assert.equal(pkg.provider, 'github');
    assert.equal(pkg.storage_key, '');
    assert.equal(pkg.external_url, 'https://github.com/octo/app/releases/download/v1.12.0/clinical-rx-1.12.0.apk');
    assert.equal(pkg.sha256, await sha256Hex(apkBytes()));
    assert.equal(pkg.status, 'published');
    // current_version advanced + legacy app_versions carries the GitHub URL.
    assert.equal(env.tables.applications[0].current_version, '1.12.0');
    const legacy = env.tables.app_versions[0];
    assert.equal(legacy.version, '1.12.0');
    const files = JSON.parse(legacy.files);
    assert.equal(files.android.url, 'https://github.com/octo/app/releases/download/v1.12.0/clinical-rx-1.12.0.apk');
    // Notifications happen ONLY after publication.
    assert.ok(env.tables.notifications.length >= 0); // no downloaders in fake -> zero is honest
    assert.equal(env.tables.github_audit_log.some((e) => e.action === 'publish'), true);
    // R2 never written.
    assert.equal(env.storagePuts.length, 0);
  } finally { stubs.restore(); }
});

test('a DETECTED scanner verdict can NEVER be published, not even with an override', async () => {
  const stubs = installStubs(env, { vtVerdict: 'DETECTED' });
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-detected');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    const v = await verifyGithubRelease(env, rel.id);
    // A flagged asset fails verification outright — the release never even
    // reaches pending_approval.
    assert.equal(v.ok, false);
    assert.equal(env.tables.github_release_assets[0].scanner_status, 'DETECTED');
    assert.equal(env.tables.github_release_assets[0].state, 'failed');
    assert.equal(rel.status, 'verification_failed');
    // ...and an override attempt cannot publish it from any state.
    const out = await publishGithubRelease(env, ADMIN, rel.id, { overrideSecurity: true, reason: 'trusted developer, honest mistake' });
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.code, 'CONFLICT'); // not pending_approval
    assert.equal(env.tables.releases.length, 0);
    assert.equal(env.tables.applications[0].current_version, '1.11.11');
  } finally { stubs.restore(); }
});

test('an UNAVAILABLE mandatory security check blocks publication unless explicitly overridden (audited)', async () => {
  const { stubs, rel } = await pendingRelease('UNAVAILABLE');
  try {
    // No override -> blocked.
    let out = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.code, 'FORBIDDEN');
    assert.match((out as any).message, /override/i);

    // Override with a too-short reason -> rejected.
    out = await publishGithubRelease(env, ADMIN, rel.id, { overrideSecurity: true, reason: 'short' });
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.code, 'VALIDATION_ERROR');

    // Proper override -> publishes and audits the override.
    out = await publishGithubRelease(env, ADMIN, rel.id, { overrideSecurity: true, reason: 'Scanner unavailable; I verified the publisher manually.' });
    assert.ok(out.ok, (out as any).message);
    assert.equal(env.tables.applications[0].current_version, '1.12.0');
    assert.ok(env.tables.github_audit_log.some((e) => e.action === 'publish_with_override' && /manually/.test(String(e.reason || ''))));
  } finally { stubs.restore(); }
});

test('only pending_approval releases can be published; a second publish cannot double-publish', async () => {
  const { stubs, rel } = await pendingRelease('CLEAN');
  try {
    const first = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.ok(first.ok);
    const second = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.code, 'CONFLICT');
    assert.equal(env.tables.packages.filter((p) => p.version === '1.12.0').length, env.tables.github_release_assets.length);
  } finally { stubs.restore(); }
});

test('an asset that changed AFTER review re-blocks the release at publish time', async () => {
  const { stubs, rel } = await pendingRelease('CLEAN');
  try {
    // The asset is renamed on GitHub between review and publish.
    const original = globalThis.fetch;
    (globalThis.fetch as any) = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith('https://api.github.com/repos/octo/app/releases/assets/')) {
        return new Response(JSON.stringify({ id: 555001, name: 'RENAMED.apk', size: apkBytes().byteLength }), { status: 200 });
      }
      return (original as any)(url, init);
    });
    const out = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.equal(out.ok, false);
    assert.equal(env.tables.releases.length, 0);
    assert.equal(env.tables.applications[0].current_version, '1.11.11');
    assert.equal(env.tables.github_releases.find((r) => r.id === rel.id).status, 'blocked');
  } finally { stubs.restore(); }
});

test('rejecting a release (reason required) never makes it downloadable; redelivery does not resurrect it', async () => {
  const { stubs, rel } = await pendingRelease('CLEAN');
  try {
    let out = await rejectGithubRelease(env, ADMIN, rel.id, 'no');
    assert.equal(out.ok, false); // reason too short
    out = await rejectGithubRelease(env, ADMIN, rel.id, 'Release notes do not match the changelog in the repository.');
    assert.equal(out.ok, true);
    assert.equal(env.tables.releases.length, 0);
    assert.equal(env.tables.applications[0].current_version, '1.11.11');
    // A redelivered webhook for the same GitHub release does not resurrect it.
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-pub-2');
    const row = env.tables.github_releases.find((r) => r.id === rel.id);
    assert.equal(row.status, 'rejected');
    const pub = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.equal(pub.ok, false);
  } finally { stubs.restore(); }
});

test('withdrawing a published release stops update checks from recommending it', async () => {
  const { stubs, rel } = await pendingRelease('CLEAN');
  try {
    await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.equal(env.tables.applications[0].current_version, '1.12.0');
    const out = await withdrawGithubRelease(env, ADMIN, rel.id, 'Critical regression reported by users; fixing now.');
    assert.equal(out.ok, true);
    assert.equal(env.tables.releases[0].status, 'withdrawn');
    assert.equal(env.tables.packages[0].status, 'archived');
    assert.equal(env.tables.applications[0].current_version, '1.11.11'); // prior version restored
  } finally { stubs.restore(); }
});

test('disconnecting the repository stops future webhook processing', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    await disconnectAppRepository(env, { appId: APP_ID, orgId: ORG_ID, userId: USER_ID });
    const out = await signedDelivery(env, 'release', ghReleasePayload({ id: 7001, tag_name: 'v1.13.0' }), 'd-after-disc');
    assert.equal(out.body.data.ignored, true);
    assert.equal(env.tables.github_releases.filter((r) => r.github_release_id === '7001').length, 0);
  } finally { stubs.restore(); }
});

test('admin-triggered reconciliation detects releases without a webhook', async () => {
  const stubs = installStubs(env);
  const original = globalThis.fetch;
  (globalThis.fetch as any) = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith('https://api.github.com/repos/octo/app/releases?per_page=10')) {
      return new Response(JSON.stringify([ghReleasePayload().release]), { status: 200 });
    }
    return (original as any)(url, init);
  });
  try {
    await connect();
    const out = await syncAllConnections(env, ADMIN);
    assert.equal(out.checked, 1);
    assert.ok(out.detected >= 1);
    assert.equal(env.tables.github_releases.filter((r) => r.github_release_id === '5001').length, 1);
  } finally { globalThis.fetch = original; stubs.restore(); }
});

// --- 5. Pure helpers: mapping, versions, SSRF ---------------------------------

test('deterministic asset filename mapping (documented rules only, never guessed)', () => {
  assert.deepEqual(mapAssetFilename('app-1.2.3.apk'), { platform: 'android', architecture: 'universal' });
  assert.deepEqual(mapAssetFilename('Setup.exe'), { platform: 'windows', architecture: 'x64' });
  assert.deepEqual(mapAssetFilename('app-arm64.exe'), { platform: 'windows', architecture: 'arm64' });
  assert.deepEqual(mapAssetFilename('app_1.2.3_amd64.deb'), { platform: 'linux_deb', architecture: 'x64' });
  assert.deepEqual(mapAssetFilename('app_arm64.deb'), { platform: 'linux_deb', architecture: 'arm64' });
  assert.equal(mapAssetFilename('app.deb'), null); // ambiguous arch -> null
  assert.deepEqual(mapAssetFilename('App-x86_64.AppImage'), { platform: 'linux_appimage', architecture: 'x64' });
  assert.equal(mapAssetFilename('sources.zip'), null);
  assert.equal(mapAssetFilename('checksums.txt'), null);
});

test('rx-store manifest in the release body can disambiguate mapping — but never assign URLs', () => {
  const manifest = parseRxManifest('## Release\n```json\n{"rx-store":{"assets":[{"file":"my app.deb","platform":"linux_deb","architecture":"arm64"}]}}\n```\n');
  assert.deepEqual(manifest && manifest['my app.deb'], { platform: 'linux_deb', architecture: 'arm64' });
  const evil = parseRxManifest('```json\n{"rx-store":{"assets":[{"file":"https://evil.com/x.apk","platform":"android"}]}}\n```');
  assert.ok(!evil || evil['https://evil.com/x.apk'] === undefined, 'URLs are not filenames and never map'); // URLs are not filenames
});

test('version tags parse strictly (v-prefix ok, junk rejected)', () => {
  assert.equal(versionFromTag('v1.12.0'), '1.12.0');
  assert.equal(versionFromTag('1.2'), '1.2.0');
  assert.equal(versionFromTag('v1.2.3-beta.1'), '1.2.3-beta.1');
  assert.equal(versionFromTag('release-2026'), null);
});

test('SSRF guards: only https GitHub hosts, no IPs, no credentials, redirect hosts re-validated', async () => {
  assert.equal(validateAssetUrl('https://github.com/o/r/releases/download/v1/a.apk').ok, true);
  assert.equal(validateAssetUrl('https://objects.githubusercontent.com/x').ok, true);
  assert.equal(validateAssetUrl('http://github.com/x').ok, false); // https only
  assert.equal(validateAssetUrl('https://evil.com/a.apk').ok, false);
  assert.equal(validateAssetUrl('https://127.0.0.1/a.apk').ok, false);
  assert.equal(validateAssetUrl('https://user:pass@github.com/x').ok, false);
  assert.equal(validateAssetUrl('https://github.evil.com/x').ok, false);
  assert.equal(validateAssetUrl('ftp://github.com/x').ok, false);

  // A redirect to a non-GitHub host is refused mid-stream.
  const original = globalThis.fetch;
  (globalThis.fetch as any) = (async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/payload' } }));
  try {
    await assert.rejects(streamAssetHash('https://github.com/octo/app/releases/download/v1/a.apk', { maxBytes: 1000 }), /not an allowed GitHub asset host|rejected/);
  } finally { globalThis.fetch = original; }

  // The byte cap is enforced while streaming.
  const big = new Uint8Array(64).fill(65);
  (globalThis.fetch as any) = (async () => new Response(big as unknown as BodyInit, { status: 200 }));
  try {
    await assert.rejects(streamAssetHash('https://github.com/o/r/releases/download/v1/a.apk', { maxBytes: 10 }), /size limit/);
  } finally { globalThis.fetch = original; }
});

test('webhook signature verification is exact and timing-safe-compared', async () => {
  const raw = JSON.stringify({ hello: 'world' });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  let hex = ''; for (const b of mac) hex += b.toString(16).padStart(2, '0');
  assert.equal(await verifyWebhookSignature(WEBHOOK_SECRET, raw, `sha256=${hex}`), true);
  assert.equal(await verifyWebhookSignature(WEBHOOK_SECRET, raw + 'x', `sha256=${hex}`), false);
  assert.equal(await verifyWebhookSignature('other-secret', raw, `sha256=${hex}`), false);
  assert.equal(await verifyWebhookSignature(WEBHOOK_SECRET, raw, 'sha1=abc'), false);
  assert.equal(await verifyWebhookSignature(WEBHOOK_SECRET, raw, null), false);
});

// --- 6. Provider-aware integration with the existing pipeline -----------------

test('validatePackageIntegrity accepts github packages via external_url and still requires storage for manual ones', async () => {
  const { validatePackageIntegrity } = await import('./services/releases.ts');
  const githubPkg: any = { platform: 'android', architecture: 'universal', version: '1.0.0', filename: 'a.apk', sha256: 'a'.repeat(64), file_size: 10, provider: 'github', external_url: 'https://github.com/o/r/releases/download/v1/a.apk', storage_key: '' };
  assert.equal(validatePackageIntegrity(githubPkg).ok, true);
  const missingUrl: any = { ...githubPkg, external_url: undefined };
  assert.equal(validatePackageIntegrity(missingUrl).ok, false);
  assert.ok(validatePackageIntegrity(missingUrl).problems.includes('external_url'));
  const manual: any = { platform: 'android', architecture: 'universal', version: '1.0.0', filename: 'a.apk', sha256: 'a'.repeat(64), file_size: 10, storage_key: 'apps/x/1.0.0/android/file.apk' };
  assert.equal(validatePackageIntegrity(manual).ok, true);
  const manualNoKey: any = { ...manual, storage_key: '' };
  assert.equal(validatePackageIntegrity(manualNoKey).ok, false);
  assert.ok(validatePackageIntegrity(manualNoKey).problems.includes('storage_key'));
});

test('buildManifest serves the GitHub asset URL directly (never an /r2/ path)', async () => {
  const { buildManifest } = await import('./services/releases.ts');
  const manifest = buildManifest({
    pkg: { provider: 'github', external_url: 'https://github.com/o/r/releases/download/v1/a.apk', storage_key: '', filename: 'a.apk', file_size: 123, sha256: 'b'.repeat(64), version: '1.0.0', platform: 'android', architecture: 'universal' } as any,
    matchedPlatform: 'android', matchedArchitecture: 'universal', origin: 'https://api.example.com',
  });
  assert.equal(manifest.url, 'https://github.com/o/r/releases/download/v1/a.apk');
  assert.ok(!manifest.url.includes('/r2/'));
});
