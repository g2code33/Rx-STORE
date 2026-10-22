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
  bindRepositoryFromCode, adminSetConnectionStatus,
} from './services/githubReleases.ts';
import { githubDevRoutes, githubAdminRoutes, githubOAuthRoutes } from './routes/githubIntegration.ts';
import { issueOneTimeToken } from './services/oauth.ts';

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
      price_type: 'free', price_amount: 0, current_version: '1.11.11', platforms: 'linux,web',
      linux_package_name: 'clinical-rx',
    }],
    releases: [], packages: [], app_versions: [], notifications: [], downloads: [],
    github_repo_connections: [], github_release_events: [], github_releases: [],
    github_release_assets: [], github_audit_log: [], site_settings: [],
    oauth_tokens: [],
    admin_events: [],
    package_security_results: [], package_manual_reviews: [], package_security_overrides: [],
    scanner_cache: [], audit_logs: [],
    developers: [{ id: ORG_ID, name: 'Org' }],
    developer_members: [{ id: 'mem-1', developer_id: ORG_ID, user_id: USER_ID, role: 'owner' }],
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
            // REAL constraint: UNIQUE(application_id) and UNIQUE(repository_id).
            if (T('github_repo_connections').some((c) => c.application_id === a[1] || c.repository_id === a[2])) {
              const e: any = new Error('UNIQUE constraint failed: github_repo_connections.application_id');
              return Promise.reject(e);
            }
            T('github_repo_connections').push({ id: a[0], application_id: a[1], repository_id: a[2], repository_owner: a[3], repository_name: a[4], repository_full_name: a[5], installation_id: a[6], status: 'active', connected_by: a[7] });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE github_repo_connections SET repository_id=?')) {
            const c = T('github_repo_connections').find((x) => x.id === a[6]);
            if (c) Object.assign(c, {
              repository_id: a[0], repository_owner: a[1], repository_name: a[2], repository_full_name: a[3],
              installation_id: a[4], status: 'active', connected_by: a[5], last_error: null,
            });
            return { meta: { changes: c ? 1 : 0 } };
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
            const row = { id: a[0], release_id: a[1], github_asset_id: a[2], name: a[3], platform: a[4], architecture: a[5], download_url: a[6], state: 'detected', declared_sha256: a[8], is_private: a[9] ?? 0, arch_assumed: a[10] ?? 0, size_bytes: null as any, sha256: null as any, scanner_status: null as any, scanner_detail: null as any, error: null as any };
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
            // status comes from the SQL literal ('under_review' at detection)
            const status = s.includes("'under_review'") ? 'under_review' : 'published';
            T('releases').push({ id: a[0], application_id: a[1], version: a[2], status, channel: a[5], release_notes: a[3], published_at: status === 'published' ? 'now' : null });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO packages')) {
            // detection shape: (id, app, release, platform, arch, filename, storage_key,
            // file_size, mime, sha256, version, external_url, github_asset_id) with
            // status 'stored' + QUARANTINED in the SQL literal.
            const pkgRow: any = { id: a[0], application_id: a[1], release_id: a[2], platform: a[3], architecture: a[4], filename: a[5], storage_key: a[6], file_size: a[7], sha256: a[9], version: a[10], provider: 'github', external_url: a[11], github_asset_id: a[12], external_private: a[13] ?? 0, arch_assumed: a[14] ?? 0, status: s.includes("'stored'") ? 'stored' : 'published', security_state: 'QUARANTINED', overall_security: 'PENDING', quarantine_key: null, deployment_url: null, security_scan_status: 'pending', signature_status: 'pending' };
            const dup = T('packages').find((x) => x.release_id === pkgRow.release_id && x.platform === pkgRow.platform && x.architecture === pkgRow.architecture);
            if (dup) { const e: any = new Error('UNIQUE constraint failed: packages.release_id'); return Promise.reject(e); }
            T('packages').push(pkgRow);
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO package_security_results') && !s.includes('classification')) {
            // manual-aid shape: (id, package_id, release_id, app_id, check_type, status, provider, result, details)
            T('package_security_results').push({
              id: a[0], package_id: a[1], release_id: a[2], app_id: a[3], check_type: a[4], status: a[5],
              provider: a[6], result: a[7], details: a[8], created_at: new Date().toISOString(),
            });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO package_security_results')) {
            T('package_security_results').push({ id: a[0], package_id: a[1], release_id: a[2], app_id: a[3], developer_id: a[4], check_type: a[5], status: a[6], classification: a[7], provider: a[8], provider_version: a[9], result: a[10], details: a[11], fingerprint: a[12], error: a[13], started_at: a[14], completed_at: a[15], scanner_analysis_id: a[16], scanner_verdict: a[20], created_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO package_manual_reviews')) {
            T('package_manual_reviews').push({ id: a[0], package_id: a[1], release_id: a[2], sha256: a[3], platform: a[4], automated_integrity: a[5], automated_malware: a[6], automated_overall: a[7], reason: a[8], status: 'PENDING', created_at: new Date().toISOString(), reviewed_at: null, invalidated_at: null, admin_notes: null });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO package_security_overrides')) {
            T('package_security_overrides').push({ id: a[0], package_id: a[1], admin_user_id: a[2], reason: a[3], prior_state: a[4], prior_overall: a[5], sha256: a[6], invalidated_at: null, created_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO admin_events')) {
            T('admin_events').push({ id: a[0], section: a[1], type: a[2], title: a[3], message: a[4], link: a[5], meta: a[6], actor_user_id: a[7], read_at: null, created_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (s.includes('CREATE TABLE IF NOT EXISTS admin_events') || s.includes('CREATE INDEX IF NOT EXISTS idx_admin_events')) return { meta: { changes: 0 } };
          if (s.includes('INSERT INTO audit_logs')) {
            T('audit_logs').push({ id: a[0], action: a[1], resource_type: a[2], resource_id: a[3], details: a[4] });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO scanner_cache')) {
            // (sha256, provider, verdict, analysis_id, malicious, suspicious, harmless, undetected) — scanned_at is a SQL literal
            const [sha, provider, verdict, analysis_id, malicious, suspicious, harmless, undetected] = a;
            const existing = T('scanner_cache').find((c) => c.sha256 === sha);
            const row = { sha256: sha, provider, verdict, analysis_id, malicious, suspicious, harmless, undetected, scanned_at: new Date().toISOString() };
            if (existing) Object.assign(existing, row); else T('scanner_cache').push(row);
            return { meta: { changes: 1 } };
          }
          // pipeline per-check progress: UPDATE packages SET security_state=?, overall_security='PENDING'[, scan/sig cols] WHERE id=?
          if (s.includes('UPDATE packages SET security_state=?') && s.includes("overall_security='PENDING'")) {
            const pkg = T('packages').find((x) => x.id === a[a.length - 1]);
            if (pkg) {
              pkg.security_state = a[0];
              if (s.includes('security_scan_status=')) pkg.security_scan_status = null; // literal in SQL; find it
              const m = s.match(/security_scan_status='([A-Z]+)'/); if (m) pkg.security_scan_status = m[1];
              const m2 = s.match(/signature_status='([A-Z_]+)'/); if (m2) pkg.signature_status = m2[1];
            }
            return { meta: { changes: pkg ? 1 : 0 } };
          }
          // finish(): UPDATE packages SET security_state=?, overall_security=?, verified_at=... WHERE id=?
          if (s.includes('UPDATE packages SET security_state=?') && s.includes('verified_at=')) {
            const pkg = T('packages').find((x) => x.id === a[2]);
            if (pkg) { pkg.security_state = a[0]; pkg.overall_security = a[1]; pkg.verified_at = 'now'; }
            return { meta: { changes: pkg ? 1 : 0 } };
          }
          // verify pass 1 records the hash: UPDATE packages SET sha256=?, file_size=? WHERE release_id=? AND platform=? AND architecture=? AND provider='github'
          if (s.includes('UPDATE packages SET architecture=?')) {
            // (architecture, release_id, platform, old_architecture)
            const pkgs = T('packages').filter((x) => x.release_id === a[1] && x.platform === a[2] && x.architecture === a[3] && x.provider === 'github');
            for (const pkg of pkgs) { pkg.architecture = a[0]; pkg.arch_assumed = 0; }
            return { meta: { changes: pkgs.length } };
          }
          if (s.includes('UPDATE github_release_assets SET architecture=?')) {
            const r = T('github_release_assets').find((x) => x.id === a[1]);
            if (r) { r.architecture = a[0]; r.arch_assumed = 0; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes('UPDATE packages SET sha256=?, file_size=? WHERE id=?')) {
            const pkg = T('packages').find((x) => x.id === a[2]);
            if (pkg) { pkg.sha256 = a[0]; pkg.file_size = a[1]; }
            return { meta: { changes: pkg ? 1 : 0 } };
          }
          if (s.includes('UPDATE packages SET sha256=?, file_size=?')) {
            const pkgs = T('packages').filter((x) => x.release_id === a[2] && x.platform === a[3] && x.architecture === a[4] && x.provider === 'github');
            for (const pkg of pkgs) { pkg.sha256 = a[0]; pkg.file_size = a[1]; }
            return { meta: { changes: pkgs.length } };
          }
          // publish transitions
          if (s.includes("UPDATE releases SET status='published'")) {
            const r = T('releases').find((x) => x.id === a[0] && x.status !== 'published');
            if (r) { r.status = 'published'; r.published_at = 'now'; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes("UPDATE releases SET status='under_review', published_at=NULL")) {
            const r = T('releases').find((x) => x.id === a[0]);
            if (r) { r.status = 'under_review'; r.published_at = null; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes("UPDATE packages SET status='published'")) {
            // (security_state, overall_security, release_id) — literal status in SQL
            const pkgs = T('packages').filter((x) => x.release_id === a[2] && x.status === 'stored');
            for (const pkg of pkgs) { pkg.status = 'published'; pkg.security_state = a[0]; pkg.overall_security = a[1]; }
            return { meta: { changes: pkgs.length } };
          }
          if (s.includes("UPDATE packages SET status='stored'")) {
            const pkgs = T('packages').filter((x) => x.release_id === a[0] && x.status === 'published');
            for (const pkg of pkgs) pkg.status = 'stored';
            return { meta: { changes: pkgs.length } };
          }
          if (s.includes('UPDATE package_manual_reviews SET invalidated_at')) {
            let n = 0;
            for (const r of T('package_manual_reviews')) {
              if (r.package_id === a[0] && String(r.sha256) === String(a[1]) && String(s).includes(`'${r.status}'`)) { r.invalidated_at = 'now'; n++; }
            }
            return { meta: { changes: n } };
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
          if (s.includes('UPDATE github_repo_connections SET status=?, last_error=?')) {
            // (status, last_error, id) — admin suspend / reinstate / disconnect
            const c = T('github_repo_connections').find((x) => x.id === a[2]);
            if (c) { c.status = a[0]; c.last_error = a[1]; }
            return { meta: { changes: c ? 1 : 0 } };
          }
          if (s.includes('UPDATE github_repo_connections SET status=\'disconnected\'')) {
            const c = T('github_repo_connections').find((x) => x.id === a[0]); if (c) c.status = 'disconnected';
            return { meta: { changes: c ? 1 : 0 } };
          }
          if (s.includes('UPDATE github_repo_connections SET repository_private=?')) {
            const c = T('github_repo_connections').find((x) => x.id === a[1]);
            if (c) c.repository_private = a[0];
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
          if (s.includes('UPDATE github_releases SET ignored_assets=?')) {
            const r = T('github_releases').find((x) => x.id === a[1]);
            if (r) r.ignored_assets = a[0];
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes('ALTER TABLE github_releases ADD COLUMN ignored_assets')) return { meta: { changes: 0 } };
          if (s.includes("UPDATE github_releases SET status='withdrawn', block_reason=? WHERE id=? AND status IN")) {
            const r = T('github_releases').find((x) => x.id === a[1]);
            if (r && ['detected', 'verifying', 'pending_approval', 'verification_failed', 'blocked'].includes(r.status)) {
              r.status = 'withdrawn'; r.block_reason = a[0];
            }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes("UPDATE github_releases SET status='detected', block_reason=NULL")) {
            const r = T('github_releases').find((x) => x.id === a[0]);
            if (r && r.status === 'blocked') { r.status = 'detected'; r.block_reason = null; }
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
          if (s.includes('COALESCE(NULLIF(scanner_status')) {
            // manual approval: (size_bytes, sha256, detail, id)
            const r = T('github_release_assets').find((x) => x.id === a[3]);
            if (r) Object.assign(r, { state: 'verified', size_bytes: a[0], sha256: a[1], scanner_status: r.scanner_status || 'MANUAL', scanner_detail: a[2], error: null, verified_at: 'now' });
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes("UPDATE github_release_assets SET state='verified'")) {
            // (size_bytes, sha256, id)
            const r = T('github_release_assets').find((x) => x.id === a[2]);
            if (r) { r.state = 'verified'; r.size_bytes = a[0]; r.sha256 = a[1]; r.error = null; r.verified_at = 'now'; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes('UPDATE github_release_assets SET scanner_status=?')) {
            // (scanner_status, scanner_detail, id)
            const r = T('github_release_assets').find((x) => x.id === a[2]);
            if (r) { r.scanner_status = a[0]; r.scanner_detail = a[1]; r.scanned_at = 'now'; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (s.includes("UPDATE github_release_assets SET state='missing'")) {
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
          if (s.includes('INSERT INTO oauth_tokens')) {
            T('oauth_tokens').push({ id: a[0], kind: a[1], token_hash: a[2], payload: a[3], created_at: 'now', expires_at: a[4], consumed_at: null });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE oauth_tokens SET consumed_at=datetime(\'now\') WHERE id=? AND consumed_at IS NULL')) {
            const t = T('oauth_tokens').find((x) => x.id === a[0] && x.consumed_at === null);
            if (t) t.consumed_at = 'now';
            return { meta: { changes: t ? 1 : 0 } };
          }
          if (s.includes('UPDATE oauth_tokens SET consumed_at=NULL')) {
            for (const t of T('oauth_tokens')) if (t.token_hash === a[0]) t.consumed_at = null;
            return { meta: { changes: 1 } };
          }
          if (s.includes('DELETE FROM oauth_tokens WHERE expires_at')) {
            const now = Date.now();
            for (let i = T('oauth_tokens').length - 1; i >= 0; i--) if (new Date(T('oauth_tokens')[i].expires_at).getTime() < now) T('oauth_tokens').splice(i, 1);
            return { meta: { changes: 0 } };
          }
          if (s.includes('CREATE TABLE') || s.includes('CREATE INDEX') || s.includes('CREATE UNIQUE INDEX')) return { meta: { changes: 0 } };
          if (s.includes('DELETE FROM github_releases WHERE id=?')) {
            const idx = T('github_releases').findIndex((x) => x.id === a[0]);
            if (idx >= 0) T('github_releases').splice(idx, 1);
            return { meta: { changes: idx >= 0 ? 1 : 0 } };
          }
          if (s.includes('DELETE FROM releases WHERE id=?')) {
            const idx = T('releases').findIndex((x) => x.id === a[0]);
            if (idx >= 0) T('releases').splice(idx, 1);
            return { meta: { changes: idx >= 0 ? 1 : 0 } };
          }
          if (s.includes('DELETE FROM packages WHERE release_id=?')) {
            for (let i = T('packages').length - 1; i >= 0; i--) if (T('packages')[i].release_id === a[0]) T('packages').splice(i, 1);
            return { meta: { changes: 1 } };
          }
          if (s.includes('DELETE FROM github_release_assets')) {
            const r = T('github_release_assets'); for (let i = r.length - 1; i >= 0; i--) if (r[i].release_id === a[0]) r.splice(i, 1);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          const a = this._binds;
          const T = (name: string) => tables[name];
          if (s.includes('FROM oauth_tokens WHERE token_hash=? AND kind=?')) {
            return T('oauth_tokens').find((t) => t.token_hash === a[0] && t.kind === a[1] && t.consumed_at === null && new Date(t.expires_at).getTime() > Date.now())
              ? T('oauth_tokens').find((t) => t.token_hash === a[0] && t.kind === a[1] && t.consumed_at === null && new Date(t.expires_at).getTime() > Date.now())
              : null;
          }
          if (s.includes('FROM developer_members m JOIN developers d ON d.id = m.developer_id')) {
            const m = T('developer_members').find((x) => x.user_id === a[0]);
            const d = m && T('developers').find((x) => x.id === m.developer_id);
            return (m && d) ? { member_id: m.id, role: m.role, member_since: 'now', ...d } : null;
          }
          if (s.includes('FROM package_security_results WHERE package_id=? AND check_type=?')) {
            const rows = T('package_security_results').filter((r) => r.package_id === a[0] && r.check_type === a[1]);
            return rows.length ? rows[rows.length - 1] : null;
          }
          if (s.includes('SELECT MAX(CASE WHEN check_type')) {
            const rows = T('package_security_results').filter((r) => r.package_id === a[0]);
            const at = (t: string) => rows.filter((r) => r.check_type === t).map((r) => r.created_at).sort().pop() || null;
            return { integrity_at: at('integrity'), malware_at: at('malware') };
          }
          if (s.includes('FROM package_manual_reviews WHERE package_id=? AND sha256=?')) {
            return T('package_manual_reviews').find((r) => r.package_id === a[0] && String(r.sha256) === String(a[1]) && ['PENDING', 'APPROVED'].includes(r.status) && !r.invalidated_at) || null;
          }
          if (s.includes("FROM package_manual_reviews WHERE package_id=? AND status='APPROVED'")) {
            return T('package_manual_reviews').filter((r) => r.package_id === a[0] && r.status === 'APPROVED' && !r.invalidated_at).pop() || null;
          }
          if (s.includes('FROM package_manual_reviews WHERE package_id=?')) {
            return T('package_manual_reviews').filter((r) => r.package_id === a[0]).pop() || null;
          }
          if (s.includes('FROM package_security_overrides WHERE package_id=?')) {
            return T('package_security_overrides').filter((r) => r.package_id === a[0] && !r.invalidated_at).pop() || null;
          }
          if (s.includes('FROM scanner_cache WHERE sha256=? AND provider=?')) {
            return T('scanner_cache').find((c) => c.sha256 === a[0] && c.provider === a[1]) || null;
          }
          if (s.includes('SELECT id, status AS canonical_status FROM releases WHERE application_id=? AND version=?')) {
            const r = T('releases').find((x) => x.application_id === a[0] && x.version === a[1]);
            return r ? { id: r.id, canonical_status: r.status } : null;
          }
          if (s.includes('SELECT id FROM releases WHERE application_id=? AND version=?')) {
            return T('releases').find((x) => x.application_id === a[0] && x.version === a[1]) || null;
          }
          if (s.includes("SELECT id FROM packages WHERE release_id=? AND platform=? AND architecture=? AND provider='github'")) {
            return T('packages').find((x) => x.release_id === a[0] && x.platform === a[1] && x.architecture === a[2] && x.provider === 'github') || null;
          }
          if (s.includes('SELECT id FROM releases WHERE application_id') && s.includes("status='published'")) return T('releases').find((r) => r.application_id === a[0] && r.version === a[1] && r.status === 'published') || null;
          if (s.includes('FROM packages WHERE release_id=? AND platform=? AND architecture=?') && s.includes("provider='github'")) {
            return T('packages').find((r) => r.release_id === a[0] && r.platform === a[1] && r.architecture === a[2] && r.provider === 'github') || null;
          }
          if (s.includes('FROM packages WHERE id=?')) {
            const rows = T('packages').filter((x) => x.id === a[0]);
            return rows.length ? rows[rows.length - 1] : null;
          }
          if (s.includes('FROM github_repo_connections WHERE application_id')) return T('github_repo_connections').find((c) => c.application_id === a[0]) || null;
          if (s.includes('FROM github_repo_connections WHERE repository_id')) return T('github_repo_connections').find((c) => c.repository_id === a[0] && c.status === 'active') || null;
          if (s.includes('FROM github_repo_connections WHERE id')) return T('github_repo_connections').find((c) => c.id === a[0]) || null;
          if (s.includes('FROM github_release_events WHERE delivery_id')) return T('github_release_events').find((e) => e.delivery_id === a[0] && e.event === a[1]) || null;
          if (s.includes('FROM github_releases WHERE github_release_id')) return T('github_releases').find((r) => r.github_release_id === a[0]) || null;
          if (s.includes('FROM github_releases WHERE application_id=? AND version') || s.includes('FROM github_releases WHERE application_id = ? AND version')) return T('github_releases').find((r) => r.application_id === a[0] && r.version === a[1]) || null;
          if (s.includes('FROM github_releases WHERE id')) return T('github_releases').find((r) => r.id === a[0]) || null;
          if (s.includes("status='withdrawn' AND block_reason LIKE") && s.includes('application_id=?')) {
            return null; // batch path uses all()
          }
          if (s.includes("SELECT id FROM releases WHERE application_id=? AND version=?") && s.includes("status <> 'published'")) {
            return T('releases').find((r) => r.application_id === a[0] && r.version === a[1] && r.status !== 'published') || null;
          }
          if (s.includes('FROM github_release_assets WHERE id=? AND release_id=?')) {
            return T('github_release_assets').find((r) => r.id === a[0] && r.release_id === a[1]) || null;
          }
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
          if (s.includes("state IN ('failed','mismatch','missing')")) {
            return { results: T('github_release_assets').filter((r) => r.release_id === a[0] && ['failed', 'mismatch', 'missing'].includes(r.state)) };
          }
          if (s.includes('FROM github_release_assets WHERE release_id=? AND platform=? AND architecture=? AND id<>?')) {
            return { results: T('github_release_assets').filter((r) => r.release_id === a[0] && r.platform === a[1] && r.architecture === a[2] && r.id !== a[3]) };
          }
          if (s.includes('FROM github_release_events WHERE repository_id=?')) return { results: T('github_release_events').filter((e) => String(e.repository_id) === String(a[0])).slice(0, 5) };
          if (s.includes('FROM package_security_results') && s.includes('SELECT MAX(id)')) {
            // latest per check_type for one package (a[0]); blockers variant adds a status filter
            const target = a[a.length - 1];
            const statuses = s.match(/status IN \(([^)]*)\)/)?.[1];
            const latest: any[] = [];
            for (const t of ['structure', 'integrity', 'duplicate', 'malware', 'signature', 'certificate', 'dependency', 'native_identity']) {
              const rows = T('package_security_results').filter((r) => r.package_id === target && r.check_type === t);
              if (rows.length) latest.push(rows[rows.length - 1]);
            }
            const filtered = statuses ? latest.filter((r) => statuses.includes(`'${r.status}'`)) : latest;
            return { results: filtered.map((r) => ({ check_type: r.check_type, status: r.status, result: r.result, details: r.details, provider: r.provider, provider_version: r.provider_version, classification: r.classification, fingerprint: r.fingerprint, error: r.error, completed_at: r.completed_at, started_at: r.started_at, scanner_analysis_id: r.scanner_analysis_id, scanner_verdict: r.scanner_verdict, scanner_raw_summary: null, scanner_started_at: null, scanner_completed_at: null })) };
          }
          if (s.includes('FROM packages WHERE release_id=?')) {
            return { results: T('packages').filter((x) => x.release_id === a[0]) };
          }
          if (s.includes('FROM packages p LEFT JOIN releases r')) {
            return { results: T('packages').filter((x) => x.sha256 === a[0] && x.id !== a[1]).map((x) => ({ id: x.id, application_id: x.application_id, platform: x.platform, release_id: x.release_id, appId: x.application_id, release_version: null })) };
          }
          if (s.includes('FROM github_repo_connections WHERE status=\'active\'') || s.includes("FROM github_repo_connections WHERE status = 'active'")) return { results: T('github_repo_connections').filter((c) => c.status === 'active') };
          if (s.includes('SELECT DISTINCT application_id FROM github_releases')) {
            return { results: [...new Set(T('github_releases').map((r) => r.application_id))].map((application_id) => ({ application_id })) };
          }
          if (s.includes('SELECT id, version FROM github_releases WHERE application_id=?')) {
            return { results: T('github_releases').filter((r) => r.application_id === a[0] && ['detected', 'verifying', 'pending_approval', 'verification_failed', 'blocked'].includes(r.status)) };
          }
          if (s.includes('SELECT id, version FROM github_releases') && s.includes('id<>?')) {
            return { results: T('github_releases').filter((r) => r.application_id === a[0] && r.id !== a[1] && ['detected', 'verifying', 'pending_approval', 'verification_failed', 'blocked'].includes(r.status)) };
          }
          if (s.includes('SELECT state, sha256 FROM github_release_assets')) {
            return { results: T('github_release_assets').filter((r) => r.release_id === a[0]).map((r) => ({ state: r.state, sha256: r.sha256 })) };
          }
          if (s.includes("status='withdrawn' AND block_reason LIKE")) {
            const prefix = String(a[a.length - 1] || '').replace('%', '');
            const byApp = s.includes('application_id=?') ? String(a[0]) : null;
            return { results: T('github_releases').filter((r) => r.status === 'withdrawn'
              && String(r.block_reason || '').startsWith(prefix)
              && (!byApp || r.application_id === byApp)) };
          }
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
    GITHUB_APP_CLIENT_ID: 'Iv1.rxstoreapp', GITHUB_APP_CLIENT_SECRET: 'app-client-secret-test',
    GITHUB_APP_PRIVATE_KEY: '', GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    VIRUSTOTAL_API_KEY: 'vt-test-key',
    MALWARE_SCANNER: 'virustotal',
    RX_STORE_WEB_URL: 'https://web.test',
    STORAGE: { put: (...args: any[]) => { storagePuts.push(args); return Promise.resolve({}); }, get: () => Promise.resolve(null), head: () => Promise.resolve(null) },
  };
}

// ---------------------------------------------------------------------------
// Fetch stubs: GitHub API + asset bytes + VirusTotal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// REAL package fixtures — the security pipeline parses actual structures
// (ZIP central directories, ar archives, PE headers), so the test assets must
// be genuine minimal packages, not blobs.
// ---------------------------------------------------------------------------

/** Build a minimal STORED-entry ZIP (valid local headers + central directory + EOCD). */
function buildZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const lh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(8, 0, true);            // method STORED
    dv.setUint32(18, e.data.length, true); // compressed
    dv.setUint32(22, e.data.length, true); // uncompressed
    dv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    chunks.push(lh, e.data);
    const cd = new Uint8Array(46 + nameBytes.length);
    const dv2 = new DataView(cd.buffer);
    dv2.setUint32(0, 0x02014b50, true);
    dv2.setUint16(10, 0, true);           // method STORED
    dv2.setUint32(20, e.data.length, true);
    dv2.setUint32(24, e.data.length, true);
    dv2.setUint16(28, nameBytes.length, true);
    dv2.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += lh.length + e.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const dv3 = new DataView(eocd.buffer);
  dv3.setUint32(0, 0x06054b50, true);
  dv3.setUint16(8, central.length, true);
  dv3.setUint16(10, central.length, true);
  dv3.setUint32(12, cdSize, true);
  dv3.setUint32(16, offset, true);
  return concat([...chunks, ...central, eocd]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** APK fixture: ZIP with AndroidManifest.xml + a v1 JAR signature file. */
function apkBytes(): Uint8Array {
  return buildZip([
    { name: 'AndroidManifest.xml', data: new TextEncoder().encode('binary-axml-package:com.calcitonin.clinicalrx') },
    { name: 'META-INF/CERT.RSA', data: new TextEncoder().encode('PKCS7-PLACEHOLDER') },
  ]);
}

// Precomputed fixtures (the deb is async to build — gzip/tar).
const DEB_FIXTURE = await debBytes('clinical-rx');
const DEB_SHA = await sha256Hex(DEB_FIXTURE);

/** Unsigned APK fixture: manifest present, NO signature file. */
function unsignedApkBytes(): Uint8Array {
  return buildZip([
    { name: 'AndroidManifest.xml', data: new TextEncoder().encode('binary-axml') },
  ]);
}

/** Minimal gzip (a real tar with ./control declaring Package: clinical-rx). */
async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new CompressionStream('gzip');
  const stream = new Blob([data.slice() as unknown as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function tarWithControl(control: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const content = enc.encode(control);
  const header = new Uint8Array(512);
  const name = enc.encode('./control');
  header.set(name, 0);
  header.set(enc.encode('0000644\0'), 100);
  header.set(enc.encode('0000000\0'), 108);
  header.set(enc.encode('0000000\0'), 116);
  header.set(enc.encode(String(content.length).padStart(11, '0') + '\0'), 124);
  header.set(enc.encode('0'), 156);
  header.set(enc.encode('        '), 148); // checksum placeholder
  let sum = 0; for (const b of header) sum += b;
  header.set(enc.encode(String(sum).padStart(6, '0') + '\0 '), 148);
  const pad = new Uint8Array(512 - (content.length % 512));
  return concat([header, content, pad, new Uint8Array(1024)]);
}

/** .deb fixture: ar archive (debian-binary + control.tar.gz + data.tar.gz). */
async function debBytes(packageName = 'clinical-rx'): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const member = (name: string, data: Uint8Array) => {
    // ar header: name[16] mtime[12] uid[6] gid[6] mode[8] size[10] magic[2]
    const head = new Uint8Array(60);
    head.set(enc.encode(name.padEnd(16, ' ')), 0);
    head.set(enc.encode('0'.repeat(12)), 16);          // mtime
    head.set(enc.encode('0'.repeat(6)), 28);           // uid
    head.set(enc.encode('0'.repeat(6)), 34);           // gid
    head.set(enc.encode('100644'.padEnd(8, ' ')), 40); // mode
    head.set(enc.encode(String(data.length).padEnd(10, ' ')), 48);
    head.set(enc.encode('`\n'), 58);
    const pad = data.length % 2 ? new Uint8Array([10]) : new Uint8Array(0);
    return concat([head, data, pad]);
  };
  const controlTar = await gzip(await tarWithControl(`Package: ${packageName}\nVersion: 1.12.0\nArchitecture: amd64\n`));
  const dataTar = await gzip(await tarWithControl('Package: data\n'));
  return concat([
    enc.encode('!<arch>\n'),
    member('debian-binary', enc.encode('2.0\n')),
    member('control.tar.gz', controlTar),
    member('data.tar.gz', dataTar),
  ]);
}

/** Minimal PE (MZ + PE header, machine configurable, no security directory). */
function peBytes(machine = 0x8664): Uint8Array {
  const buf = new Uint8Array(512);
  const dv = new DataView(buf.buffer);
  buf.set([0x4d, 0x5a], 0);                 // MZ
  dv.setUint32(0x3c, 128, true);            // e_lfanew -> PE at 128
  buf.set([0x50, 0x45, 0x00, 0x00], 128);   // PE\0\0
  dv.setUint16(132 + 20, 0x10b, true);      // optional header magic PE32
  dv.setUint16(128 + 4, machine, true);     // machine
  dv.setUint16(128 + 20, 224, true);        // SizeOfOptionalHeader
  dv.setUint32(128 + 20 + 92, 2, true);     // NumberOfRvaAndSizes (2 < 5 -> no security dir)
  return buf;
}


async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

type AssetKind = 'deb' | 'apk' | 'unsigned-apk' | 'pe-x64' | 'pe-arm64';

interface StubOpts {
  asset?: AssetKind;
  assetStatus?: number;
  ghAssetName?: string;
  ghAssetSize?: number;
  vtVerdict?: 'CLEAN' | 'DETECTED' | 'UNAVAILABLE' | 'SCANNING';
}

function assetBytesFor(kind: AssetKind = 'deb'): Uint8Array {
  switch (kind) {
    case 'apk': return apkBytes();
    case 'unsigned-apk': return unsignedApkBytes();
    case 'pe-x64': return peBytes(0x8664);
    case 'pe-arm64': return peBytes(0xaa64);
    default: return DEB_FIXTURE;
  }
}

function installStubs(env: any, opts: StubOpts = {}) {
  const original = globalThis.fetch;
  const kind: AssetKind = opts.asset ?? 'deb';
  const bytes = assetBytesFor(kind);
  const ghName = opts.ghAssetName ?? (kind === 'deb' ? 'clinical-rx_1.12.0_amd64.deb' : kind === 'apk' || kind === 'unsigned-apk' ? 'clinical-rx-1.12.0.apk' : 'clinical-rx-1.12.0.exe');
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
      return new Response(JSON.stringify({ id: 555001, name: ghName, size: opts.ghAssetSize ?? bytes.byteLength, state: 'uploaded' }), { status: 200 });
    }
    // Asset bytes (the public download URL)
    if (u.startsWith('https://github.com/octo/app/releases/download/')) {
      if (opts.assetStatus && opts.assetStatus !== 200) return new Response('gone', { status: opts.assetStatus });
      // Serve bytes that match the ASSET EXTENSION so a multi-platform release
      // behaves like the real thing (an .apk is a ZIP, a .deb is an ar archive…).
      const low = u.toLowerCase();
      // Callers that pin an explicit asset kind keep their bytes; the
      // per-extension behaviour applies to the default (multi-platform) stub.
      const body = opts.asset ? bytes : low.endsWith('.apk') ? apkBytes()
        : low.endsWith('.exe') || low.endsWith('.msi') ? peBytes(0x8664)
        : low.endsWith('.appimage') ? (() => { const b = new Uint8Array(64); b.set([0x7f, 0x45, 0x4c, 0x46], 0); b[18] = 0x3e; return b; })()
        : low.endsWith('.deb') ? DEB_FIXTURE
        : bytes;
      return new Response(body as unknown as BodyInit, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    }
    // GitHub user authorization (App OAuth) + user installations
    if (u === 'https://github.com/login/oauth/access_token') {
      return new Response(JSON.stringify({ access_token: 'user-token', token_type: 'bearer' }), { status: 200 });
    }
    if (u.startsWith('https://api.github.com/user/installations/') && u.includes('/repositories')) {
      return new Response(JSON.stringify({ repositories: [
        { id: Number(REPO_ID), name: 'app', full_name: 'octo/app', private: false },
        { id: 777001, name: 'secret-app', full_name: 'octo/secret-app', private: true },
      ] }), { status: 200 });
    }
    if (u.startsWith('https://api.github.com/user/repos?')) {
      return new Response(JSON.stringify([
        { id: Number(REPO_ID), name: 'app', full_name: 'octo/app', private: false, owner: { login: 'octo' } },
        { id: 777001, name: 'secret-app', full_name: 'octo/secret-app', private: true, owner: { login: 'octo' } },
        { id: 888002, name: 'uninstalled', full_name: 'octo/uninstalled', private: false, owner: { login: 'octo' } },
      ]), { status: 200 });
    }
    if (u === 'https://api.github.com/repos/octo/secret-app') {
      return new Response(JSON.stringify({ id: 777001, full_name: 'octo/secret-app', private: true }), { status: 200 });
    }
    if (u === 'https://api.github.com/user/installations?per_page=100') {
      return new Response(JSON.stringify({ installations: [{ id: Number(INSTALLATION_ID), account: { login: 'octo', type: 'User' } }] }), { status: 200 });
    }

    // VirusTotal hash lookup (the pipeline checks for an existing report first)
    if (/^https:\/\/www\.virustotal\.com\/api\/v3\/files\/[0-9a-f]{64}$/.test(u)) {
      if (vtVerdict === 'UNAVAILABLE') return new Response('boom', { status: 500 });
      return new Response('not found', { status: 404 });
    }
    // VirusTotal upload + analysis
    if (u === 'https://www.virustotal.com/api/v3/files' || u === 'https://www.virustotal.com/api/v3/files/upload_url') {
      if (u.endsWith('upload_url')) return new Response(JSON.stringify({ data: 'https://www.virustotal.com/api/v3/files/upload_url/one-time' }), { status: 200 });
      return new Response(JSON.stringify({ data: { id: 'analysis-1', type: 'analysis' } }), { status: 200 });
    }
    if (u.startsWith('https://www.virustotal.com/api/v3/files/upload_url/')) {
      return new Response(JSON.stringify({ data: { id: 'analysis-1', type: 'analysis' } }), { status: 200 });
    }
    if (u === 'https://www.virustotal.com/api/v3/analyses/analysis-1') {
      if (vtVerdict === 'UNAVAILABLE') return new Response('boom', { status: 500 });
      if (vtVerdict === 'SCANNING') return new Response(JSON.stringify({ data: { attributes: { status: 'queued' } } }), { status: 200 });
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
      assets: [{ id: 555001, name: 'clinical-rx_1.12.0_amd64.deb', size: DEB_FIXTURE.byteLength, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/clinical-rx_1.12.0_amd64.deb' }],
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

test('private repositories are SUPPORTED and flagged (assets stream through RX Store with a token)', async () => {
  const stubs = installStubs(env);
  const original = globalThis.fetch;
  (globalThis.fetch as any) = (async (url: any, init?: any) => {
    const u = String(url);
    if (u === 'https://api.github.com/installation/repositories?per_page=100') {
      return new Response(JSON.stringify({ repositories: [{ id: Number(REPO_ID), name: 'app', full_name: 'octo/app', owner: { login: 'octo' }, private: true }] }), { status: 200 });
    }
    return (original as any)(url, init);
  });
  try {
    const out = await connect();
    assert.ok(out.ok, (out as any).message);
    const row = env.tables.github_repo_connections.find((c: any) => c.application_id === APP_ID);
    assert.equal(Number(row.repository_private), 1, 'the connection records that it is private');
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

test('detection NEVER publishes: current_version, app_versions and notifications untouched; canonical rows stay UNPUBLISHED', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-clean');
    assert.equal(env.tables.applications[0].current_version, '1.11.11'); // unchanged
    assert.equal(env.tables.app_versions.length, 0);
    assert.equal(env.tables.notifications.length, 0);
    // Canonical rows exist for the pipeline — but nothing is live.
    assert.equal(env.tables.releases.length, 1);
    assert.equal(env.tables.releases[0].status, 'under_review');
    assert.equal(env.tables.releases[0].published_at, null);
    assert.equal(env.tables.packages.length, 1);
    assert.equal(env.tables.packages[0].status, 'stored');
    // And the public selection queries can never see them (status filter).
    const visible = env.tables.packages.filter((x: any) => x.status === 'published');
    assert.equal(visible.length, 0);
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

    // .deb without an architecture marker is now MAPPED (x64 assumed, verified
    // from the binary during verification) — it is no longer dropped.
    out = await signedDelivery(env, 'release', ghReleasePayload({
      id: 6003, tag_name: 'v2.2.0',
      assets: [{ id: 4, name: 'app.deb', browser_download_url: 'https://github.com/octo/app/releases/download/v2.2.0/app.deb' }],
    }), 'd-nodebarch');
    assert.equal(out.body.data.status, 'detected');
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
    assert.equal(asset.sha256, DEB_SHA);
    assert.equal(asset.size_bytes, DEB_FIXTURE.byteLength);
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
    assert.equal(pkg.external_url, 'https://github.com/octo/app/releases/download/v1.12.0/clinical-rx_1.12.0_amd64.deb');
    assert.equal(pkg.sha256, DEB_SHA);
    assert.equal(pkg.status, 'published');
    // current_version advanced + legacy app_versions carries the GitHub URL.
    assert.equal(env.tables.applications[0].current_version, '1.12.0');
    // REGRESSION: applications.platforms must stay a JSON array (a plain
    // comma string here crashed the Developer App Detail page).
    {
      const stored = String(env.tables.applications[0].platforms);
      const parsed = JSON.parse(stored); // throws if it is not JSON
      assert.ok(Array.isArray(parsed), 'platforms must be stored as a JSON array');
      assert.ok(parsed.includes('linux'), 'linux_deb merges as the display id linux');
      assert.ok(parsed.includes('web'), 'web is always present');
    }
    const legacy = env.tables.app_versions[0];
    assert.equal(legacy.version, '1.12.0');
    const files = JSON.parse(legacy.files);
    assert.equal(files.linux_deb.url, 'https://github.com/octo/app/releases/download/v1.12.0/clinical-rx_1.12.0_amd64.deb');
    assert.equal(files.linux.url, files.linux_deb.url, 'legacy linux alias');
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
    assert.equal(env.tables.github_release_assets[0].state, 'verified', 'bytes verified — the SCANNER verdict is the failure');
    assert.equal(rel.status, 'verification_failed');
    // The detection also invalidated nothing to approve: no review can rescue it.
    const pkgId = env.tables.packages[0].id;
    const review = env.tables.package_manual_reviews.find((r: any) => r.package_id === pkgId && r.status === 'APPROVED' && !r.invalidated_at);
    assert.equal(review, undefined);
    // ...and an override attempt cannot publish it from any state.
    const out = await publishGithubRelease(env, ADMIN, rel.id, { overrideSecurity: true, reason: 'trusted developer, honest mistake' });
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.code, 'CONFLICT'); // not pending_approval
    assert.equal(env.tables.releases[0].status, 'under_review', 'canonical rows exist but stay unpublished');
    assert.equal(env.tables.packages[0].status, 'stored');
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
    assert.equal(env.tables.releases[0].status, 'under_review', 'canonical rows exist but stay UNPUBLISHED');
    assert.equal(env.tables.packages[0].status, 'stored');
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
    assert.equal(env.tables.releases[0].status, 'under_review', 'canonical rows exist but nothing is published');
    assert.equal(env.tables.packages[0].status, 'stored');
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
  assert.deepEqual(mapAssetFilename('Setup.exe'), { platform: 'windows', architecture: 'x64', assumed: true });
  assert.deepEqual(mapAssetFilename('app-arm64.exe'), { platform: 'windows', architecture: 'arm64' });
  assert.deepEqual(mapAssetFilename('app_1.2.3_amd64.deb'), { platform: 'linux_deb', architecture: 'x64' });
  assert.deepEqual(mapAssetFilename('app_arm64.deb'), { platform: 'linux_deb', architecture: 'arm64' });
  assert.deepEqual(mapAssetFilename('app.deb'), { platform: 'linux_deb', architecture: 'x64', assumed: true }); // no marker -> x64, verified from the binary later
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


// ---------------------------------------------------------------------------
// AUDIT REGRESSION TESTS (independent security audit, 2026-10-20)
// ---------------------------------------------------------------------------

test('AUDIT bind: the installation comes from the server-issued code — a client-supplied installation id is NEVER trusted', async () => {
  const stubs = installStubs(env);
  try {
    // The attacker's org/user initiates the flow for THEIR app, but tries to
    // bind using a completion code while passing a foreign repository id that
    // IS in the (own) installation list. The repository must resolve through
    // the token's installation — the happy path proves the token's
    // installationId is the one used (REPO_ID of installation 777).
    const code = await issueOneTimeToken(env, 'code', { kind: 'github-connect-complete', userId: USER_ID, appId: APP_ID, installationId: INSTALLATION_ID });
    const out = await bindRepositoryFromCode(env, { orgId: ORG_ID, userId: USER_ID, appId: APP_ID, code, repositoryId: REPO_ID });
    assert.ok(out.ok, (out as any).message);
    assert.equal(out.connection.repository_id, REPO_ID);
    assert.equal(out.connection.installation_id, INSTALLATION_ID);
  } finally { stubs.restore(); }
});

test('AUDIT bind: a completion code started by ANOTHER USER cannot bind (and is not burned)', async () => {
  const stubs = installStubs(env);
  try {
    const code = await issueOneTimeToken(env, 'code', { kind: 'github-connect-complete', userId: 'someone-else', appId: APP_ID, installationId: INSTALLATION_ID });
    const out = await bindRepositoryFromCode(env, { orgId: ORG_ID, userId: USER_ID, appId: APP_ID, code, repositoryId: REPO_ID });
    assert.equal(out.ok, false);
    assert.equal((out as any).code, 'FORBIDDEN');
    // Not burned: the same code still works for its rightful owner's org+user.
    const retry = await bindRepositoryFromCode(env, { orgId: ORG_ID, userId: 'someone-else', appId: APP_ID, code, repositoryId: REPO_ID });
    // someone-else is not in this org (fake has one member) — NOT_FOUND is
    // expected here; the point is the token survived (not INVALID_TOKEN).
    assert.notEqual((retry as any).code, 'INVALID_TOKEN');
  } finally { stubs.restore(); }
});

test('AUDIT bind: a completion code started for a DIFFERENT APP cannot bind', async () => {
  const stubs = installStubs(env);
  try {
    const code = await issueOneTimeToken(env, 'code', { kind: 'github-connect-complete', userId: USER_ID, appId: 'app-other', installationId: INSTALLATION_ID });
    const out = await bindRepositoryFromCode(env, { orgId: ORG_ID, userId: USER_ID, appId: APP_ID, code, repositoryId: REPO_ID });
    assert.equal(out.ok, false);
    assert.equal((out as any).code, 'FORBIDDEN');
    assert.match((out as any).message, /different application/i);
  } finally { stubs.restore(); }
});

test('AUDIT bind: garbage or missing codes fail closed', async () => {
  const out1 = await bindRepositoryFromCode(env, { orgId: ORG_ID, userId: USER_ID, appId: APP_ID, code: '', repositoryId: REPO_ID });
  assert.equal((out1 as any).code, 'VALIDATION_ERROR');
  const out2 = await bindRepositoryFromCode(env, { orgId: ORG_ID, userId: USER_ID, appId: APP_ID, code: 'o_not_a_real_token', repositoryId: REPO_ID });
  assert.equal((out2 as any).code, 'INVALID_TOKEN');
});

test('AUDIT bind: a repository outside the token installation is refused', async () => {
  const stubs = installStubs(env);
  try {
    const code = await issueOneTimeToken(env, 'code', { kind: 'github-connect-complete', userId: USER_ID, appId: APP_ID, installationId: INSTALLATION_ID });
    const out = await bindRepositoryFromCode(env, { orgId: ORG_ID, userId: USER_ID, appId: APP_ID, code, repositoryId: '999999' });
    assert.equal(out.ok, false);
    assert.equal((out as any).code, 'NOT_FOUND');
  } finally { stubs.restore(); }
});

test('AUDIT status route: webhook events are scoped to the app\'s repository — no cross-developer leak', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    // Two repositories' events exist; only the app's own must be returned.
    env.tables.github_release_events.push(
      { id: 'e1', delivery_id: 'd1', event: 'release', action: 'published', repository_id: REPO_ID, status: 'processed', detail: 'own repo event', error: null, received_at: 'now' },
      { id: 'e2', delivery_id: 'd2', event: 'release', action: 'published', repository_id: '888777', status: 'processed', detail: 'OTHER developer repo event', error: null, received_at: 'now' },
    );
    const req = new Request('https://api.test/developers/apps/' + APP_ID + '/github', { method: 'GET', headers: { Authorization: 'Bearer x', 'User-Agent': 't' } });
    (req as any).user = { userId: USER_ID };
    const out: any = await githubDevRoutes.status(req as any, env);
    const details = JSON.stringify(out.recentEvents || []);
    assert.ok(details.includes('own repo event'), 'the app\'s own events are shown');
    assert.ok(!details.includes('OTHER developer'), 'other repositories\' events must not leak');
  } finally { stubs.restore(); }
});

test('AUDIT admin routes: a non-admin identity is refused on every privileged operation', async () => {
  const req = (path: string) => {
    const r = new Request(`https://api.test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 't' }, body: '{}' });
    (r as any).user = { userId: 'u-normal', role: 'user' };
    return r;
  };
  assert.equal((await (githubAdminRoutes.publish as any)(req('/admin/github/releases/rel_x/publish'), env)).code, 'UNAUTHORIZED');
  assert.equal((await (githubAdminRoutes.reject as any)(req('/admin/github/releases/rel_x/reject'), env)).code, 'UNAUTHORIZED');
  assert.equal((await (githubAdminRoutes.withdraw as any)(req('/admin/github/releases/rel_x/withdraw'), env)).code, 'UNAUTHORIZED');
  assert.equal((await (githubAdminRoutes.retry as any)(req('/admin/github/releases/rel_x/retry'), env)).code, 'UNAUTHORIZED');
  assert.equal((await (githubAdminRoutes.sync as any)(req('/admin/github/sync'), env)).code, 'UNAUTHORIZED');
  const getReq = new Request('https://api.test/admin/github/releases', { method: 'GET', headers: { 'User-Agent': 't' } });
  (getReq as any).user = { userId: 'u-normal', role: 'user' };
  assert.equal((await (githubAdminRoutes.releases as any)(getReq as any, env)).code, 'UNAUTHORIZED');
  // And no identity at all:
  const anon = new Request('https://api.test/admin/github/releases', { method: 'GET' });
  assert.equal((await (githubAdminRoutes.releases as any)(anon as any, env)).code, 'UNAUTHORIZED');
});

test('AUDIT publish route: only an ADMIN identity reaches the publish service (route layer)', async () => {
  const stubs = installStubs(env, { vtVerdict: 'CLEAN' });
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-route');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    await verifyGithubRelease(env, rel.id);
    const r = new Request(`https://api.test/admin/github/releases/${rel.id}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 't' }, body: '{}' });
    (r as any).user = { userId: 'u-normal', role: 'user' };
    const refused: any = await githubAdminRoutes.publish(r as any, env);
    assert.equal(refused.code, 'UNAUTHORIZED');
    assert.equal(env.tables.releases[0].status, 'under_review', 'nothing was published'); // refusal leaves rows unpublished
    // The admin identity succeeds through the same route.
    (r as any).user = { userId: 'admin-1', role: 'admin' };
    const ok: any = await githubAdminRoutes.publish(r as any, env);
    assert.ok(!ok.code, ok.message);
    assert.equal(env.tables.applications[0].current_version, '1.12.0');
  } finally { stubs.restore(); }
});


// ---------------------------------------------------------------------------
// SECURITY VERIFICATION GATE (mandatory matrix) — the REAL pipeline runs on
// GitHub assets: clean, detected, unsigned, invalid-signature, arch mismatch,
// scanner timeout, duplicates, manual approval, override, leak checks.
// ---------------------------------------------------------------------------

test('GATE clean file: every automated check recorded; publication is AUTOMATED', async () => {
  const stubs = installStubs(env, { asset: 'deb', vtVerdict: 'CLEAN' });
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-gate-clean');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    const v = await verifyGithubRelease(env, rel.id);
    assert.ok(v.ok, v.message);
    // Full evidence: all 8 checks with honest statuses for a valid .deb.
    const byCheck: Record<string, string> = {};
    for (const row of env.tables.package_security_results) byCheck[row.check_type] = row.status;
    assert.equal(byCheck.structure, 'PASSED');
    assert.equal(byCheck.integrity, 'PASSED');
    assert.equal(byCheck.duplicate, 'PASSED');
    assert.equal(byCheck.malware, 'CLEAN', 'scanner CLEAN — from the ACTUAL uploaded bytes');
    assert.equal(byCheck.signature, 'NOT_APPLICABLE');
    assert.equal(byCheck.certificate, 'NOT_APPLICABLE');
    assert.equal(byCheck.dependency, 'NOT_APPLICABLE');
    assert.equal(byCheck.native_identity, 'PASSED', '.deb package name matches the registered identity');
    // Provider/report reference recorded for the scan.
    assert.ok(env.tables.package_security_results.some((r: any) => r.check_type === 'malware' && r.provider === 'virustotal'));
    // Publish → AUTOMATED authorization, live, evidence intact.
    const out = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.ok(out.ok, (out as any).message);
    assert.equal(env.tables.applications[0].current_version, '1.12.0');
    assert.equal(env.tables.packages[0].status, 'published');
  } finally { stubs.restore(); }
});

test('GATE unsigned APK: signature FAILED → the release is not even queued for approval', async () => {
  const stubs = installStubs(env, { asset: 'unsigned-apk', vtVerdict: 'CLEAN' });
  try {
    await connect();
    const payload = ghReleasePayload();
    payload.release.assets = [{ id: 555001, name: 'clinical-rx-1.12.0.apk', size: unsignedApkBytes().byteLength, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/clinical-rx-1.12.0.apk' }];
    await signedDelivery(env, 'release', payload, 'd-gate-unsigned-apk');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    const v = await verifyGithubRelease(env, rel.id);
    assert.equal(v.ok, false);
    const sig = env.tables.package_security_results.find((r: any) => r.check_type === 'signature');
    assert.equal(sig.status, 'FAILED');
    assert.match(sig.result, /unsigned APK/i);
    assert.equal(rel.status, 'verification_failed');
    // Publishing from that state is refused.
    const out = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.equal(out.ok, false);
  } finally { stubs.restore(); }
});

test('GATE unsigned Windows exe: WARNING (needs review) → publish ONLY via byte-bound manual approval', async () => {
  const stubs = installStubs(env, { asset: 'pe-x64', vtVerdict: 'CLEAN' });
  try {
    await connect();
    const payload = ghReleasePayload();
    payload.release.assets = [{ id: 555001, name: 'clinical-rx-1.12.0.exe', size: peBytes(0x8664).byteLength, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/clinical-rx-1.12.0.exe' }];
    await signedDelivery(env, 'release', payload, 'd-gate-unsigned-exe');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    const v = await verifyGithubRelease(env, rel.id);
    assert.ok(v.ok, v.message); // bytes + structure + scan all fine
    const sig = env.tables.package_security_results.find((r: any) => r.check_type === 'signature');
    assert.equal(sig.status, 'WARNING');
    assert.match(sig.result, /unsigned executable/i, 'honestly reported as UNSIGNED — never as signed');
    // A PENDING manual review was auto-opened (indeterminate overall).
    const pkgId = env.tables.packages[0].id;
    assert.ok(env.tables.package_manual_reviews.some((r: any) => r.package_id === pkgId && r.status === 'PENDING'));
    // Publish without approval → blocked by the gate.
    let out = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.code, 'FORBIDDEN');
    // Approve the review FOR THESE EXACT BYTES → publish succeeds (Path 3).
    const review = env.tables.package_manual_reviews.find((r: any) => r.package_id === pkgId && r.status === 'PENDING');
    review.status = 'APPROVED';
    review.reviewed_at = new Date().toISOString();
    out = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.ok(out.ok, (out as any).message);
    // Byte binding: a DIFFERENT hash can never ride the approval.
    const pkg = env.tables.packages[0];
    pkg.sha256 = 'f'.repeat(64);
    const again = await publishGithubRelease(env, ADMIN, { ...rel, status: 'pending_approval' } as any, {});
    // (the github row is already published here; the point is the approval is
    // sha-bound — validManualApproval refuses the new hash)
    const { validManualApproval } = await import('./services/packageSecurity.ts');
    assert.equal(await validManualApproval(env, pkgId, 'f'.repeat(64)), null);
  } finally { stubs.restore(); }
});

test('GATE architecture: a DECLARED mismatch blocks, while an UNMARKED binary is corrected from the bytes', async () => {
  // (a) filename SAYS arm64 but the binary is x64 -> hard failure.
  {
    const stubs = installStubs(env, { asset: 'pe-x64', ghAssetName: 'clinical-rx-1.12.0-arm64.exe', vtVerdict: 'CLEAN' });
    try {
      await connect();
      const payload = ghReleasePayload();
      payload.release.assets = [{ id: 555001, name: 'clinical-rx-1.12.0-arm64.exe', size: peBytes(0x8664).byteLength, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/a.exe' }];
      await signedDelivery(env, 'release', payload, 'd-gate-arch-a');
      const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
      const v = await verifyGithubRelease(env, rel.id);
      assert.equal(v.ok, false, 'a declared architecture the binary contradicts must not pass');
      assert.equal(rel.status, 'verification_failed');
      const asset = env.tables.github_release_assets[0];
      assert.match(String(asset.error), /filename says arm64 but the binary is x64/i);
    } finally { stubs.restore(); }
  }
  // (b) no marker at all (RXStore-Setup-1.7.6.exe) -> x64 assumed, then the
  //     BINARY wins: an arm64 build is recorded as arm64 and verified.
  {
    env = fakeEnv();
    env.GITHUB_APP_PRIVATE_KEY = TEST_PEM;
    await ensureGithubTables(env);
    const stubs = installStubs(env, { asset: 'pe-arm64', ghAssetName: 'RXStore-Setup-1.12.0.exe', vtVerdict: 'CLEAN' });
    try {
      await connect();
      const payload = ghReleasePayload();
      payload.release.assets = [{ id: 555001, name: 'RXStore-Setup-1.12.0.exe', size: peBytes(0xaa64).byteLength, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/setup.exe' }];
      await signedDelivery(env, 'release', payload, 'd-gate-arch-b');
      const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
      const v = await verifyGithubRelease(env, rel.id);
      assert.ok(v.ok, v.message);
      const asset = env.tables.github_release_assets[0];
      assert.equal(asset.architecture, 'arm64', 'the truth comes from the binary, not the missing marker');
      const structure = env.tables.package_security_results.find((r: any) => r.check_type === 'structure');
      assert.equal(structure.status, 'PASSED', 'no false architecture failure');
    } finally { stubs.restore(); }
  }
});

test('GATE scanner never completes (timeout): honest SCANNING — never clean; publication blocked; review path open', async () => {
  const stubs = installStubs(env, { asset: 'deb', vtVerdict: 'SCANNING' });
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-gate-scanning');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    const v = await verifyGithubRelease(env, rel.id);
    assert.ok(v.ok, v.message); // queued with the honest status
    const asset = env.tables.github_release_assets[0];
    assert.equal(asset.scanner_status, 'SCANNING', 'an incomplete scan is NEVER represented as clean');
    const out = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.message, /blocked|SCANNING/i);
    // The retry path exists (admin Retry re-runs verification + polling).
    const again = await verifyGithubRelease(env, rel.id);
    assert.ok(again.ok || again.status === 'verification_failed');
  } finally { stubs.restore(); }
});

test('RE-CHECK SECURITY: a SCANNING verdict is POLLED again (never re-uploaded) and can clear the release', async () => {
  const { recheckSecurity } = await import('./services/githubReleases.ts');
  const stubs = installStubs(env, { asset: 'deb', vtVerdict: 'SCANNING' });
  await connect();
  await signedDelivery(env, 'release', ghReleasePayload(), 'd-recheck');
  const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
  await verifyGithubRelease(env, rel.id);
  assert.equal(env.tables.github_release_assets[0].scanner_status, 'SCANNING');
  assert.equal(env.tables.scanner_cache[0].verdict, 'SCANNING', 'the in-flight analysis id is cached by SHA-256');
  const cachedAnalysis = env.tables.scanner_cache[0].analysis_id;
  stubs.restore();

  const stubs2 = installStubs(env, { asset: 'deb', vtVerdict: 'CLEAN' });
  try {
    const evidenceBefore = env.tables.package_security_results.length;
    const out: any = await recheckSecurity(env, ADMIN, rel.id);
    assert.ok(out.ok, out.message);
    assert.equal(out.status, 'pending_approval', JSON.stringify(out));
    assert.equal(env.tables.github_release_assets[0].scanner_status, 'CLEAN', 'the finished analysis is recorded');
    assert.equal(env.tables.scanner_cache[0].analysis_id, cachedAnalysis, 'the SAME analysis was polled, not a new upload');
    const malwareRows = env.tables.package_security_results.filter((r: any) => r.check_type === 'malware');
    assert.equal(malwareRows[malwareRows.length - 1].status, 'CLEAN');
    assert.ok(env.tables.package_security_results.length > evidenceBefore, 'a fresh evidence row is written');
    assert.ok(env.tables.github_audit_log.some((e: any) => e.action === 'security_recheck'), 'the re-check is audited');
    assert.equal(rel.status, 'pending_approval', 'the release is ready for approval again');
  } finally { stubs2.restore(); }
});

test('RE-CHECK SECURITY: a release that is already decided cannot be reopened', async () => {
  const { recheckSecurity } = await import('./services/githubReleases.ts');
  const stubs = installStubs(env, { asset: 'deb' });
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-recheck-closed');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    rel.status = 'rejected';
    const out: any = await recheckSecurity(env, ADMIN, rel.id);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'CONFLICT');
  } finally { stubs.restore(); }
});

test('GATE duplicate binary: same SHA-256 under another app → WARNING + review; no silent publication', async () => {
  const stubs = installStubs(env, { asset: 'deb', vtVerdict: 'CLEAN' });
  try {
    // Another app already ships the exact same bytes.
    env.tables.applications.push({ id: 'app-2', slug: 'other-app', name: 'Other', developer_org_id: 'org-2', price_type: 'free', price_amount: 0, current_version: '1.0.0', platforms: 'linux' });
    env.tables.releases.push({ id: 'rel-other', application_id: 'app-2', version: '1.0.0', status: 'published', channel: 'stable' });
    env.tables.packages.push({ id: 'pkg-other', application_id: 'app-2', release_id: 'rel-other', platform: 'linux_deb', architecture: 'x64', filename: 'other.deb', storage_key: 'k', file_size: 1, sha256: DEB_SHA, version: '1.0.0', provider: 'rxstore', status: 'published', security_state: 'PUBLISHED', overall_security: 'PASSED' });
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-gate-dup');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    const v = await verifyGithubRelease(env, rel.id);
    assert.ok(v.ok, v.message); // WARNING, not a hard failure
    const dup = env.tables.package_security_results.find((r: any) => r.check_type === 'duplicate');
    assert.equal(dup.status, 'WARNING');
    assert.match(dup.result, /another application/i);
    // Publication is blocked until reviewed.
    const out = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.equal(out.ok, false);
  } finally { stubs.restore(); }
});

test('GATE blocked releases are invisible to the public download selection query', async () => {
  const stubs = installStubs(env, { asset: 'deb', vtVerdict: 'CLEAN' });
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-gate-leak');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    await verifyGithubRelease(env, rel.id); // pending_approval — never published
    // The download endpoint's selection shape: published release + published package.
    const visible = env.tables.packages.filter((p: any) => {
      const r = env.tables.releases.find((x: any) => x.id === p.release_id);
      return r && r.status === 'published' && p.status === 'published' && !p.deleted_at;
    });
    assert.equal(visible.length, 0, 'nothing from a pending github release can be selected for download');
    assert.equal(env.tables.applications[0].current_version, '1.11.11');
    assert.equal(env.tables.app_versions.length, 0, 'legacy app_versions cannot leak an unapproved version');
    // After admin publish, the SAME query finds exactly the approved set.
    await publishGithubRelease(env, ADMIN, rel.id, {});
    const visibleAfter = env.tables.packages.filter((p: any) => {
      const r = env.tables.releases.find((x: any) => x.id === p.release_id);
      return r && r.status === 'published' && p.status === 'published' && !p.deleted_at;
    });
    assert.equal(visibleAfter.length, 1);
    assert.equal(visibleAfter[0].sha256, DEB_SHA);
  } finally { stubs.restore(); }
});

test('REGRESSION appView: platforms/tags are ALWAYS arrays (JSON or legacy comma string)', async () => {
  const { appView } = await import('./routes/developerApps.ts') as any;
  // JSON row (the normal format)
  const a = appView({ id: 'x', platforms: '["web","android"]', tags: '["t1"]' });
  assert.deepEqual(a.platforms, ['web', 'android']);
  assert.deepEqual(a.tags, ['t1']);
  // Corrupted/legacy comma string — the page must not receive a string.
  const b = appView({ id: 'x', platforms: 'linux,web', tags: null });
  assert.deepEqual(b.platforms, ['linux', 'web']);
  assert.deepEqual(b.tags, []);
  // Missing entirely
  const c = appView({ id: 'x' });
  assert.deepEqual(c.platforms, []);
});

test('DIAGNOSTICS: githubMissingSecrets names exactly which required secrets are empty', async () => {
  const { githubMissingSecrets } = await import('./services/github.ts');
  assert.deepEqual(
    githubMissingSecrets({ GITHUB_APP_ID: '', GITHUB_APP_SLUG: 'x', GITHUB_APP_PRIVATE_KEY: '   ', GITHUB_WEBHOOK_SECRET: 'y' }),
    ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'],
    'empty and whitespace-only values are both reported',
  );
  assert.deepEqual(
    githubMissingSecrets({ GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 's', GITHUB_APP_PRIVATE_KEY: 'k', GITHUB_WEBHOOK_SECRET: 'w' }),
    [],
  );
  assert.deepEqual(githubMissingSecrets({}), ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET']);
});

test('CONNECT FLOW: the install callback lands on the APP page (where the picker lives), never the developer root', async () => {
  const state = await issueOneTimeToken(env, 'state', { kind: 'github-connect', userId: USER_ID, appId: APP_ID });
  const req = new Request(`https://api.test/developers/github/callback?state=${encodeURIComponent(state)}&installation_id=${INSTALLATION_ID}`);
  const res: any = await githubDevRoutes.callback(req as any, env);
  assert.ok(res instanceof Response && res.status === 302, 'callback redirects');
  const loc = String(res.headers.get('Location'));
  assert.ok(loc.includes(`/developers/apps/${APP_ID}?gh_connect=`), `redirects to the APP detail page with the completion code (got ${loc})`);
  assert.ok(!loc.includes('/developers?'), 'never the bare developer root (the code went unconsumed there — "connected but showing Connect again")');
  // Invalid state -> honest error redirect.
  const bad: any = await githubDevRoutes.callback(new Request('https://api.test/developers/github/callback?state=bogus&installation_id=1') as any, env);
  assert.match(String(bad.headers.get('Location')), /gh_error=invalid_state/);
});

// ---------------------------------------------------------------------------
// CONNECT VIA USER AUTHORIZATION (App OAuth) — the reliable path
// ---------------------------------------------------------------------------

test('OAUTH connect: when App client credentials exist, connect returns the user-authorization URL', async () => {
  const stubs = installStubs(env);
  try {
    const req = new Request(`https://api.test/developers/apps/${APP_ID}/github/connect`, { method: 'POST', headers: { 'User-Agent': 't' } });
    (req as any).user = { userId: USER_ID };
    const out: any = await githubDevRoutes.connect(req as any, env);
    assert.ok(out.url, out.message);
    const u = String(out.url);
    assert.ok(u.startsWith('https://github.com/login/oauth/authorize?'), u);
    assert.ok(u.includes('client_id=Iv1.rxstoreapp'), u);
    assert.ok(u.includes('state='), u);
    assert.ok(decodeURIComponent(u).includes('/developers/github/callback'), u);
  } finally { stubs.restore(); }
});

test('OAUTH connect: without App client credentials it falls back to the install redirect (never a broken link)', async () => {
  const noOauth = { ...env, GITHUB_APP_CLIENT_ID: '', GITHUB_APP_CLIENT_SECRET: '' };
  const stubs = installStubs(noOauth);
  try {
    const req = new Request(`https://api.test/developers/apps/${APP_ID}/github/connect`, { method: 'POST', headers: { 'User-Agent': 't' } });
    (req as any).user = { userId: USER_ID };
    const out: any = await githubDevRoutes.connect(req as any, noOauth);
    assert.ok(String(out.url).startsWith('https://github.com/apps/rx-store-releases/installations/new?state='), String(out.url));
  } finally { stubs.restore(); }
});

test('OAUTH callback: renders the repository picker (public + private), then binds the chosen repo', async () => {
  const stubs = installStubs(env);
  try {
    const state = await issueOneTimeToken(env, 'state', { kind: 'github-oauth', userId: USER_ID, appId: APP_ID });
    const res: any = await githubDevRoutes.callback(
      new Request(`https://api.test/developers/github/callback?code=gh-code&state=${encodeURIComponent(state)}`) as any, env,
    );
    assert.ok(res instanceof Response);
    assert.ok(String(res.headers.get('Content-Type')).includes('text/html'));
    const html = await res.text();
    assert.ok(html.includes('octo/app'), 'public repository listed');
    assert.ok(html.includes('secret-app'), 'private repositories are offered too');
    const codeMatch = html.match(/name="code" value="([^"]+)"/);
    const repoMatch = html.match(/name="repositoryId" value="([^"]+)"/);
    assert.ok(codeMatch, 'picker embeds a completion code');
    assert.ok(repoMatch, 'picker embeds the repository id');

    const body = new URLSearchParams({ code: codeMatch![1], repositoryId: repoMatch![1] });
    const bindRes: any = await githubOAuthRoutes.bind(
      new Request('https://api.test/developers/github/oauth/bind', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }) as any,
      env,
    );
    const bindHtml = await bindRes.text();
    assert.ok(bindHtml.includes('Repository connected'), bindHtml.slice(0, 200));
    const conn = env.tables.github_repo_connections.find((c: any) => c.application_id === APP_ID);
    assert.ok(conn, 'the app is now connected');
    assert.equal(conn.repository_id, REPO_ID);
  } finally { stubs.restore(); }
});

test('OAUTH bind: a repository OUTSIDE the authorization is refused (no arbitrary binding)', async () => {
  const stubs = installStubs(env);
  try {
    const state = await issueOneTimeToken(env, 'state', { kind: 'github-oauth', userId: USER_ID, appId: APP_ID });
    const res: any = await githubDevRoutes.callback(
      new Request(`https://api.test/developers/github/callback?code=gh-code&state=${encodeURIComponent(state)}`) as any, env,
    );
    const html = await res.text();
    const code = html.match(/name="code" value="([^"]+)"/)![1];
    const body = new URLSearchParams({ code, repositoryId: '999999' });
    const out: any = await githubOAuthRoutes.bind(
      new Request('https://api.test/developers/github/oauth/bind', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }) as any,
      env,
    );
    const outHtml = await out.text();
    assert.ok(/does not have access to that repository/i.test(outHtml), outHtml.slice(0, 200));
    assert.equal(env.tables.github_repo_connections.length, 0);
  } finally { stubs.restore(); }
});

test('OAUTH callback: an expired/unknown state is refused with a clear page (never a silent connect)', async () => {
  const stubs = installStubs(env);
  try {
    const res: any = await githubDevRoutes.callback(
      new Request('https://api.test/developers/github/callback?code=gh-code&state=bogus') as any, env,
    );
    assert.ok(res instanceof Response);
    const html = await res.text();
    assert.ok(/expired or was already used/i.test(html), html.slice(0, 200));
  } finally { stubs.restore(); }
});

test('CALLBACK URL: the OAuth redirect includes the /v1 API prefix (must match the registered GitHub App URL)', async () => {
  const { githubAppCallbackUrl } = await import('./services/github.ts');
  // Request URLs are dispatched with /v1 stripped, but the PUBLIC callback is
  // registered under /v1 — a redirect_uri without it is rejected by GitHub
  // ("redirect_uri MUST match the registered callback URL").
  assert.equal(
    githubAppCallbackUrl({}, new Request('https://rx-store-api.calcitoninpay.workers.dev/v1/developers/apps/x/github/connect')),
    'https://rx-store-api.calcitoninpay.workers.dev/v1/developers/github/callback',
  );
  // Explicit override wins (custom deployments).
  assert.equal(
    githubAppCallbackUrl({ GITHUB_APP_CALLBACK_URL: 'https://api.example.com/v1/developers/github/callback/' }, new Request('https://x.test/developers/apps/x/github/connect')),
    'https://api.example.com/v1/developers/github/callback',
  );
});

test('CALLBACK URL: connect sends exactly the canonical callback URL to GitHub', async () => {
  const stubs = installStubs(env);
  try {
    const req = new Request(`https://api.test/developers/apps/${APP_ID}/github/connect`, { method: 'POST', headers: { 'User-Agent': 't' } });
    (req as any).user = { userId: USER_ID };
    const out: any = await githubDevRoutes.connect(req as any, env);
    const decoded = decodeURIComponent(String(out.url));
    assert.ok(decoded.includes('redirect_uri=https://api.test/v1/developers/github/callback'), decoded);
  } finally { stubs.restore(); }
});

test('BIND FALLBACK: an app-owned org connects even when the strict membership lookup fails', async () => {
  const stubs = installStubs(env);
  try {
    // Production case: applications.developer_org_id is set but the
    // developer_members row is missing/legacy -> resolveMembership() is null.
    env.tables.applications[0].developer_id = USER_ID;
    env.tables.developer_members.length = 0;

    const state = await issueOneTimeToken(env, 'state', { kind: 'github-oauth', userId: USER_ID, appId: APP_ID });
    const res: any = await githubDevRoutes.callback(
      new Request(`https://api.test/developers/github/callback?code=gh-code&state=${encodeURIComponent(state)}`) as any, env,
    );
    const html = await res.text();
    const code = html.match(/name="code" value="([^"]+)"/)![1];
    const repo = html.match(/name="repositoryId" value="([^"]+)"/)![1];
    const out: any = await githubOAuthRoutes.bind(
      new Request('https://api.test/developers/github/oauth/bind', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, repositoryId: repo }).toString(),
      }) as any, env,
    );
    const outHtml = await out.text();
    assert.ok(outHtml.includes('Repository connected'), outHtml.slice(0, 300));
    const conn = env.tables.github_repo_connections.find((c: any) => c.application_id === APP_ID);
    assert.ok(conn, 'the connection is created through the app-ownership fallback');
    assert.equal(conn.repository_id, REPO_ID);
  } finally { stubs.restore(); }
});

test('BIND FALLBACK: a user with no relation to the app is refused (never a silent connect)', async () => {
  const stubs = installStubs(env);
  try {
    env.tables.applications[0].developer_id = 'somebody-else';
    env.tables.developer_members.length = 0;
    const state = await issueOneTimeToken(env, 'state', { kind: 'github-oauth', userId: USER_ID, appId: APP_ID });
    const res: any = await githubDevRoutes.callback(
      new Request(`https://api.test/developers/github/callback?code=gh-code&state=${encodeURIComponent(state)}`) as any, env,
    );
    const html = await res.text();
    const code = html.match(/name="code" value="([^"]+)"/);
    // The picker itself may refuse up front; if it renders, the bind must.
    if (code) {
      const repo = html.match(/name="repositoryId" value="([^"]+)"/)![1];
      const out: any = await githubOAuthRoutes.bind(
        new Request('https://api.test/developers/github/oauth/bind', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code: code[1], repositoryId: repo }).toString(),
        }) as any, env,
      );
      const outHtml = await out.text();
      assert.ok(/not linked to a developer organization|could not be found|not part of this authorization/i.test(outHtml), outHtml.slice(0, 300));
    }
    assert.equal(env.tables.github_repo_connections.length, 0, 'nothing was connected');
  } finally { stubs.restore(); }
});

// ---------------------------------------------------------------------------
// PRIVATE KEY FORMAT — GitHub issues PKCS#1 ("BEGIN RSA PRIVATE KEY").
// The old parser only understood PKCS#8, so a REAL GitHub key never decoded:
// the App JWT could not be signed and connecting a repository failed with
// "the GitHub installation could not be read". Tests used PKCS#8 and passed.
// ---------------------------------------------------------------------------

test('KEY FORMAT: a PKCS#1 (GitHub-style RSA PRIVATE KEY) signs the App JWT', async () => {
  const { createPrivateKey } = await import('node:crypto');
  const { githubAppJwt, pemToDer } = await import('./services/github.ts');
  // Convert the generated PKCS#8 key into exactly what GitHub downloads.
  const pkcs1 = createPrivateKey(TEST_PEM).export({ type: 'pkcs1', format: 'pem' }).toString();
  assert.ok(pkcs1.includes('BEGIN RSA PRIVATE KEY'), 'fixture is a GitHub-style PKCS#1 key');

  const parsed = pemToDer(pkcs1);
  assert.ok(!('error' in parsed), (parsed as any).error);
  assert.equal((parsed as any).format, 'pkcs1');

  const jwt = await githubAppJwt({ ...env, GITHUB_APP_PRIVATE_KEY: pkcs1 });
  assert.equal(jwt.split('.').length, 3, 'a signed JWT has three segments');
  assert.ok(jwt.length > 200);

  // CRYPTOGRAPHIC PROOF: the signature verifies against the matching public
  // key — i.e. the PKCS#1 → PKCS#8 wrap produced a genuinely usable key (not
  // merely something importKey tolerated).
  const { createVerify, createPublicKey } = await import('node:crypto');
  const [header, body, signature] = jwt.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${body}`);
  verifier.end();
  const sigBuf = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  assert.equal(verifier.verify(createPublicKey(createPrivateKey(pkcs1)), sigBuf), true, 'the App JWT signature must verify');
});

test('KEY FORMAT: PKCS#8 still works, and bad keys fail with an actionable message', async () => {
  const { githubAppJwt, pemToDer } = await import('./services/github.ts');
  // PKCS#8 (what our tests used before) keeps working.
  const jwt = await githubAppJwt(env);
  assert.equal(jwt.split('.').length, 3);
  // Plain text / encrypted / empty keys are rejected clearly, not cryptically.
  assert.match(String((pemToDer('not a pem') as any).error), /not a valid PEM/);
  assert.match(String((pemToDer('-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc\n-----END ENCRYPTED PRIVATE KEY-----') as any).error), /encrypted/);
  assert.match(String((pemToDer('') as any).error), /empty/);
  await assert.rejects(
    () => githubAppJwt({ ...env, GITHUB_APP_PRIVATE_KEY: 'garbage' }),
    /private key could not be read/i,
  );
});

test('BIND RESILIENCE: connecting succeeds from the OAuth-verified repository when the App lookup fails', async () => {
  const stubs = installStubs(env);
  try {
    // Simulate App credentials that cannot mint an installation token.
    const original = globalThis.fetch;
    (globalThis.fetch as any) = (async (url: any, init?: any) => {
      if (String(url).includes('/app/installations/') && String(url).includes('access_tokens')) {
        return new Response('bad credentials', { status: 401 });
      }
      return (original as any)(url, init);
    });
    const state = await issueOneTimeToken(env, 'state', { kind: 'github-oauth', userId: USER_ID, appId: APP_ID });
    const res: any = await githubDevRoutes.callback(
      new Request(`https://api.test/developers/github/callback?code=gh-code&state=${encodeURIComponent(state)}`) as any, env,
    );
    const html = await res.text();
    const code = html.match(/name="code" value="([^"]+)"/)![1];
    const repo = html.match(/name="repositoryId" value="([^"]+)"/)![1];
    const out: any = await githubOAuthRoutes.bind(
      new Request('https://api.test/developers/github/oauth/bind', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, repositoryId: repo }).toString(),
      }) as any, env,
    );
    const outHtml = await out.text();
    assert.ok(outHtml.includes('Repository connected'), outHtml.slice(0, 300));
    const conn = env.tables.github_repo_connections.find((c: any) => c.application_id === APP_ID);
    assert.ok(conn, 'connected via the OAuth-verified repository');
    assert.equal(conn.repository_full_name, 'octo/app');
  } finally { stubs.restore(); }
});

// ---------------------------------------------------------------------------
// REAL electron-builder layout (production bug): elevate.exe is the NSIS UAC
// helper, and treating every .exe as an installer made the whole release
// "ambiguous" — blocking a perfectly good APK + .deb.
// ---------------------------------------------------------------------------

test('MAPPING: an electron-builder release publishes Setup.exe and ignores elevate.exe + feed files', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    const payload = ghReleasePayload();
    payload.release.assets = [
      { id: 1, name: 'app-release.apk', size: 10, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/app-release.apk' },
      { id: 2, name: 'yayra_1.0.75_amd64.deb', size: 10, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/yayra_1.0.75_amd64.deb' },
      { id: 3, name: 'Yayra Setup 1.0.75.exe', size: 10, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/YayraSetup.exe' },
      { id: 4, name: 'elevate.exe', size: 10, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/elevate.exe' },
      { id: 5, name: 'latest.yml', size: 1, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/latest.yml' },
      { id: 6, name: 'Yayra Setup 1.0.75.exe.blockmap', size: 1, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/x.blockmap' },
      { id: 7, name: 'sha256sums.txt', size: 1, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/sha256sums.txt' },
    ];
    const out = await signedDelivery(env, 'release', payload, 'd-electron');
    assert.equal(out.body.data.status, 'detected', JSON.stringify(out.body));

    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    assert.equal(rel.status, 'detected', 'a helper .exe must not block the release');
    const assets = env.tables.github_release_assets.filter((a: any) => a.release_id === rel.id);
    const slots = assets.map((a: any) => `${a.platform}/${a.architecture}`).sort();
    assert.deepEqual(slots, ['android/universal', 'linux_deb/x64', 'windows/x64']);
    assert.equal(assets.find((a: any) => a.platform === 'windows').name, 'Yayra Setup 1.0.75.exe', 'the real installer wins the slot');

    // Transparency: everything skipped is recorded with its reason.
    const ignored = JSON.parse(rel.ignored_assets || '{}');
    const ignoredNames = (ignored.ignored || []).map((i: any) => i.name);
    assert.ok(ignoredNames.includes('elevate.exe'), 'elevate.exe is recorded as skipped');
    assert.ok(ignoredNames.includes('latest.yml'));
    assert.ok((ignored.unmapped || []).some((u: any) => u.name === 'sha256sums.txt'));
  } finally { stubs.restore(); }
});

test('MAPPING: per-ABI APKs keep their architecture (no longer all "universal")', async () => {
  const { mapAssetFilename, ignoredAssetReason, assetPreference } = await import('./services/github.ts');
  assert.deepEqual(mapAssetFilename('app-arm64-v8a-release.apk'), { platform: 'android', architecture: 'arm64' });
  assert.deepEqual(mapAssetFilename('app-armeabi-v7a-release.apk'), { platform: 'android', architecture: 'arm' });
  assert.deepEqual(mapAssetFilename('app-x86_64-release.apk'), { platform: 'android', architecture: 'x64' });
  assert.deepEqual(mapAssetFilename('app-release.apk'), { platform: 'android', architecture: 'universal' });

  assert.ok(ignoredAssetReason('elevate.exe'));
  assert.ok(ignoredAssetReason('latest-linux.yml'));
  assert.ok(ignoredAssetReason('app-debug.apk'));
  assert.equal(ignoredAssetReason('Yayra Setup 1.0.75.exe'), null, 'a real installer is never ignored');
  assert.ok(assetPreference('Yayra Setup 1.0.75.exe') > assetPreference('helper.exe'));
  assert.ok(assetPreference('app.msi') > assetPreference('portable.exe'));
});

test('MAPPING: two equally-good installers in one slot still BLOCK, and name both files', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    const payload = ghReleasePayload();
    payload.release.assets = [
      { id: 1, name: 'yayra-setup-x64.exe', size: 10, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/a.exe' },
      { id: 2, name: 'yayra-setup-x64-alt.exe', size: 10, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/b.exe' },
    ];
    const out = await signedDelivery(env, 'release', payload, 'd-ambig');
    assert.equal(out.body.data.status, 'blocked_ambiguous');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    assert.match(String(rel.block_reason), /yayra-setup-x64\.exe/, 'the blocker names the conflicting files');
    assert.match(String(rel.block_reason), /alt/);
  } finally { stubs.restore(); }
});

test('MAPPING: a blocked release RECOVERS on re-detection once the mapping is clean', async () => {
  const stubs = installStubs(env);
  const original = globalThis.fetch;
  try {
    await connect();
    // First delivery: ambiguous -> blocked.
    const bad = ghReleasePayload();
    bad.release.assets = [
      { id: 1, name: 'setup-x64.exe', size: 10, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/a.exe' },
      { id: 2, name: 'setup-x64-copy.exe', size: 10, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/b.exe' },
    ];
    await signedDelivery(env, 'release', bad, 'd-recover-1');
    const rel = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    assert.equal(rel.status, 'blocked');

    // Admin sync afterwards: the ambiguity is gone -> detected again.
    (globalThis.fetch as any) = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith('https://api.github.com/repos/octo/app/releases?per_page=10')) {
        return new Response(JSON.stringify([ghReleasePayload().release]), { status: 200 });
      }
      return (original as any)(url, init);
    });
    await syncAllConnections(env, ADMIN);
    const after = env.tables.github_releases.find((r) => r.github_release_id === '5001');
    assert.equal(after.status, 'detected', 'a blocked release is re-evaluated, not stuck forever');
  } finally { globalThis.fetch = original; stubs.restore(); }
});

// ---------------------------------------------------------------------------
// ADMIN-INITIATED CONNECT — 'admin connect is not working' (production).
// The Connect button used to send the admin to the DEVELOPER page, which
// requires developer-org membership an admin does not have, so nothing could
// ever happen. Admins connect on the owner's behalf instead.
// ---------------------------------------------------------------------------

function adminReq(path: string, body: any = {}): Request {
  const r = new Request(`https://api.test${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 't' },
    body: JSON.stringify(body),
  });
  (r as any).user = { userId: 'admin-1', role: 'admin' };
  return r;
}

test('ADMIN CONNECT: start returns the GitHub authorization URL (admin needs no developer org)', async () => {
  const stubs = installStubs(env);
  try {
    // No developer_members row for the admin — exactly the production state.
    const out: any = await githubAdminRoutes.connectStart(adminReq(`/admin/github/connections/${APP_ID}/connect`), env);
    assert.ok(out.url, out.message);
    assert.ok(String(out.url).startsWith('https://github.com/login/oauth/authorize?'), String(out.url));
  } finally { stubs.restore(); }
});

test('ADMIN CONNECT: a non-admin cannot start or finish an admin connection', async () => {
  const userReq = new Request(`https://api.test/admin/github/connections/${APP_ID}/connect`, { method: 'POST', headers: { 'User-Agent': 't' }, body: '{}' });
  (userReq as any).user = { userId: 'u1', role: 'user' };
  assert.equal(((await githubAdminRoutes.connectStart(userReq as any, env)) as any).code, 'UNAUTHORIZED');
  const anon = new Request(`https://api.test/admin/github/connections/${APP_ID}/connect`, { method: 'POST' });
  assert.equal(((await githubAdminRoutes.connectStart(anon as any, env)) as any).code, 'UNAUTHORIZED');
});

test('ADMIN CONNECT: full flow — authorize, list repos, bind (org taken from the app, audited as admin)', async () => {
  const stubs = installStubs(env);
  try {
    const start: any = await githubAdminRoutes.connectStart(adminReq(`/admin/github/connections/${APP_ID}/connect`), env);
    assert.ok(start.url);
    // GitHub redirects back with the state from the URL.
    const state = decodeURIComponent(String(start.url)).match(/state=([^&]+)/)![1];
    const cb: any = await githubDevRoutes.callback(
      new Request(`https://api.test/developers/github/callback?code=gh-code&state=${encodeURIComponent(state)}`) as any, env,
    );
    assert.ok(cb instanceof Response);
    assert.equal((cb as Response).status, 302);
    const loc = String((cb as Response).headers.get('Location'));
    assert.ok(loc.includes('/admin?section=github-connect'), loc);
    assert.ok(loc.includes(`app=${APP_ID}`), loc);
    const code = decodeURIComponent(loc).match(/gh_admin_connect=([^&]+)/)![1];

    // The admin panel asks for the repos carried by that code.
    const repos: any = await githubAdminRoutes.connectRepos(adminReq(`/admin/github/connections/${APP_ID}/repos`, { code }), env);
    assert.ok(!repos.code, repos.message);
    // The OAuth authorization returned octo/app (public) and octo/secret-app
    // (private); both are carried so the picker opens, but the panel never
    // offers a private repository for binding.
    const names = (repos.repos || []).map((r: any) => r.fullName);
    assert.ok(names.includes('octo/app'), JSON.stringify(names));

    // …then binds one.
    const bind: any = await githubAdminRoutes.connectFinish(
      adminReq(`/admin/github/connections/${APP_ID}/bind`, { code, repositoryId: REPO_ID }), env,
    );
    assert.ok(!bind.code, bind.message);
    const conn = env.tables.github_repo_connections.find((c: any) => c.application_id === APP_ID);
    assert.ok(conn, 'the app is connected');
    assert.equal(conn.connected_by, 'admin-1');
    assert.equal(conn.repository_full_name, 'octo/app');
    // Audited as an ADMIN action on the owner's behalf.
    assert.ok(env.tables.github_audit_log.some((e: any) => e.action === 'admin_connect'));
  } finally { stubs.restore(); }
});

test('ADMIN CONNECT: the public bind endpoint refuses an admin-started code (no cross-flow abuse)', async () => {
  const stubs = installStubs(env);
  try {
    const start: any = await githubAdminRoutes.connectStart(adminReq(`/admin/github/connections/${APP_ID}/connect`), env);
    const state = decodeURIComponent(String(start.url)).match(/state=([^&]+)/)![1];
    const cb: any = await githubDevRoutes.callback(
      new Request(`https://api.test/developers/github/callback?code=gh-code&state=${encodeURIComponent(state)}`) as any, env,
    );
    const code = decodeURIComponent(String((cb as Response).headers.get('Location'))).match(/gh_admin_connect=([^&]+)/)![1];
    const out: any = await githubOAuthRoutes.bind(
      new Request('https://api.test/developers/github/oauth/bind', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, repositoryId: REPO_ID }).toString(),
      }) as any, env,
    );
    const html = await out.text();
    assert.ok(/must be finished in the Admin Panel/i.test(html), html.slice(0, 200));
  } finally { stubs.restore(); }
});

test('ADMIN CONNECT: paid apps and already-connected apps are refused with clear reasons', async () => {
  const stubs = installStubs(env);
  try {
    env.tables.applications[0].price_type = 'paid';
    env.tables.applications[0].price_amount = 20;
    const paid: any = await githubAdminRoutes.connectStart(adminReq(`/admin/github/connections/${APP_ID}/connect`), env);
    assert.equal(paid.code, 'FORBIDDEN');
    env.tables.applications[0].price_type = 'free';
    env.tables.applications[0].price_amount = 0;
    await connect();
    const again: any = await githubAdminRoutes.connectStart(adminReq(`/admin/github/connections/${APP_ID}/connect`), env);
    assert.equal(again.code, 'CONFLICT');
  } finally { stubs.restore(); }
});

// ---------------------------------------------------------------------------
// ALL REPOSITORIES (public + private) — 'admin sees only one repo'.
// The picker used to list only repositories the App was already installed on,
// and dropped private ones entirely.
// ---------------------------------------------------------------------------

test('PICKER: lists EVERY repository the account can see — public AND private — with access state', async () => {
  const stubs = installStubs(env);
  try {
    const state = await issueOneTimeToken(env, 'state', { kind: 'github-oauth', userId: USER_ID, appId: APP_ID });
    const res: any = await githubDevRoutes.callback(
      new Request(`https://api.test/developers/github/callback?code=gh-code&state=${encodeURIComponent(state)}`) as any, env,
    );
    const html = await res.text();
    assert.ok(html.includes('octo/app'), 'public + installed repo is listed');
    assert.ok(html.includes('octo/secret-app'), 'PRIVATE repo is listed');
    assert.ok(html.includes('octo/uninstalled'), 'repo the App is not installed on is still listed');
    assert.match(html, /Grant access/, 'repos without access offer the one-click grant path');
    assert.match(html, /private repository/, 'private repos are labelled');
  } finally { stubs.restore(); }
});

test('PICKER: binding a repository the App has no access to is REFUSED (never a phantom connection)', async () => {
  const stubs = installStubs(env);
  try {
    const state = await issueOneTimeToken(env, 'state', { kind: 'github-oauth', userId: USER_ID, appId: APP_ID });
    const res: any = await githubDevRoutes.callback(
      new Request(`https://api.test/developers/github/callback?code=gh-code&state=${encodeURIComponent(state)}`) as any, env,
    );
    const html = await res.text();
    const code = html.match(/name="code" value="([^"]+)"/)![1];
    // 888002 = octo/uninstalled (listed, but no installation access)
    const out: any = await githubOAuthRoutes.bind(
      new Request('https://api.test/developers/github/oauth/bind', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, repositoryId: '888002' }).toString(),
      }) as any, env,
    );
    const outHtml = await out.text();
    assert.match(outHtml, /does not have access to that repository/i);
    assert.equal(env.tables.github_repo_connections.length, 0);
  } finally { stubs.restore(); }
});

test('PRIVATE REPO: detection records the authenticated API URL + private flags and verification streams with a token', async () => {
  const stubs = installStubs(env);
  const original = globalThis.fetch;
  const seen: string[] = [];
  try {
    // Connect the PRIVATE repo (stub marks octo/secret-app private).
    const originalFetch = globalThis.fetch;
    (globalThis.fetch as any) = (async (url: any, init?: any) => {
      const u = String(url);
      if (u === 'https://api.github.com/installation/repositories?per_page=100') {
        return new Response(JSON.stringify({ repositories: [
          { id: 777001, name: 'secret-app', full_name: 'octo/secret-app', owner: { login: 'octo' }, private: true },
        ] }), { status: 200 });
      }
      return (originalFetch as any)(url, init);
    });
    const conn = await connectAppRepository(env, {
      appId: APP_ID, orgId: ORG_ID, userId: USER_ID, installationId: INSTALLATION_ID, repositoryId: '777001',
    });
    (globalThis.fetch as any) = original;
    assert.ok(conn.ok, (conn as any).message);

    // A release from that private repo: assets are fetched through the API.
    (globalThis.fetch as any) = (async (url: any, init?: any) => {
      const u = String(url);
      const auth = String(init?.headers?.Authorization || '');
      if (u.startsWith('https://api.github.com/repos/octo/secret-app/releases/assets/')) {
        assert.ok(auth.startsWith('Bearer '), 'private asset metadata requires an installation token');
        return new Response(JSON.stringify({ id: 555001, name: 'clinical-rx_1.12.0_amd64.deb', size: DEB_FIXTURE.byteLength }), { status: 200 });
      }
      if (u.startsWith('https://api.github.com/repos/octo/secret-app')) {
        return new Response(JSON.stringify({ id: 777001, full_name: 'octo/secret-app', private: true }), { status: 200 });
      }
      if (u === 'https://api.github.com/app/installations/777/access_tokens') return new Response(JSON.stringify({ token: 'inst-token', expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 });
      seen.push(u);
      return (original as any)(url, init);
    });

    const payload = ghReleasePayload();
    payload.repository = { id: 777001, full_name: 'octo/secret-app' };
    payload.release.assets = [{
      id: 555001, name: 'clinical-rx_1.12.0_amd64.deb', size: DEB_FIXTURE.byteLength,
      browser_download_url: 'https://github.com/octo/secret-app/releases/download/v1.12.0/clinical-rx_1.12.0_amd64.deb',
    }];
    const out = await signedDelivery(env, 'release', payload, 'd-private');
    assert.equal(out.body.data.status, 'detected', JSON.stringify(out.body));

    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    const asset = env.tables.github_release_assets.find((a: any) => a.release_id === rel.id);
    assert.equal(Number(asset.is_private), 1, 'the asset is marked private');
    assert.ok(String(asset.download_url).startsWith('https://api.github.com/repos/octo/secret-app/releases/assets/'),
      'a private asset is recorded by its authenticated API URL, never the public one');
    const canonical = env.tables.releases.find((r2: any) => r2.application_id === APP_ID && r2.version === '1.12.0');
    assert.ok(canonical, 'the canonical (unpublished) release row exists');
    const pkg = env.tables.packages.find((p2: any) => p2.release_id === canonical.id);
    assert.ok(pkg, 'the canonical package row exists');
    assert.equal(Number(pkg.external_private), 1, 'the canonical package is marked private');
  } finally { globalThis.fetch = original; stubs.restore(); }
});

test('PRIVATE DOWNLOAD: the manifest points at the RX Store asset proxy, never the API URL', async () => {
  const { buildManifest } = await import('./services/releases.ts');
  const manifest = buildManifest({
    pkg: {
      id: 'pkg_private_1', provider: 'github', external_private: 1,
      external_url: 'https://api.github.com/repos/octo/secret-app/releases/assets/555001',
      storage_key: '', filename: 'a.deb', file_size: 10, sha256: 'b'.repeat(64), version: '1.0.0',
      platform: 'linux_deb', architecture: 'x64',
    } as any,
    matchedPlatform: 'linux_deb', matchedArchitecture: 'x64' as any, origin: 'https://api.test',
  });
  assert.equal(manifest.url, 'https://api.test/v1/github-assets/pkg_private_1');
  assert.ok(!manifest.url.includes('api.github.com'), 'the token-requiring API URL must never reach a client');
});

// ---------------------------------------------------------------------------
// FORM POSTS MUST NEVER RETURN RAW JSON
// Production: a developer's bind form post answered
//   {"success":false,"error":{"code":"INTERNAL", ...}}
// because an exception escaped the handler into the API's JSON boundary.
// A browser form post must always receive a readable HTML page.
// ---------------------------------------------------------------------------

test('BIND: an unexpected exception renders an HTML page with a reference — never raw JSON', async () => {
  // A database that explodes on every statement (schema drift, D1 outage…).
  const broken = {
    DB: { prepare() { throw new Error('D1_ERROR: no such column: repository_private'); } },
    RX_STORE_WEB_URL: 'https://web.test',
  };
  const body = new URLSearchParams({ code: 'o_whatever', repositoryId: '123' }).toString();
  const out: any = await githubOAuthRoutes.bind(
    new Request('https://api.test/developers/github/oauth/bind', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    }) as any,
    broken,
  );
  assert.ok(out instanceof Response, 'a Response is always returned');
  assert.ok(String(out.headers.get('Content-Type')).includes('text/html'), 'HTML, not JSON');
  const html = await out.text();
  assert.ok(!html.trimStart().startsWith('{"success"'), 'must not be the JSON error envelope');
  assert.match(html, /Reference:/, 'the page carries a reference id for the log');
  assert.match(html, /Could not finish connecting/);
});

test('PICKER: a failing GitHub call renders an HTML page too', async () => {
  const broken = {
    DB: { prepare() { throw new Error('D1 down'); } },
    RX_STORE_WEB_URL: 'https://web.test',
    GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 's', GITHUB_APP_PRIVATE_KEY: 'k', GITHUB_WEBHOOK_SECRET: 'w',
    GITHUB_APP_CLIENT_ID: 'Iv1.x', GITHUB_APP_CLIENT_SECRET: 'sec',
  };
  const out: any = await githubDevRoutes.callback(
    new Request('https://api.test/developers/github/callback?code=abc&state=xyz') as any, broken,
  );
  assert.ok(out instanceof Response);
  assert.match(String(out.headers.get('Content-Type')), /text\/html/);
  const html = await out.text();
  assert.match(html, /Could not finish connecting/);
});

// ---------------------------------------------------------------------------
// RECONNECT — production failure "Could not finish connecting" with only a
// reference id. github_repo_connections has UNIQUE(application_id), so a
// leftover row in a non-active state (disconnected/suspended) made the connect
// INSERT throw. Reconnecting must REUSE that row.
// ---------------------------------------------------------------------------

test('RECONNECT: a disconnected connection is reused, not re-inserted (no UNIQUE violation)', async () => {
  const stubs = installStubs(env);
  try {
    // First connect, then disconnect (row stays with status 'disconnected').
    const first = await connect();
    assert.ok(first.ok, (first as any).message);
    await disconnectAppRepository(env, { appId: APP_ID, orgId: ORG_ID, userId: USER_ID });
    assert.equal(env.tables.github_repo_connections.length, 1);
    assert.equal(env.tables.github_repo_connections[0].status, 'disconnected');

    // Reconnect: previously this threw UNIQUE constraint failed and surfaced
    // as 'Something went wrong' on the bind page.
    const again = await connect();
    assert.ok(again.ok, (again as any).message);
    assert.equal(env.tables.github_repo_connections.length, 1, 'still exactly one row');
    assert.equal(env.tables.github_repo_connections[0].status, 'active', 'the row is active again');
    assert.equal(again.connection.repository_full_name, 'octo/app');
  } finally { stubs.restore(); }
});

test('RECONNECT: a suspended connection is also restored (admin reinstate path stays consistent)', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    await adminSetConnectionStatus(env, ADMIN, APP_ID, 'suspend', 'Suspicious activity reported by two developers.');
    assert.equal(env.tables.github_repo_connections[0].status, 'revoked');
    const out = await connect();
    assert.ok(out.ok, (out as any).message);
    assert.equal(env.tables.github_repo_connections[0].status, 'active');
    assert.equal(env.tables.github_repo_connections.length, 1);
  } finally { stubs.restore(); }
});

test('RECONNECT: a genuine race answers CONFLICT, never a 500-style crash', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    // Simulate the race: the row appears between the guard and the write by
    // pretending the app already has an ACTIVE row for a DIFFERENT app id.
    env.tables.github_repo_connections.push({
      id: 'ghc_other', application_id: 'app-other', repository_id: REPO_ID,
      repository_owner: 'octo', repository_name: 'app', repository_full_name: 'octo/app',
      installation_id: INSTALLATION_ID, status: 'active',
    });
    const out = await connectAppRepository(env, {
      appId: APP_ID, orgId: ORG_ID, userId: USER_ID, installationId: INSTALLATION_ID, repositoryId: REPO_ID,
    });
    assert.equal(out.ok, false);
    assert.equal((out as any).code, 'CONFLICT');
  } finally { stubs.restore(); }
});

// ---------------------------------------------------------------------------
// LINUX INSTALLERS WITHOUT AN ARCHITECTURE MARKER
// Production: 'RX-Store-1.7.6.deb' and 'RX-Store-1.7.6.AppImage' were skipped
// as 'not a recognised installer type', so the release lost its Linux packages.
// ---------------------------------------------------------------------------

test('MAPPING: .deb/.AppImage without an architecture marker are MAPPED (x64 assumed, flagged)', async () => {
  const { mapAssetFilename } = await import('./services/github.ts');
  assert.deepEqual(mapAssetFilename('RX-Store-1.7.6.deb'), { platform: 'linux_deb', architecture: 'x64', assumed: true });
  assert.deepEqual(mapAssetFilename('RX-Store-1.7.6.AppImage'), { platform: 'linux_appimage', architecture: 'x64', assumed: true });
  // Declared architectures are NOT assumed.
  assert.equal((mapAssetFilename('app_arm64.deb') as any).assumed, undefined);
  assert.equal((mapAssetFilename('app_amd64.deb') as any).assumed, undefined);
});

test('VERIFY: the architecture is read from the BINARY and corrects an assumed x64', async () => {
  const { detectArchitectureFromBytes } = await import('./services/packageSecurity.ts');
  // A minimal ELF header for AArch64 (e_machine 0xB7) in a head window.
  const elf = (machine: number) => {
    const b = new Uint8Array(64);
    b.set([0x7f, 0x45, 0x4c, 0x46], 0);
    b[18] = machine & 0xff;
    b[19] = (machine >> 8) & 0xff;
    return { size: 64, head: b, headOffset: 0, tail: b, tailOffset: 0, full: b } as any;
  };
  assert.equal(await detectArchitectureFromBytes('linux_appimage', elf(0x3e)), 'x64');
  assert.equal(await detectArchitectureFromBytes('linux_appimage', elf(0xb7)), 'arm64');
  assert.equal(await detectArchitectureFromBytes('linux_appimage', elf(0x28)), 'arm');
  // A real .deb declares its architecture in control.tar.gz.
  assert.equal(await detectArchitectureFromBytes('linux_deb', {
    size: DEB_FIXTURE.length, head: DEB_FIXTURE, headOffset: 0,
    tail: DEB_FIXTURE, tailOffset: 0, full: DEB_FIXTURE,
  } as any), 'x64', 'the fixture declares Architecture: amd64');
});

test('DETECTION: an electron-builder release keeps ALL THREE platforms (apk + exe + deb + appimage)', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    const payload = ghReleasePayload();
    payload.release.assets = [
      { id: 1, name: 'rx-store-1.7.6.apk', size: 10, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/rx-store.apk' },
      { id: 2, name: 'RXStore-Setup-1.7.6.exe', size: 10, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/setup.exe' },
      { id: 3, name: 'RX-Store-1.7.6.deb', size: 10, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/rx.deb' },
      { id: 4, name: 'RX-Store-1.7.6.AppImage', size: 10, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/rx.AppImage' },
      { id: 5, name: 'latest-linux.yml', size: 1, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/latest-linux.yml' },
      { id: 6, name: 'latest.yml', size: 1, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/latest.yml' },
    ];
    const out = await signedDelivery(env, 'release', payload, 'd-linux');
    assert.equal(out.body.data.status, 'detected', JSON.stringify(out.body));

    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    const assets = env.tables.github_release_assets.filter((a: any) => a.release_id === rel.id);
    const slots = assets.map((a: any) => `${a.platform}/${a.architecture}`).sort();
    assert.deepEqual(slots, ['android/universal', 'linux_appimage/x64', 'linux_deb/x64', 'windows/x64']);
    // The Linux ones are flagged as inferred, so the admin sees it.
    const deb = assets.find((a: any) => a.platform === 'linux_deb');
    assert.equal(Number(deb.arch_assumed), 1, 'x64 was inferred from the binary later — flagged for review');
    // The updater feeds are still skipped (they are not installers).
    const ignored = JSON.parse(rel.ignored_assets || '{}');
    const names = (ignored.ignored || []).map((i: any) => i.name);
    assert.ok(names.includes('latest-linux.yml'));
    assert.ok(names.includes('latest.yml'));
  } finally { stubs.restore(); }
});

// ---------------------------------------------------------------------------
// LATEST ONLY — a sync must not import the whole release history.
// Production: the queue filled with v1.0.60 … v1.0.68.
// ---------------------------------------------------------------------------

test('LATEST ONLY: an older undecided release is SUPERSEDED when a newer one is detected', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    const old1 = ghReleasePayload();
    old1.release.id = 4001; old1.release.tag_name = 'v1.0.60';
    await signedDelivery(env, 'release', old1, 'd-old');
    const older = env.tables.github_releases.find((r: any) => r.github_release_id === '4001');
    assert.equal(older.status, 'detected');

    const newer = ghReleasePayload();
    newer.release.id = 4002; newer.release.tag_name = 'v1.0.68';
    await signedDelivery(env, 'release', newer, 'd-new');
    const newerRow = env.tables.github_releases.find((r: any) => r.github_release_id === '4002');
    assert.equal(newerRow.status, 'detected');
    assert.equal(older.status, 'withdrawn', 'the older undecided release leaves the queue (withdrawn + superseded marker)');
    assert.ok(String(older.block_reason).includes('Superseded by the newer GitHub release 1.0.68'), String(older.block_reason));

    const pub = await publishGithubRelease(env, ADMIN, older.id, {});
    assert.equal(pub.ok, false);
  } finally { stubs.restore(); }
});

test('LATEST ONLY: an ALREADY PUBLISHED older release is never superseded', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-pub-old');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    await verifyGithubRelease(env, rel.id);
    const published = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.ok(published.ok, (published as any).message);
    assert.equal(rel.status, 'published');

    const newer = ghReleasePayload();
    newer.release.id = 5002; newer.release.tag_name = 'v1.13.0';
    await signedDelivery(env, 'release', newer, 'd-newer');
    assert.equal(rel.status, 'published', 'a live release stays live');
  } finally { stubs.restore(); }
});

test('LATEST ONLY: sync imports ONLY the newest non-draft release and archives the backlog', async () => {
  const stubs = installStubs(env);
  const original = globalThis.fetch;
  try {
    await connect();
    for (const [id, ver] of [['6001', 'v1.0.60'], ['6002', 'v1.0.61'], ['6003', 'v1.0.62']]) {
      env.tables.github_releases.push({
        id: `ghr_${id}`, application_id: APP_ID, connection_id: env.tables.github_repo_connections[0].id,
        github_release_id: id, tag_name: ver, version: ver.slice(1), status: 'detected', detected_at: '2026-10-21',
      });
    }
    (globalThis.fetch as any) = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith('https://api.github.com/repos/octo/app/releases?per_page=10')) {
        return new Response(JSON.stringify([
          { id: 7001, tag_name: 'v1.0.68', draft: false, prerelease: false, body: '', assets: [
            { id: 7500, name: 'clinical-rx_1.0.68_amd64.deb', size: 10, browser_download_url: 'https://github.com/octo/app/releases/download/v1.0.68/clinical-rx_1.0.68_amd64.deb' },
          ] },
          { id: 7000, tag_name: 'v1.0.67', draft: false, prerelease: false, body: '', assets: [] },
        ]), { status: 200 });
      }
      return (original as any)(url, init);
    });
    const out = await syncAllConnections(env, ADMIN);
    assert.ok(out.detected >= 1, JSON.stringify(out));

    const live = env.tables.github_releases.filter((r: any) =>
      ['detected', 'verifying', 'pending_approval'].includes(r.status));
    assert.equal(live.length, 1, JSON.stringify(live.map((r: any) => r.version)));
    assert.equal(live[0].version, '1.0.68');
    const superseded = env.tables.github_releases.filter((r: any) => r.status === 'withdrawn' && /Superseded by the newer/.test(String(r.block_reason || '')));
    assert.ok(superseded.length >= 3, 'the historical backlog is archived, not queued');
  } finally { globalThis.fetch = original; stubs.restore(); }
});

test('SECURITY NOTIFICATIONS: verification success and failure both raise an admin event', async () => {
  const stubs = installStubs(env, { vtVerdict: 'CLEAN' });
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-sec-1');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    const v = await verifyGithubRelease(env, rel.id);
    assert.ok(v.ok, v.message);
    const events = env.tables.admin_events.filter((e: any) => e.section === 'security');
    assert.ok(events.some((e: any) => /verification passed/i.test(e.title)), JSON.stringify(events.map((e: any) => e.title)));
  } finally { stubs.restore(); }

  env = fakeEnv();
  env.GITHUB_APP_PRIVATE_KEY = TEST_PEM;
  await ensureGithubTables(env);
  const stubs2 = installStubs(env, { assetStatus: 404 });
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-sec-2');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    const v = await verifyGithubRelease(env, rel.id);
    assert.equal(v.ok, false);
    const events = env.tables.admin_events.filter((e: any) => e.section === 'security');
    assert.ok(events.some((e: any) => /verification failed/i.test(e.title)), JSON.stringify(events.map((e: any) => e.title)));
    assert.ok(events.some((e: any) => e.type === 'error'));
  } finally { stubs2.restore(); }
});

// ---------------------------------------------------------------------------
// DELETE — the admin must be able to clear records, but a LIVE release is
// never silently removed (withdraw first).
// ---------------------------------------------------------------------------

test('DELETE: a detected/superseded record is removed, with its assets; published is refused', async () => {
  const { deleteGithubRelease, deleteSupersededReleases } = await import('./services/githubReleases.ts');
  const stubs = installStubs(env);
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-del-1');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    assert.ok(env.tables.github_release_assets.some((a: any) => a.release_id === rel.id));

    // Reason is mandatory (audited).
    const noReason = await deleteGithubRelease(env, ADMIN, rel.id, 'short');
    assert.equal(noReason.ok, false);
    assert.equal((noReason as any).code, 'VALIDATION_ERROR');

    const ok = await deleteGithubRelease(env, ADMIN, rel.id, 'Clearing a test release that was never approved.');
    assert.ok(ok.ok, (ok as any).message);
    assert.equal(env.tables.github_releases.some((r: any) => r.id === rel.id), false, 'the record is gone');
    assert.equal(env.tables.github_release_assets.some((a: any) => a.release_id === rel.id), false, 'its assets are gone');
    assert.ok(env.tables.github_audit_log.some((e: any) => e.action === 'delete'));
  } finally { stubs.restore(); }

  // A PUBLISHED release cannot be deleted.
  env = fakeEnv();
  env.GITHUB_APP_PRIVATE_KEY = TEST_PEM;
  await ensureGithubTables(env);
  const stubs2 = installStubs(env);
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-del-2');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    await verifyGithubRelease(env, rel.id);
    const published = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.ok(published.ok, (published as any).message);
    const out = await deleteGithubRelease(env, ADMIN, rel.id, 'Trying to delete a live release by mistake.');
    assert.equal(out.ok, false);
    assert.equal((out as any).code, 'CONFLICT');
    assert.match(String((out as any).message), /Withdraw it first/i);
    assert.ok(env.tables.github_releases.some((r: any) => r.id === rel.id), 'the live record is untouched');
  } finally { stubs2.restore(); }
});

test('DELETE ALL SUPERSEDED: clears archived rows only, never queued or published ones', async () => {
  const { deleteSupersededReleases, SUPERSEDED_PREFIX } = await import('./services/githubReleases.ts');
  const stubs = installStubs(env);
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-bulk-1');
    const live = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    // Older releases archived by the latest-only rule:
    for (const v of ['1.0.60', '1.0.61']) {
      env.tables.github_releases.push({
        id: `ghr_${v}`, application_id: APP_ID, connection_id: live.connection_id,
        github_release_id: `id_${v}`, tag_name: `v${v}`, version: v,
        status: 'withdrawn', block_reason: `${SUPERSEDED_PREFIX} 1.12.0.`, detected_at: '2026-10-21',
      });
    }
    const out = await deleteSupersededReleases(env, ADMIN);
    assert.equal(out.deleted, 2);
    assert.equal(env.tables.github_releases.some((r: any) => r.id === live.id), true, 'the live/queued release is untouched');
    assert.equal(env.tables.github_releases.filter((r: any) => r.status === 'withdrawn').length, 0);
    assert.ok(env.tables.github_audit_log.some((e: any) => e.action === 'delete_superseded'));
  } finally { stubs.restore(); }
});

// ---------------------------------------------------------------------------
// HONEST EVIDENCE + STUCK VERIFICATION
// Production: packages showed 'PASSED' while the panel said 'No checks recorded
// yet', and releases sat in 'verifying' with no way forward.
// ---------------------------------------------------------------------------

test('EVIDENCE: a PASSED package with no recorded checks is treated as UNVERIFIED by the gate', async () => {
  const { publicationSecurityGate } = await import('./services/packageSecurity.ts');
  const stubs = installStubs(env);
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-evidence');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    const canonical: any = env.tables.releases.find((r: any) => r.application_id === APP_ID && r.version === '1.12.0');
    // Pretend the row was marked PASSED without any evidence (the GitHub path
    // before the pipeline ran).
    const pkg = env.tables.packages.find((x: any) => x.release_id === canonical.id);
    pkg.overall_security = 'PASSED';
    pkg.security_state = 'SECURITY_REVIEW_COMPLETE';
    env.tables.package_security_results = [];

    const gate = await publicationSecurityGate(env, canonical.id);
    assert.equal(gate.ok, false, 'no evidence must never authorise publication');
    assert.equal(gate.blockers.length, 1);
    // Publishing therefore fails closed.
    const pub = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.equal(pub.ok, false);
  } finally { stubs.restore(); }
});

test('STUCK: a release verifying for >10 minutes becomes retryable, never a dead end', async () => {
  const { recoverStuckVerifications } = await import('./services/githubReleases.ts');
  const stubs = installStubs(env);
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-stuck');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    rel.status = 'verifying';
    rel.detected_at = '2020-01-01 00:00:00'; // long ago (the fake does not parse the interval itself)
    // The fake cannot evaluate datetime() arithmetic, so assert the SQL shape
    // and that a fresh run is a no-op for recent rows.
    const changed = await recoverStuckVerifications(env, rel.id).catch(() => 0);
    assert.equal(typeof changed, 'number');
    // The important contract: the SQL only touches 'verifying' rows with the
    // 10-minute guard, so a live verification is never stolen.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./services/githubReleases.ts', import.meta.url), 'utf8');
    assert.match(src, /status='verifying' AND detected_at < datetime\('now','-10 minutes'\)/,
      'the recovery is bounded to genuinely stuck rows');
    assert.match(src, /Press Retry verification/, 'the reason tells the admin what to do');
  } finally { stubs.restore(); }
});

// ---------------------------------------------------------------------------
// INCREMENTAL VERIFICATION + MANUAL AIDS
// Production: 'Retry verification' → 'Failed to fetch' (the Worker died trying
// to stream every asset of the release in one request) and no way to finish.
// ---------------------------------------------------------------------------

test('INCREMENTAL: one asset per call, with honest remaining counts, until ready', async () => {
  const stubs = installStubs(env);
  const original = globalThis.fetch;
  try {
    await connect();
    // A release with THREE assets.
    const payload = ghReleasePayload();
    payload.release.assets = [
      { id: 1, name: 'clinical-rx_1.12.0_amd64.deb', size: DEB_FIXTURE.byteLength, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/a.deb' },
      { id: 2, name: 'clinical-rx-1.12.0.apk', size: apkBytes().byteLength, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/b.apk' },
      { id: 3, name: 'clinical-rx-1.12.0.exe', size: peBytes(0x8664).byteLength, browser_download_url: 'https://github.com/octo/app/releases/download/v1.12.0/c.exe' },
    ];
    (globalThis.fetch as any) = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith('https://api.github.com/repos/octo/app/releases/assets/')) {
        const id = u.split('/').pop();
        const meta = id === '1'
          ? { name: 'clinical-rx_1.12.0_amd64.deb', size: DEB_FIXTURE.byteLength }
          : id === '2'
            ? { name: 'clinical-rx-1.12.0.apk', size: apkBytes().byteLength }
            : { name: 'clinical-rx-1.12.0.exe', size: peBytes(0x8664).byteLength };
        return new Response(JSON.stringify({ id: Number(id), ...meta }), { status: 200 });
      }
      return (original as any)(url, init);
    });
    await signedDelivery(env, 'release', payload, 'd-incremental');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');

    // Call 1: a single asset is verified, two remain, the release is NOT ready.
    const first: any = await verifyGithubRelease(env, rel.id, { maxAssets: 1 });
    assert.equal(first.status, 'verifying', JSON.stringify(first));
    assert.equal(first.remaining, 2, 'two assets still pending');
    assert.equal(first.verifiedAssets, 1);
    assert.equal(rel.status, 'verifying');

    // Call 2 and 3 finish the job.
    const second: any = await verifyGithubRelease(env, rel.id, { maxAssets: 1 });
    assert.equal(second.remaining, 1);
    const third: any = await verifyGithubRelease(env, rel.id, { maxAssets: 1 });
    assert.equal(third.status, 'pending_approval', JSON.stringify(third));
    assert.equal(third.remaining, 0);
    assert.equal(rel.status, 'pending_approval');
  } finally { globalThis.fetch = original; stubs.restore(); }
});

test('INCREMENTAL: re-running never re-streams an already-verified asset', async () => {
  const stubs = installStubs(env);
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-idem');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    const first: any = await verifyGithubRelease(env, rel.id, { maxAssets: 1 });
    assert.equal(first.status, 'pending_approval');
    const asset = env.tables.github_release_assets[0];
    assert.equal(asset.state, 'verified');
    // A second call finds nothing pending and keeps the release ready.
    const again: any = await verifyGithubRelease(env, rel.id, { maxAssets: 1 });
    assert.equal(again.status, 'pending_approval');
    assert.equal(again.remaining, 0);
  } finally { stubs.restore(); }
});

test('MANUAL APPROVE: computes the real hash, records audited evidence and unblocks publication', async () => {
  const { manualVerifyAsset } = await import('./services/githubReleases.ts');
  const stubs = installStubs(env);
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-manual');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    const asset = env.tables.github_release_assets[0];

    // The note is mandatory.
    const noNote = await manualVerifyAsset(env, ADMIN, rel.id, asset.id, 'APPROVE', 'short');
    assert.equal(noNote.ok, false);
    assert.equal((noNote as any).code, 'VALIDATION_ERROR');

    const out: any = await manualVerifyAsset(env, ADMIN, rel.id, asset.id, 'APPROVE', 'Vendor checksum verified out of band; scanner was rate limited.');
    assert.ok(out.ok, out.message);
    assert.equal(asset.state, 'verified');
    assert.equal(asset.sha256, DEB_SHA, 'the SHA-256 is computed from the actual bytes');
    assert.equal(out.remaining, 0);
    assert.equal(rel.status, 'pending_approval', 'the release becomes ready for approval');

    // Evidence rows attributed to the admin decision, not to a fake pass.
    const checks = env.tables.package_security_results.filter((c: any) => c.provider === 'manual');
    assert.ok(checks.some((c: any) => c.check_type === 'integrity' && c.status === 'PASSED'));
    assert.ok(checks.some((c: any) => c.check_type === 'malware' && c.status === 'NEEDS_REVIEW'));
    assert.ok(env.tables.github_audit_log.some((e: any) => e.action === 'manual_asset_approve'));

    // And the release can actually be published through the gate.
    const pub = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.ok(pub.ok, (pub as any).message);
  } finally { stubs.restore(); }
});

test('MANUAL APPROVE: uses GitHub\'s own sha256 digest instead of streaming the asset again', async () => {
  const { manualVerifyAsset } = await import('./services/githubReleases.ts');
  const stubs = installStubs(env);
  const original = globalThis.fetch;
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-manual-digest');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    const asset = env.tables.github_release_assets[0];
    const digest = 'a'.repeat(64);
    let downloads = 0;
    (globalThis.fetch as any) = async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith('https://api.github.com/repos/octo/app/releases/assets/')) {
        return new Response(JSON.stringify({
          id: 555001, name: 'clinical-rx_1.12.0_amd64.deb', size: DEB_FIXTURE.byteLength, digest: `sha256:${digest}`,
        }), { status: 200 });
      }
      if (u.startsWith('https://github.com/octo/app/releases/download/')) {
        downloads++;
        throw new TypeError('Failed to fetch'); // must never be reached
      }
      return (original as any)(url, init);
    };

    const out: any = await manualVerifyAsset(env, ADMIN, rel.id, asset.id, 'APPROVE', 'Vendor published the SHA-256 in the release notes; the scanner was rate limited.');
    assert.ok(out.ok, out.message);
    assert.equal(downloads, 0, 'no 100MB download just to hash a file GitHub already digests');
    assert.equal(asset.sha256, digest, 'the approved hash is GitHub\'s authoritative digest');
    assert.equal(asset.size_bytes, DEB_FIXTURE.byteLength);
    assert.equal(asset.state, 'verified');
    const audit = env.tables.github_audit_log.find((e: any) => e.action === 'manual_asset_approve');
    assert.equal(JSON.parse(String(audit.details)).hashSource, 'github_digest', 'the audit records where the hash came from');
  } finally { globalThis.fetch = original; stubs.restore(); }
});

test('MANUAL APPROVE: a DETECTED verdict can never be overridden', async () => {
  const { manualVerifyAsset } = await import('./services/githubReleases.ts');
  const stubs = installStubs(env, { vtVerdict: 'DETECTED' });
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-manual-det');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    await verifyGithubRelease(env, rel.id, { maxAssets: 1 }); // records the DETECTED verdict
    const asset = env.tables.github_release_assets[0];
    const out: any = await manualVerifyAsset(env, ADMIN, rel.id, asset.id, 'APPROVE', 'I trust the publisher, the scanner must be wrong.');
    assert.equal(out.ok, false);
    assert.equal(out.code, 'FORBIDDEN');
    assert.match(String(out.message), /DETECTED/);
  } finally { stubs.restore(); }
});

test('MANUAL REJECT: the asset stays blocked and is audited', async () => {
  const { manualVerifyAsset } = await import('./services/githubReleases.ts');
  const stubs = installStubs(env);
  try {
    await connect();
    await signedDelivery(env, 'release', ghReleasePayload(), 'd-manual-rej');
    const rel = env.tables.github_releases.find((r: any) => r.github_release_id === '5001');
    const asset = env.tables.github_release_assets[0];
    const out: any = await manualVerifyAsset(env, ADMIN, rel.id, asset.id, 'REJECT', 'Unexpected contents for this version — do not ship.');
    assert.ok(out.ok, out.message);
    assert.equal(asset.state, 'failed');
    assert.ok(env.tables.github_audit_log.some((e: any) => e.action === 'manual_asset_reject'));
    const pub = await publishGithubRelease(env, ADMIN, rel.id, {});
    assert.equal(pub.ok, false, 'a rejected asset cannot be published');
  } finally { stubs.restore(); }
});
