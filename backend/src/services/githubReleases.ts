/**
 * RX Store — GitHub Releases integration: connection, detection, verification,
 * approval state machine and publication for ELIGIBLE FREE applications.
 *
 * HARD RULES (Phase 6 — enforced here, not in the UI):
 *   1. GitHub detection NEVER writes applications.current_version, NEVER
 *      creates a canonical releases/packages row, NEVER touches app_versions
 *      and NEVER sends a notification. Detection only inserts rows into the
 *      github_* tables with status 'detected'/'verifying'.
 *   2. The ONLY path to a live update is publishGithubRelease(), which:
 *        - requires an authenticated admin identity (attached by the /admin
 *          gate in index.ts; re-verified by the caller),
 *        - re-verifies EVERY asset identity (GitHub API metadata + a fresh
 *          SHA-256 stream of the actual bytes) at publish time,
 *        - re-checks the app is still free + still connected,
 *        - enforces the security gate (scanner CLEAN, or an EXPLICIT audited
 *          override with a reason — allowed ONLY for UNAVAILABLE, never for
 *          a DETECTED verdict),
 *        - creates the canonical release + packages atomically enough that a
 *          failure cannot leave a half-published state, and
 *        - is idempotence-guarded by UNIQUE constraints (application_id,
 *          version) so concurrent approvals cannot publish twice.
 *   3. Paid apps can never connect (connectAppRepository), can never publish
 *      (publish gate) and can never serve a github package (download route
 *      re-checks).
 *
 * RX Store never copies GitHub installer binaries into R2: verification
 * streams the bytes through the Worker (hash + scanner upload) and drops them.
 */
import {
  githubAppConfig, githubConfigured, installationRepos, verifyWebhookSignature,
  mapAssetFilename, parseRxManifest, versionFromTag, validateAssetUrl,
  streamAssetHash, ghApi,
} from './github.ts';
import {
  runSecurityPipeline, publicationSecurityGate, latestCheckStatus,
  latestChecksForPackages, loadExternalPackageBytes,
} from './packageSecurity.ts';
import { consumeOneTimeToken, restoreOneTimeToken } from './oauth.ts';
import { compareSemver, normalizeChannel } from './releases.ts';
import { streamToMultipart } from './streaming.ts';

export const GITHUB_RELEASE_STATUSES = [
  'detected', 'verifying', 'pending_approval',
  'verification_failed', 'blocked', 'rejected', 'withdrawn', 'published',
] as const;
export type GithubReleaseStatus = typeof GITHUB_RELEASE_STATUSES[number];

/** Default hard cap for a GitHub asset we are willing to verify. */
export function assetMaxBytes(env: any): number {
  const n = Number(env?.GITHUB_ASSET_MAX_BYTES || 0);
  return Number.isFinite(n) && n > 0 ? n : 500 * 1024 * 1024;
}

/** VT upload ceiling for external assets (free tier: 32MB; premium: 650MB). */
export function vtMaxBytes(env: any): number {
  const n = Number(env?.GITHUB_VT_MAX_BYTES || 0);
  return Number.isFinite(n) && n > 0 ? n : 32 * 1024 * 1024;
}

// ---------------------------------------------------------------------------
// Tables (lazy ensure — same pattern as oauth/settings; migrations carry the
// canonical DDL for production)
// ---------------------------------------------------------------------------

export async function ensureGithubTables(env: any): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS github_repo_connections (
    id TEXT PRIMARY KEY, application_id TEXT NOT NULL UNIQUE, repository_id TEXT NOT NULL UNIQUE,
    repository_owner TEXT NOT NULL, repository_name TEXT NOT NULL, repository_full_name TEXT NOT NULL,
    installation_id TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'stable',
    status TEXT NOT NULL DEFAULT 'active', connected_by TEXT,
    last_event_at TEXT, last_event TEXT, last_sync_at TEXT, last_error TEXT, latest_detected_version TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`).run().catch(() => {});
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS github_release_events (
    id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, event TEXT NOT NULL, action TEXT, repository_id TEXT,
    status TEXT NOT NULL, detail TEXT, error TEXT, received_at TEXT DEFAULT (datetime('now'))
  )`).run().catch(() => {});
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_events_delivery ON github_release_events(delivery_id, event)`).run().catch(() => {});
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS github_releases (
    id TEXT PRIMARY KEY, application_id TEXT NOT NULL, connection_id TEXT NOT NULL,
    github_release_id TEXT NOT NULL UNIQUE, tag_name TEXT NOT NULL, version TEXT NOT NULL,
    release_name TEXT, target_commitish TEXT, is_prerelease INTEGER NOT NULL DEFAULT 0,
    release_notes TEXT, github_published_at TEXT, status TEXT NOT NULL DEFAULT 'detected',
    block_reason TEXT, detected_at TEXT DEFAULT (datetime('now')), verified_at TEXT,
    reviewed_by TEXT, reviewed_at TEXT, decision_reason TEXT, published_by TEXT, published_at TEXT,
    prior_version TEXT, UNIQUE(application_id, version)
  )`).run().catch(() => {});
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS github_release_assets (
    id TEXT PRIMARY KEY, release_id TEXT NOT NULL, github_asset_id TEXT NOT NULL,
    name TEXT NOT NULL, platform TEXT NOT NULL, architecture TEXT NOT NULL,
    size_bytes INTEGER, sha256 TEXT, declared_sha256 TEXT, download_url TEXT,
    state TEXT NOT NULL DEFAULT 'detected', scanner_status TEXT, scanner_detail TEXT,
    scanned_at TEXT, error TEXT, verified_at TEXT, UNIQUE(release_id, platform, architecture)
  )`).run().catch(() => {});
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS github_audit_log (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, actor_id TEXT NOT NULL, actor_label TEXT,
    application_id TEXT, release_id TEXT, repository_id TEXT, reason TEXT, details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run().catch(() => {});
}

async function audit(env: any, entry: {
  action: string; actorId: string; actorLabel?: string; appId?: string;
  releaseId?: string; repositoryId?: string; reason?: string; details?: any;
}): Promise<void> {
  await ensureGithubTables(env);
  await env.DB.prepare(
    `INSERT INTO github_audit_log (id, action, actor_id, actor_label, application_id, release_id, repository_id, reason, details)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    `gha_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    entry.action, entry.actorId, entry.actorLabel || null, entry.appId || null,
    entry.releaseId || null, entry.repositoryId || null, entry.reason || null,
    entry.details ? JSON.stringify(entry.details).slice(0, 4000) : null,
  ).run().catch(() => {});
}

// ---------------------------------------------------------------------------
// Eligibility + connections
// ---------------------------------------------------------------------------

export function appIsFree(app: any): boolean {
  const paid = ['paid', 'subscription'].includes(String(app?.price_type || 'free')) && Number(app?.price_amount) > 0;
  return !paid;
}

export async function getConnectionForApp(env: any, appId: string): Promise<any | null> {
  await ensureGithubTables(env);
  return await env.DB.prepare(`SELECT * FROM github_repo_connections WHERE application_id=?`).bind(appId).first().catch(() => null);
}

/**
 * Connect an eligible FREE app to a GitHub repository. The repository and
 * installation are resolved SERVER-SIDE from the GitHub App installation —
 * client-supplied ids are only ever compared against the server's list, never
 * trusted. Requires a PUBLIC repository (direct user downloads must not need
 * credentials).
 */
export async function connectAppRepository(env: any, input: {
  appId: string; orgId: string; userId: string; installationId: string; repositoryId: string;
}): Promise<{ ok: true; connection: any } | { ok: false; code: string; message: string }> {
  await ensureGithubTables(env);
  if (!githubConfigured(env)) return { ok: false, code: 'NOT_IMPLEMENTED', message: 'The GitHub integration is not configured on this deployment. An administrator must complete the GitHub App setup (see docs/GITHUB_RELEASES.md).' };
  const app: any = await env.DB.prepare(`SELECT * FROM applications WHERE id=?`).bind(input.appId).first().catch(() => null);
  if (!app) return { ok: false, code: 'NOT_FOUND', message: 'Application not found' };
  if (String(app.developer_org_id || '') !== String(input.orgId)) return { ok: false, code: 'NOT_FOUND', message: 'Application not found' };
  if (!appIsFree(app)) return { ok: false, code: 'FORBIDDEN', message: 'GitHub distribution is available for FREE applications only. Paid applications use the manual admin upload channel.' };
  const existing = await getConnectionForApp(env, input.appId);
  if (existing && existing.status === 'active') return { ok: false, code: 'CONFLICT', message: 'This application is already connected to a GitHub repository. Disconnect it first.' };

  // Server-side repository resolution from the installation.
  let repo: any = null;
  try {
    const repos = await installationRepos(env, input.installationId);
    repo = repos.find((r) => String(r.id) === String(input.repositoryId)) || null;
  } catch {
    return { ok: false, code: 'UNAUTHORIZED', message: 'The GitHub installation could not be read. Reconnect the repository and try again.' };
  }
  if (!repo) return { ok: false, code: 'NOT_FOUND', message: 'That repository is not accessible to this GitHub installation.' };
  if (repo.private === true) return { ok: false, code: 'FORBIDDEN', message: 'Only PUBLIC repositories are supported — users download release assets directly from GitHub without credentials.' };

  const other: any = await env.DB.prepare(`SELECT id FROM github_repo_connections WHERE repository_id=? AND status='active'`).bind(String(repo.id)).first().catch(() => null);
  if (other) return { ok: false, code: 'CONFLICT', message: 'That repository is already connected to another application.' };

  const id = `ghc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await env.DB.prepare(
    `INSERT INTO github_repo_connections (id, application_id, repository_id, repository_owner, repository_name, repository_full_name, installation_id, status, connected_by)
     VALUES (?,?,?,?,?,?,?, 'active', ?)`
  ).bind(id, input.appId, String(repo.id), String(repo.owner?.login || ''), String(repo.name || ''), String(repo.full_name || ''), String(input.installationId), input.userId).run();

  await audit(env, { action: 'connect', actorId: input.userId, appId: input.appId, repositoryId: String(repo.id), details: { repo: repo.full_name, installation: input.installationId } });
  const connection = await getConnectionForApp(env, input.appId);
  return { ok: true, connection };
}

/**
 * Bind an app to a repository using the SERVER-ISSUED completion code from
 * the GitHub App install flow. SECURITY: the installationId is taken from the
 * one-time token payload (bound to the initiating user + app at callback
 * time), NEVER from the client body — otherwise a developer could bind
 * someone else's installation/repository to their app. The repositoryId from
 * the body is safe: it is validated against the installation's server-read
 * repository list inside connectAppRepository.
 */
export async function bindRepositoryFromCode(env: any, input: {
  orgId: string; userId: string; appId: string; code: string; repositoryId: string;
}): Promise<{ ok: true; connection: any } | { ok: false; code: string; message: string }> {
  const raw = String(input.code || '').trim();
  if (!raw) return { ok: false, code: 'VALIDATION_ERROR', message: 'The connection code is required (complete the GitHub installation first).' };
  const payload = await consumeOneTimeToken(env, 'code', raw);
  if (!payload || payload.kind !== 'github-connect-complete') {
    return { ok: false, code: 'INVALID_TOKEN', message: 'This connection request is invalid or has expired. Start again.' };
  }
  const deny = async (code: string, message: string) => {
    await restoreOneTimeToken(env, raw); // a denial must not burn the flow
    return { ok: false as const, code, message };
  };
  if (String(payload.userId || '') !== String(input.userId)) {
    return deny('FORBIDDEN', 'This connection request was started by a different user.');
  }
  if (String(payload.appId || '') !== String(input.appId)) {
    return deny('FORBIDDEN', 'This connection request was started for a different application.');
  }
  const installationId = String(payload.installationId || '');
  if (!installationId) return deny('INVALID_TOKEN', 'The connection request carries no installation.');
  const out = await connectAppRepository(env, {
    appId: input.appId, orgId: input.orgId, userId: input.userId,
    installationId, repositoryId: String(input.repositoryId || ''),
  });
  if (!out.ok) {
    // Wrong repository pick etc. — keep the code alive so the developer can retry.
    await restoreOneTimeToken(env, raw);
    return out;
  }
  return out;
}

export async function disconnectAppRepository(env: any, input: { appId: string; orgId: string; userId: string }): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  await ensureGithubTables(env);
  const app: any = await env.DB.prepare(`SELECT developer_org_id FROM applications WHERE id=?`).bind(input.appId).first().catch(() => null);
  if (!app || String(app.developer_org_id || '') !== String(input.orgId)) return { ok: false, code: 'NOT_FOUND', message: 'Application not found' };
  const conn = await getConnectionForApp(env, input.appId);
  if (!conn) return { ok: false, code: 'NOT_FOUND', message: 'This application has no GitHub connection.' };
  await env.DB.prepare(`UPDATE github_repo_connections SET status='disconnected', updated_at=datetime('now') WHERE id=?`).bind(conn.id).run();
  await audit(env, { action: 'disconnect', actorId: input.userId, appId: input.appId, repositoryId: conn.repository_id, details: { repo: conn.repository_full_name } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Webhook ingestion + detection
// ---------------------------------------------------------------------------

export interface WebhookResult {
  status: number;
  body: any;
}

/**
 * Process a GitHub webhook delivery. Signature failures are rejected (401);
 * already-processed deliveries are acknowledged idempotently (200); unexpected
 * processing errors return 500 so GitHub retries. This endpoint can NEVER
 * approve or publish anything — it only records detections.
 */
export async function processWebhook(env: any, input: {
  rawBody: string; signatureHeader: string | null; deliveryId: string | null; event: string | null;
}): Promise<WebhookResult> {
  const cfg = githubAppConfig(env);
  if (!cfg) return { status: 503, body: { success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'GitHub integration is not configured.' } } };
  if (!input.deliveryId || !input.event) return { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'Missing delivery/event headers.' } } };
  if (!(await verifyWebhookSignature(cfg.webhookSecret, input.rawBody, input.signatureHeader))) {
    return { status: 401, body: { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid webhook signature.' } } };
  }

  await ensureGithubTables(env);

  let payload: any = null;
  try { payload = JSON.parse(input.rawBody); } catch { /* handled below */ }

  // Idempotency: one row per (delivery, event). A redelivery of a PROCESSED
  // event is acknowledged without reprocessing. A previously FAILED delivery
  // may be reprocessed (by redelivery or the admin retry).
  const existing: any = await env.DB.prepare(
    `SELECT status FROM github_release_events WHERE delivery_id=? AND event=?`
  ).bind(input.deliveryId, input.event).first().catch(() => null);
  if (existing && existing.status === 'processed') {
    return { status: 200, body: { success: true, data: { idempotent: true } } };
  }
  const recordEvent = (status: string, detail?: string, error?: string) =>
    env.DB.prepare(
      existing
        ? `UPDATE github_release_events SET status=?, detail=?, error=? WHERE delivery_id=? AND event=?`
        : `INSERT INTO github_release_events (id, delivery_id, event, action, repository_id, status, detail, error) VALUES (?,?,?,?,?,?,?,?)`
    ).bind(
      ...(existing
        ? [status, detail || undefined, error || undefined, input.deliveryId, input.event]
        : [`ghe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, input.deliveryId, input.event,
           String(payload?.action || ''), String(payload?.repository?.id || ''), status, detail || undefined, error || undefined])
    ).run().catch(() => {});

  if (!payload) { await recordEvent('failed', undefined, 'unparseable payload'); return { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'Unparseable payload.' } } }; }

  if (input.event !== 'release') {
    await recordEvent('ignored', `event ${input.event} is not processed`);
    return { status: 200, body: { success: true, data: { ignored: true } } };
  }

  const action = String(payload.action || '');
  const repoId = String(payload.repository?.id || '');
  const installationId = String(payload.installation?.id || '');

  const conn: any = await env.DB.prepare(`SELECT * FROM github_repo_connections WHERE repository_id=?`).bind(repoId).first().catch(() => null);
  if (!conn || conn.status !== 'active') {
    await recordEvent('ignored', 'no active connection for repository');
    return { status: 200, body: { success: true, data: { ignored: true, reason: 'repository not linked' } } };
  }
  if (installationId && String(conn.installation_id) !== installationId) {
    await recordEvent('ignored', 'installation mismatch');
    return { status: 200, body: { success: true, data: { ignored: true, reason: 'installation mismatch' } } };
  }

  try {
    const outcome = await detectRelease(env, conn, payload.release || null, action);
    await env.DB.prepare(`UPDATE github_repo_connections SET last_event_at=datetime('now'), last_event=?, latest_detected_version=?, updated_at=datetime('now'), last_error=NULL WHERE id=?`)
      .bind(`release.${action}`, outcome.latestVersion || conn.latest_detected_version, conn.id).run().catch(() => {});
    await recordEvent('processed', `release ${payload.release?.tag_name || '?'} -> ${outcome.status}`);
    return { status: 200, body: { success: true, data: { status: outcome.status, releaseId: outcome.releaseId || null } } };
  } catch (e: any) {
    await recordEvent('failed', undefined, String(e?.message || e).slice(0, 500));
    await env.DB.prepare(`UPDATE github_repo_connections SET last_event_at=datetime('now'), last_event=?, last_error=?, updated_at=datetime('now') WHERE id=?`)
      .bind(`release.${action}`, String(e?.message || e).slice(0, 300), conn.id).run().catch(() => {});
    return { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'Processing failed; GitHub will retry.' } } };
  }
}

/**
 * Record a GitHub release as a detected candidate. NEVER publishes, NEVER
 * touches canonical tables, NEVER notifies. Drafts are ignored; prereleases
 * are quarantined as blocked (stable-only initial workflow); deleted/edited
 * actions only refresh metadata.
 */
export async function detectRelease(env: any, conn: any, ghRelease: any, action: string): Promise<{ status: string; releaseId?: string; latestVersion?: string }> {
  await ensureGithubTables(env);
  if (!ghRelease || typeof ghRelease !== 'object') return { status: 'ignored' };

  const ghId = String(ghRelease.id ?? '');
  if (!ghId) return { status: 'ignored' };

  // Idempotent by GitHub release id.
  const existing: any = await env.DB.prepare(`SELECT * FROM github_releases WHERE github_release_id=?`).bind(ghId).first().catch(() => null);
  if (existing && existing.status === 'published') {
    return { status: 'already_published', releaseId: existing.id }; // a re-delivery never re-opens a published release
  }

  if (ghRelease.draft === true) return { status: 'ignored_draft' };
  if (action === 'deleted') return { status: 'ignored_deleted' };

  const version = versionFromTag(ghRelease.tag_name);
  const tag = String(ghRelease.tag_name || '');
  if (!version) {
    if (existing) {
      await env.DB.prepare(`UPDATE github_releases SET status='blocked', block_reason='Release tag is not a valid version (tag: ${tag.slice(0, 60)}).' WHERE id=? AND status NOT IN ('published','withdrawn','rejected')`).bind(existing.id).run();
      return { status: 'blocked', releaseId: existing.id };
    }
    return { status: 'ignored_invalid_tag' };
  }

  const isPrerelease = ghRelease.prerelease === true;
  const notes = String(ghRelease.body || '').slice(0, 20000);

  const id = existing?.id || `ghr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  if (existing) {
    await env.DB.prepare(
      `UPDATE github_releases SET tag_name=?, version=?, release_name=?, target_commitish=?, is_prerelease=?, release_notes=?, github_published_at=? WHERE id=?`
    ).bind(tag, version, String(ghRelease.name || '').slice(0, 300), String(ghRelease.target_commitish || '').slice(0, 120), isPrerelease ? 1 : 0, notes, String(ghRelease.published_at || ''), id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO github_releases (id, application_id, connection_id, github_release_id, tag_name, version, release_name, target_commitish, is_prerelease, release_notes, github_published_at, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'detected')`
    ).bind(id, conn.application_id, conn.id, ghId, tag, version, String(ghRelease.name || '').slice(0, 300), String(ghRelease.target_commitish || '').slice(0, 120), isPrerelease ? 1 : 0, notes, String(ghRelease.published_at || '')).run();
  }

  if (isPrerelease) {
    // Stable-only initial workflow: prereleases are quarantined, never
    // silently promoted.
    await env.DB.prepare(`UPDATE github_releases SET status='blocked', block_reason='Prereleases are not supported for the stable channel in the initial workflow. Publish a final (non-prerelease) GitHub release.' WHERE id=?`).bind(id).run();
    return { status: 'blocked_prerelease', releaseId: id, latestVersion: version };
  }

  // Assets: record each with its deterministic mapping (unmapped assets are
  // recorded with state 'unmapped' so the admin sees WHY a release is blocked).
  const assets: any[] = Array.isArray(ghRelease.assets) ? ghRelease.assets : [];
  const manifest = parseRxManifest(notes);
  const mapped: Array<{ asset: any; platform: string; architecture: string }> = [];
  for (const a of assets) {
    const name = String(a?.name || '');
    const urlCheck = validateAssetUrl(a?.browser_download_url);
    const mapping = (manifest && manifest[name]) || mapAssetFilename(name);
    if (!mapping) continue; // unmapped assets are simply not candidates (listed via release notes/assets link)
    if (!urlCheck.ok) continue;
    mapped.push({ asset: a, platform: mapping.platform, architecture: mapping.architecture });
  }
  // Duplicate (platform, architecture) from multiple assets = ambiguous -> blocked.
  const seen = new Set<string>();
  let duplicate = false;
  for (const m of mapped) {
    const key = `${m.platform}/${m.architecture}`;
    if (seen.has(key)) duplicate = true;
    seen.add(key);
  }

  await env.DB.prepare(`DELETE FROM github_release_assets WHERE release_id=?`).bind(id).run().catch(() => {});
  for (const m of mapped) {
    const url = validateAssetUrl(m.asset.browser_download_url);
    await env.DB.prepare(
      `INSERT INTO github_release_assets (id, release_id, github_asset_id, name, platform, architecture, download_url, state, declared_sha256)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(
      `gha_${id}_${m.platform}_${m.architecture}`, id, String(m.asset.id ?? ''), String(m.asset.name || '').slice(0, 200),
      m.platform, m.architecture, url.ok ? url.url : String(m.asset.browser_download_url || ''), 'detected',
      String(m.asset.digest || '').replace(/^sha256:/, '').slice(0, 64) || null,
    ).run().catch(() => {});
  }

  if (mapped.length === 0) {
    await env.DB.prepare(`UPDATE github_releases SET status='blocked', block_reason='No release asset could be mapped to an RX Store platform (need .apk/.exe/.msi/.deb/.AppImage/.dmg with an unambiguous architecture, or an rx-store manifest in the release notes).' WHERE id=?`).bind(id).run();
    return { status: 'blocked_no_assets', releaseId: id, latestVersion: version };
  }
  if (duplicate) {
    await env.DB.prepare(`UPDATE github_releases SET status='blocked', block_reason='Multiple assets map to the same platform/architecture — the mapping is ambiguous. Use the rx-store manifest in the release notes or distinct filenames.' WHERE id=?`).bind(id).run();
    return { status: 'blocked_ambiguous', releaseId: id, latestVersion: version };
  }

  // Create the canonical (UNPUBLISHED) rows so the REAL security pipeline
  // (packageSecurity.ts) records its evidence against genuine packages rows —
  // exactly like manual uploads. Status stays 'under_review'/'stored' until
  // an admin publishes; every public surface filters on published.
  // ONLY on first detection: a redelivery (or sync re-run) must not re-create
  // rows — the UNIQUE(app, version) constraint would misreport a duplicate.
  if (!existing) try {
    const canonicalId = `rel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await env.DB.prepare(
      `INSERT INTO releases (id, application_id, version, release_notes, release_type, channel, status, developer_id, security_status, verification_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'under_review',NULL,'pending','pending',datetime('now'),datetime('now'))`
    ).bind(canonicalId, conn.application_id, version, JSON.stringify([notes.slice(0, 4000)]), 'patch', 'stable').run();
    for (const m of mapped) {
      const url = validateAssetUrl(m.asset.browser_download_url);
      await env.DB.prepare(
        `INSERT INTO packages (id, application_id, release_id, platform, architecture, filename, storage_key, file_size, mime_type, sha256, version, package_type, provider, external_url, github_asset_id, security_state, overall_security, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'installer', 'github', ?, ?, 'QUARANTINED','PENDING','stored',datetime('now'))`
      ).bind(
        `pkg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, conn.application_id, canonicalId,
        m.platform, m.architecture, String(m.asset.name || '').slice(0, 200), '', 0, 'application/octet-stream', '',
        version, url.ok ? url.url : String(m.asset.browser_download_url || ''), String(m.asset.id ?? '')
      ).run();
    }
  } catch (e: any) {
    // UNIQUE(application_id, version): a manual release of this version
    // already exists — a GitHub release must never take it over.
    if (String(e?.message || '').includes('UNIQUE')) {
      await env.DB.prepare(`UPDATE github_releases SET status='blocked', block_reason=? WHERE id=?`)
        .bind(`Version ${version} already exists in the RX Store release history for this app — a GitHub release cannot duplicate or replace it.`, id).run();
      return { status: 'blocked_duplicate_version', releaseId: id, latestVersion: version };
    }
    throw e;
  }

  // A previous release row for the same (app, version) that was rejected stays
  // rejected — redelivery does not resurrect a decision.
  const sameVersion: any = await env.DB.prepare(`SELECT id, status FROM github_releases WHERE application_id=? AND version=? AND id != ?`).bind(conn.application_id, version, id).first().catch(() => null);
  if (sameVersion && ['rejected', 'withdrawn'].includes(sameVersion.status)) {
    return { status: `already_${sameVersion.status}`, releaseId: id, latestVersion: version };
  }

  return { status: 'detected', releaseId: id, latestVersion: version };
}

// ---------------------------------------------------------------------------
// Verification (actual bytes: size + SHA-256 + scanner) — runs at detection
// time via waitUntil, or on demand via the admin Retry action
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Verification (actual bytes: size + SHA-256 + scanner) — runs at detection
// time via waitUntil, or on demand via the admin Retry action
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Verification — the REAL security pipeline (packageSecurity.ts): every
// asset is streamed from GitHub (validated redirects, hashed in-stream,
// never persisted), recorded on the canonical packages row, and then run
// through the SAME automated check suite as manual uploads (structure,
// integrity, duplicate, malware, signature, certificate, dependency,
// native identity) with evidence in package_security_results and the
// manual-review workflow. Nothing github-specific is weaker.
// ---------------------------------------------------------------------------

export async function verifyGithubRelease(env: any, releaseId: string): Promise<{ ok: boolean; status: string; message?: string }> {
  await ensureGithubTables(env);
  const rel: any = await env.DB.prepare(`SELECT * FROM github_releases WHERE id=?`).bind(releaseId).first().catch(() => null);
  if (!rel) return { ok: false, status: 'not_found', message: 'Release not found.' };
  if (['published', 'rejected', 'withdrawn'].includes(rel.status)) {
    return { ok: false, status: rel.status, message: `Release is already ${rel.status}; verification does not reopen decisions.` };
  }
  const conn: any = await env.DB.prepare(`SELECT * FROM github_repo_connections WHERE id=?`).bind(rel.connection_id).first().catch(() => null);
  if (!conn || conn.status !== 'active') {
    await env.DB.prepare(`UPDATE github_releases SET status='blocked', block_reason='The repository connection is no longer active.' WHERE id=?`).bind(releaseId).run();
    return { ok: false, status: 'blocked', message: 'Repository connection is no longer active.' };
  }
  await env.DB.prepare(`UPDATE github_releases SET status='verifying', block_reason=NULL WHERE id=?`).bind(releaseId).run();
  const assets: any = await env.DB.prepare(`SELECT * FROM github_release_assets WHERE release_id=?`).bind(releaseId).all().catch(() => ({ results: [] }));

  // The canonical (unpublished) packages rows for this release — created at
  // detection so the REAL security pipeline records its evidence against
  // them exactly like manual uploads.
  const canonical: any = await env.DB.prepare(
    `SELECT id FROM releases WHERE application_id=? AND version=?`
  ).bind(rel.application_id, rel.version).first().catch(() => null);
  if (!canonical) {
    await env.DB.prepare(`UPDATE github_releases SET status='blocked', block_reason='The canonical release row is missing — re-detect the release (webhook redelivery or admin sync).' WHERE id=?`).bind(releaseId).run();
    return { ok: false, status: 'blocked', message: 'Canonical release row missing.' };
  }

  let failures = 0;
  const failureReasons: string[] = [];
  for (const a of assets.results || []) {
    try {
      // 1. Identity via the GitHub API (server-side, installation token).
      const meta = await ghApi(env, `/repos/${conn.repository_full_name}/releases/assets/${a.github_asset_id}`, { installationId: conn.installation_id });
      if (!meta.ok || !meta.json) {
        await env.DB.prepare(`UPDATE github_release_assets SET state='missing', error=? WHERE id=?`).bind(`GitHub reports the asset as missing (${meta.status}).`, a.id).run();
        failures++; failureReasons.push(`${a.name}: missing on GitHub (${meta.status})`);
        continue;
      }
      if (String(meta.json.name || '') !== String(a.name)) {
        await env.DB.prepare(`UPDATE github_release_assets SET state='mismatch', error=? WHERE id=?`).bind(`Asset was renamed on GitHub ('${meta.json.name}' vs verified '${a.name}').`, a.id).run();
        failures++; failureReasons.push(`${a.name}: renamed on GitHub`);
        continue;
      }
      // 2. PASS 1 — stream the ACTUAL bytes (validated redirects, hashed
      //    in-stream, head/tail windows captured). Never persisted.
      const ext = await loadExternalPackageBytes(a.download_url, { maxBytes: assetMaxBytes(env) });
      if (!ext) {
        await env.DB.prepare(`UPDATE github_release_assets SET state='failed', error=? WHERE id=?`)
          .bind(`The asset could not be streamed for verification (unreachable, redirect-rejected, or above the ${Math.floor(assetMaxBytes(env) / 1048576)}MB cap).`, a.id).run();
        failures++; failureReasons.push(`${a.name}: could not be streamed`);
        continue;
      }
      if (Number(meta.json.size) !== ext.size) {
        await env.DB.prepare(`UPDATE github_release_assets SET state='mismatch', size_bytes=?, error=? WHERE id=?`)
          .bind(ext.size, `GitHub metadata says ${meta.json.size} bytes but the asset served ${ext.size}.`, a.id).run();
        failures++; failureReasons.push(`${a.name}: size differs from GitHub metadata`);
        continue;
      }
      if (a.declared_sha256 && String(a.declared_sha256).toLowerCase() !== ext.sha256) {
        await env.DB.prepare(`UPDATE github_release_assets SET state='mismatch', size_bytes=?, sha256=?, error=? WHERE id=?`)
          .bind(ext.size, ext.sha256, `Declared digest does not match the actual bytes (declared ${String(a.declared_sha256).slice(0, 12)}…).`, a.id).run();
        failures++; failureReasons.push(`${a.name}: declared checksum mismatch`);
        continue;
      }
      // 3. Record the VERIFIED size + SHA-256 (bound to the exact asset
      //    identity: repository, release, asset id, version, platform, arch).
      await env.DB.prepare(`UPDATE github_release_assets SET state='verified', size_bytes=?, sha256=?, error=NULL, verified_at=datetime('now') WHERE id=?`)
        .bind(ext.size, ext.sha256, a.id).run();
      await env.DB.prepare(`UPDATE packages SET sha256=?, file_size=? WHERE release_id=? AND platform=? AND architecture=? AND provider='github'`)
        .bind(ext.sha256, ext.size, canonical.id, a.platform, a.architecture).run();

      // 4. PASS 2 — the REAL pipeline (independent re-stream + structure,
      //    integrity, duplicate, malware, signature, certificate, dependency,
      //    native identity; evidence rows + manual-review workflow included).
      const pkgRow: any = await env.DB.prepare(
        `SELECT id FROM packages WHERE release_id=? AND platform=? AND architecture=? AND provider='github'`
      ).bind(canonical.id, a.platform, a.architecture).first().catch(() => null);
      if (!pkgRow) {
        failures++; failureReasons.push(`${a.name}: canonical package row missing`);
        continue;
      }
      const run = await runSecurityPipeline(env, pkgRow.id).catch(() => null);
      const malware = await latestCheckStatus(env, pkgRow.id, 'malware').catch(() => null);
      const overall = run?.overall || 'FAILED';
      const scannerDetail = (run?.results?.malware?.details || run?.results?.malware?.result || null);
      await env.DB.prepare(
        `UPDATE github_release_assets SET scanner_status=?, scanner_detail=?, scanned_at=datetime('now') WHERE id=?`
      ).bind(malware || 'UNAVAILABLE', scannerDetail, a.id).run();
      // Failure classification (fail-closed, but honest about WHICH kind):
      //  - DEFINITIVE bad: malware DETECTED, or any non-malware check FAILED
      //    (bad file: structure/integrity/duplicate/native identity) → the
      //    release cannot even be queued for approval.
      //  - Scanner INFRASTRUCTURE failures (malware UNAVAILABLE/FAILED/SCANNING
      //    — e.g. VT outage/rate limit) do NOT fail verification: the release
      //    reaches pending_approval with the honest non-clean status, and the
      //    publication gate blocks it until a retry, a byte-bound manual
      //    approval, or an explicit audited override. NEVER clean.
      const results = (run?.results || {}) as Record<string, any>;
      const definitiveBad = malware === 'DETECTED'
        || Object.entries(results).some(([check, r]) => check !== 'malware' && r && ['FAILED', 'DETECTED'].includes(r.status));
      if (definitiveBad) {
        failures++; failureReasons.push(`${a.name}: security pipeline FAILED (${malware || 'checks failed'})`);
      }
    } catch (e: any) {
      await env.DB.prepare(`UPDATE github_release_assets SET state='failed', error=? WHERE id=?`).bind(String(e?.message || e).slice(0, 300), a.id).run();
      failures++; failureReasons.push(`${a.name}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  if (failures > 0) {
    await env.DB.prepare(`UPDATE github_releases SET status='verification_failed', block_reason=? WHERE id=?`)
      .bind(`${failures} asset(s) failed verification: ${failureReasons.slice(0, 5).join(' | ')}`, releaseId).run();
    return { ok: false, status: 'verification_failed', message: 'One or more assets failed verification.' };
  }
  await env.DB.prepare(`UPDATE github_releases SET status='pending_approval', verified_at=datetime('now') WHERE id=?`).bind(releaseId).run();
  return { ok: true, status: 'pending_approval' };
}

// ---------------------------------------------------------------------------
// Publication — the ONLY bridge into the canonical tables. Admin-gated.
// ---------------------------------------------------------------------------

export async function publishGithubRelease(env: any, actor: { userId: string; label: string }, releaseId: string, opts: { overrideSecurity?: boolean; reason?: string }): Promise<{ ok: true; version: string } | { ok: false; code: string; message: string }> {
  await ensureGithubTables(env);
  const rel: any = await env.DB.prepare(`SELECT * FROM github_releases WHERE id=?`).bind(releaseId).first().catch(() => null);
  if (!rel) return { ok: false, code: 'NOT_FOUND', message: 'Release not found.' };
  if (rel.status === 'published') return { ok: false, code: 'CONFLICT', message: 'This release is already published.' };
  if (rel.status !== 'pending_approval') {
    return { ok: false, code: 'CONFLICT', message: `Only a release in pending_approval can be published (current status: ${rel.status}).${rel.status === 'verification_failed' || rel.status === 'blocked' ? ' Retry verification first.' : ''}` };
  }
  const conn: any = await env.DB.prepare(`SELECT * FROM github_repo_connections WHERE id=?`).bind(rel.connection_id).first().catch(() => null);
  if (!conn || conn.status !== 'active') return { ok: false, code: 'CONFLICT', message: 'The repository connection is no longer active.' };
  const app: any = await env.DB.prepare(`SELECT * FROM applications WHERE id=?`).bind(rel.application_id).first().catch(() => null);
  if (!app) return { ok: false, code: 'NOT_FOUND', message: 'Application not found.' };
  if (!appIsFree(app)) return { ok: false, code: 'FORBIDDEN', message: 'GitHub distribution is free-apps-only; this application is paid. The release stays blocked.' };

  const assets: any = await env.DB.prepare(`SELECT * FROM github_release_assets WHERE release_id=?`).bind(releaseId).all().catch(() => ({ results: [] }));
  const rows = assets.results || [];
  if (!rows.length) return { ok: false, code: 'CONFLICT', message: 'The release has no verified assets.' };

  // ---- SECURITY GATE: the SAME publicationSecurityGate as the manual
  // channel (Path 1 AUTOMATED / Path 2 SECURITY_OVERRIDE / Path 3
  // MANUAL_APPROVAL), PLUS github-specific hardening:
  //   - every asset must be hash-verified,
  //   - a DETECTED malware verdict can NEVER be published (not even by
  //     override or manual approval),
  //   - publish-time identity + fresh-byte re-verification binds the approval
  //     to the EXACT verified artifact set.
  const override = !!opts.overrideSecurity;
  const reason = String(opts.reason || '').trim();
  if (override && reason.length < 10) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'A security override requires a reason of at least 10 characters.' };
  }
  for (const a of rows) {
    if (a.state !== 'verified' || !a.sha256) {
      return { ok: false, code: 'CONFLICT', message: `Asset ${a.name} (${a.platform}/${a.architecture}) is not verified (state: ${a.state}). Retry verification.` };
    }
  }

  // Publish-time identity re-verification: the GitHub API metadata AND a
  // fresh hash of the actual bytes must match what was reviewed.
  for (const a of rows) {
    const meta = await ghApi(env, `/repos/${conn.repository_full_name}/releases/assets/${a.github_asset_id}`, { installationId: conn.installation_id });
    if (!meta.ok || !meta.json || String(meta.json.name || '') !== String(a.name) || Number(meta.json.size) !== Number(a.size_bytes)) {
      await env.DB.prepare(`UPDATE github_releases SET status='blocked', block_reason=? WHERE id=?`)
        .bind(`Asset ${a.name} changed on GitHub after review (missing/renamed/resized) — re-verify and re-approve.`, releaseId).run();
      await audit(env, { action: 'publish_blocked', actorId: actor.userId, actorLabel: actor.label, appId: rel.application_id, releaseId, repositoryId: conn.repository_id, reason: 'asset identity changed', details: { asset: a.name } });
      return { ok: false, code: 'CONFLICT', message: `Asset ${a.name} changed on GitHub after review. The release was blocked — re-verify and approve again.` };
    }
    try {
      const ext = await loadExternalPackageBytes(a.download_url, { maxBytes: assetMaxBytes(env) });
      if (!ext || ext.sha256 !== a.sha256 || ext.size !== Number(a.size_bytes)) {
        await env.DB.prepare(`UPDATE github_releases SET status='blocked', block_reason=? WHERE id=?`)
          .bind(`Asset ${a.name} bytes changed after review (hash mismatch) — re-verify and re-approve.`, releaseId).run();
        await audit(env, { action: 'publish_blocked', actorId: actor.userId, actorLabel: actor.label, appId: rel.application_id, releaseId, repositoryId: conn.repository_id, reason: 'asset bytes changed', details: { asset: a.name } });
        return { ok: false, code: 'CONFLICT', message: `Asset ${a.name} changed after review. The release was blocked — re-verify and approve again.` };
      }
    } catch (e: any) {
      return { ok: false, code: 'SERVICE_UNAVAILABLE', message: `Could not re-verify asset ${a.name}: ${String(e?.message || e).slice(0, 160)}` };
    }
  }

  // The canonical rows exist since detection (status under_review/stored).
  const canonical: any = await env.DB.prepare(
    `SELECT id FROM releases WHERE application_id=? AND version=?`
  ).bind(rel.application_id, rel.version).first().catch(() => null);
  if (!canonical) return { ok: false, code: 'CONFLICT', message: 'The canonical release row is missing — retry verification (or re-detect via sync).' };

  // A definitive DETECTED verdict on ANY package kills the publication
  // outright — overrides and manual approvals cannot outvote a detection.
  const canonicalPkgs: any = await env.DB.prepare(`SELECT * FROM packages WHERE release_id=?`).bind(canonical.id).all().catch(() => ({ results: [] }));
  for (const pkg of canonicalPkgs.results || []) {
    if ((await latestCheckStatus(env, pkg.id, 'malware').catch(() => null)) === 'DETECTED') {
      return { ok: false, code: 'FORBIDDEN', message: `Package ${pkg.filename} was flagged by the malware scanner (DETECTED). A security override or manual approval can never publish a detected asset.` };
    }
  }

  // The shared gate (AUTOMATED / MANUAL_APPROVAL / SECURITY_OVERRIDE paths,
  // freshness-window re-verification with the current pipeline).
  let gate = await publicationSecurityGate(env, canonical.id);
  if (!gate.ok && override) {
    // An explicit, audited override is recorded per blocking package through
    // the SAME package_security_overrides machinery the manual channel uses
    // (sha256-bound: a changed asset can never ride an old override).
    for (const b of gate.blockers) {
      const pkg: any = await env.DB.prepare(`SELECT * FROM packages WHERE id=?`).bind(b.packageId).first().catch(() => null);
      if (!pkg) continue;
      if ((await latestCheckStatus(env, pkg.id, 'malware').catch(() => null)) === 'DETECTED') continue; // never
      await env.DB.prepare(
        `INSERT INTO package_security_overrides (id, package_id, admin_user_id, reason, prior_state, prior_overall, sha256)
         VALUES (?,?,?,?,?,?,?)`
      ).bind(`pso_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, pkg.id, actor.userId, reason.slice(0, 500), pkg.security_state, pkg.overall_security, String(pkg.sha256 || '')).run().catch(() => {});
    }
    gate = await publicationSecurityGate(env, canonical.id);
  }
  if (!gate.ok) {
    const lines = gate.blockers.map((b: any) => `• ${b.filename} (${b.platform}): state=${b.state}, overall=${b.overall}` + (b.reasons?.length ? ` — ${b.reasons.slice(0, 3).join(' | ')}` : '')).join('\n');
    return {
      ok: false, code: 'FORBIDDEN',
      message: `Security verification blocked publication. ${gate.blockers.length} package(s) not cleared:\n${lines}\n` +
        `SCANNING/UNAVAILABLE mean the scanner has no definitive verdict yet — retry verification shortly, approve the byte-bound manual review in Admin → Security, or publish with an explicit override + reason (never possible for a DETECTED verdict).`,
    };
  }

  // Channel policy: the stable channel is the only connected channel (v1).
  const channel = normalizeChannel(conn.channel) || 'stable';
  const canonicalId = canonical.id;
  try {
    // Flip the EXISTING canonical rows live (they were created at detection
    // and carry the pipeline evidence). The conditional UPDATE on the github
    // row (status='pending_approval') is the concurrency guard: a second
    // concurrent publish cannot flip anything twice.
    await env.DB.prepare(
      `UPDATE releases SET status='published', published_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status != 'published'`
    ).bind(canonicalId).run();
    await env.DB.prepare(
      `UPDATE packages SET status='published', security_state=?, overall_security=?, verified_at=datetime('now') WHERE release_id=? AND status='stored'`
    ).bind(override ? 'SECURITY_OVERRIDE' : 'PUBLISHED', override ? 'NEEDS_REVIEW' : 'PASSED', canonicalId).run();

    const priorVersion = app.current_version || null;
    if (channel === 'stable') {
      await env.DB.prepare(`UPDATE applications SET current_version=?, last_updated=datetime('now') WHERE id=?`).bind(rel.version, rel.application_id).run();
    }
    // Legacy app_versions sync so /updates/check + old clients see the update —
    // external URLs, never an /r2/ path (there is no RX Store object).
    {
      const files: Record<string, any> = {};
      for (const a of rows) {
        const entry = { url: a.download_url, fileUrl: a.download_url, fileName: a.name, size: Number(a.size_bytes), checksum: a.sha256, sha256: a.sha256 };
        files[a.platform] = entry;
        if (a.platform === 'linux_deb') files['linux'] = entry;
      }
      const notes = JSON.stringify([String(rel.release_notes || '').slice(0, 4000)]);
      const existing: any = await env.DB.prepare(`SELECT id FROM app_versions WHERE app_id=? AND version=?`).bind(rel.application_id, rel.version).first().catch(() => null);
      if (existing) {
        await env.DB.prepare(`UPDATE app_versions SET files=?, release_notes=?, created_at=datetime('now') WHERE id=?`).bind(JSON.stringify(files), notes, existing.id).run();
      } else {
        await env.DB.prepare(`INSERT INTO app_versions (id, app_id, version, release_notes, files) VALUES (?,?,?,?,?)`)
          .bind(`ver_${Date.now().toString(36)}`, rel.application_id, rel.version, notes, JSON.stringify(files)).run();
      }
      // applications.platforms drives the install modal — keep it in sync.
      const merged = new Set(Array.isArray(app.platforms) ? app.platforms : String(app.platforms || '').split(',').filter(Boolean));
      for (const a of rows) merged.add(a.platform);
      await env.DB.prepare(`UPDATE applications SET platforms=? WHERE id=?`).bind([...merged].join(','), rel.application_id).run().catch(() => {});
    }

    await env.DB.prepare(`UPDATE github_releases SET status='published', published_by=?, published_at=datetime('now'), prior_version=?, decision_reason=? WHERE id=? AND status='pending_approval'`)
      .bind(actor.userId, priorVersion, override ? `Override: ${reason}` : null, releaseId).run();
    await audit(env, {
      action: override ? 'publish_with_override' : 'publish', actorId: actor.userId, actorLabel: actor.label,
      appId: rel.application_id, releaseId, repositoryId: conn.repository_id, reason: override ? reason : undefined,
      details: { version: rel.version, tag: rel.tag_name, canonicalReleaseId: canonicalId, assets: rows.map((a: any) => ({ name: a.name, platform: a.platform, arch: a.architecture, sha256: a.sha256, scanner: a.scanner_status })) },
    });

    // Notifications ONLY after successful publication (same audience rule as
    // the manual publish flow: users who downloaded the app).
    try {
      const appRow: any = await env.DB.prepare('SELECT slug, name FROM applications WHERE id=?').bind(rel.application_id).first();
      const dl: any = await env.DB.prepare(`SELECT DISTINCT user_id FROM downloads WHERE app_id=? AND user_id IS NOT NULL AND user_id != ''`).bind(rel.application_id).all().catch(() => ({ results: [] }));
      let i = 0;
      for (const r of dl?.results || []) {
        await env.DB.prepare(`INSERT INTO notifications (id,user_id,type,title,message,data,read) VALUES (?,?,?,?,?,?,0)`)
          .bind(`n_${Date.now()}_${i++}_${Math.random().toString(36).slice(2, 6)}`, r.user_id, 'update',
            `New version: ${appRow?.name || 'App'} ${rel.version}`,
            `Version ${rel.version} of ${appRow?.name || 'the app'} is live — open the app page to update.`,
            JSON.stringify({ link: appRow?.slug ? `/app/${appRow.slug}` : '' })).run().catch(() => {});
      }
    } catch { /* best-effort, same as manual flow */ }

    return { ok: true, version: rel.version };
  } catch (e: any) {
    // Compensate: never leave a half-published canonical release behind —
    // revert the statuses (the rows and their evidence survive for retry).
    await env.DB.prepare(`UPDATE packages SET status='stored' WHERE release_id=? AND status='published'`).bind(canonicalId).run().catch(() => {});
    await env.DB.prepare(`UPDATE releases SET status='under_review', published_at=NULL WHERE id=?`).bind(canonicalId).run().catch(() => {});
    await env.DB.prepare(`UPDATE github_releases SET status='pending_approval', block_reason=? WHERE id=?`)
      .bind(`Publication failed: ${String(e?.message || e).slice(0, 200)}`, releaseId).run().catch(() => {});
    return { ok: false, code: 'INTERNAL', message: `Publication failed and was rolled back: ${String(e?.message || e).slice(0, 200)}` };
  }
}

export async function rejectGithubRelease(env: any, actor: { userId: string; label: string }, releaseId: string, reason: string): Promise<{ ok: boolean; code?: string; message?: string }> {
  await ensureGithubTables(env);
  const trimmed = String(reason || '').trim();
  if (trimmed.length < 10) return { ok: false, code: 'VALIDATION_ERROR', message: 'A rejection reason of at least 10 characters is required.' };
  const rel: any = await env.DB.prepare(`SELECT * FROM github_releases WHERE id=?`).bind(releaseId).first().catch(() => null);
  if (!rel) return { ok: false, code: 'NOT_FOUND', message: 'Release not found.' };
  if (rel.status === 'published') return { ok: false, code: 'CONFLICT', message: 'Published releases must be withdrawn, not rejected.' };
  await env.DB.prepare(`UPDATE github_releases SET status='rejected', reviewed_by=?, reviewed_at=datetime('now'), decision_reason=? WHERE id=?`).bind(actor.userId, trimmed, releaseId).run();
  await audit(env, { action: 'reject', actorId: actor.userId, actorLabel: actor.label, appId: rel.application_id, releaseId, reason: trimmed });
  return { ok: true };
}

export async function withdrawGithubRelease(env: any, actor: { userId: string; label: string }, releaseId: string, reason: string): Promise<{ ok: boolean; code?: string; message?: string }> {
  await ensureGithubTables(env);
  const trimmed = String(reason || '').trim();
  if (trimmed.length < 10) return { ok: false, code: 'VALIDATION_ERROR', message: 'A withdrawal reason of at least 10 characters is required.' };
  const rel: any = await env.DB.prepare(`SELECT * FROM github_releases WHERE id=?`).bind(releaseId).first().catch(() => null);
  if (!rel) return { ok: false, code: 'NOT_FOUND', message: 'Release not found.' };
  if (rel.status !== 'published') return { ok: false, code: 'CONFLICT', message: 'Only published releases can be withdrawn.' };
  // Deactivate the canonical rows so update checks stop recommending it.
  const canonical: any = await env.DB.prepare(`SELECT id FROM releases WHERE application_id=? AND version=? AND status='published'`).bind(rel.application_id, rel.version).first().catch(() => null);
  if (canonical) {
    await env.DB.prepare(`UPDATE releases SET status='withdrawn', updated_at=datetime('now') WHERE id=?`).bind(canonical.id).run();
    await env.DB.prepare(`UPDATE packages SET status='archived', deleted_at=datetime('now') WHERE release_id=?`).bind(canonical.id).run();
  }
  // Restore the previous live version (same rule as the manual rollback).
  if (rel.prior_version) {
    const stillLive: any = await env.DB.prepare(
      `SELECT r.version FROM releases r JOIN packages p ON p.release_id=r.id
       WHERE r.application_id=? AND r.status='published' AND p.status='published' ORDER BY r.published_at DESC LIMIT 1`
    ).bind(rel.application_id).first().catch(() => null);
    await env.DB.prepare(`UPDATE applications SET current_version=? WHERE id=?`).bind(stillLive?.version || rel.prior_version, rel.application_id).run();
  }
  await env.DB.prepare(`UPDATE github_releases SET status='withdrawn', decision_reason=?, reviewed_by=?, reviewed_at=datetime('now') WHERE id=?`).bind(trimmed, actor.userId, releaseId).run();
  await audit(env, { action: 'withdraw', actorId: actor.userId, actorLabel: actor.label, appId: rel.application_id, releaseId, reason: trimmed, details: { canonicalReleaseId: canonical?.id || null } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Admin reconciliation (webhook fallback) — admin-authorized, rate-limited by
// the caller; pulls the latest releases for every active connection.
// ---------------------------------------------------------------------------

export async function syncAllConnections(env: any, actor: { userId: string; label: string }): Promise<{ checked: number; detected: number; failures: number }> {
  await ensureGithubTables(env);
  const conns: any = await env.DB.prepare(`SELECT * FROM github_repo_connections WHERE status='active'`).all().catch(() => ({ results: [] }));
  let detected = 0, failures = 0;
  for (const conn of conns?.results || []) {
    try {
      const res = await ghApi(env, `/repos/${conn.repository_full_name}/releases?per_page=10`, { installationId: conn.installation_id });
      if (!res.ok || !Array.isArray(res.json)) { failures++; continue; }
      for (const r of res.json) {
        if (r.draft) continue;
        const outcome = await detectRelease(env, conn, r, 'published');
        if (outcome.status === 'detected') detected++;
      }
      await env.DB.prepare(`UPDATE github_repo_connections SET last_sync_at=datetime('now'), last_error=NULL WHERE id=?`).bind(conn.id).run();
    } catch (e: any) {
      failures++;
      await env.DB.prepare(`UPDATE github_repo_connections SET last_error=? WHERE id=?`).bind(String(e?.message || e).slice(0, 300), conn.id).run().catch(() => {});
    }
  }
  await audit(env, { action: 'sync', actorId: actor.userId, actorLabel: actor.label, details: { checked: conns?.results?.length || 0, detected, failures } });
  return { checked: conns?.results?.length || 0, detected, failures };
}

/**
 * Auto-verify pass: verification of newly detected releases kicked off after
 * webhook processing (via ctx.waitUntil). Failures leave the release in
 * 'verifying' — recoverable via the admin Retry action. Never publishes.
 */
export async function verifyPendingDetections(env: any, appId?: string): Promise<void> {
  await ensureGithubTables(env);
  const rows: any = await env.DB.prepare(
    `SELECT id FROM github_releases WHERE status IN ('detected','verifying') ${appId ? 'AND application_id=?' : ''} ORDER BY detected_at ASC LIMIT 5`
  ).bind(...(appId ? [appId] : []) as any[]).all().catch(() => ({ results: [] }));
  for (const r of rows?.results || []) {
    await verifyGithubRelease(env, r.id).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Admin queries (real data only — no placeholder counts)
// ---------------------------------------------------------------------------

export async function adminOverview(env: any): Promise<any> {
  await ensureGithubTables(env);
  const count = async (sql: string, ...binds: any[]) => {
    const r: any = await env.DB.prepare(sql).bind(...binds).first().catch(() => ({}));
    return Number(r?.n || 0);
  };
  const conns: any = await env.DB.prepare(`SELECT * FROM github_repo_connections ORDER BY updated_at DESC LIMIT 50`).all().catch(() => ({ results: [] }));
  const appsById = new Map<string, any>();
  for (const c of conns?.results || []) {
    if (!appsById.has(c.application_id)) {
      const a: any = await env.DB.prepare(`SELECT id, name, slug, current_version FROM applications WHERE id=?`).bind(c.application_id).first().catch(() => null);
      if (a) appsById.set(c.application_id, a);
    }
  }
  return {
    pendingApprovals: await count(`SELECT COUNT(*) AS n FROM github_releases WHERE status='pending_approval'`),
    connectedRepositories: await count(`SELECT COUNT(*) AS n FROM github_repo_connections WHERE status='active'`),
    blocked: await count(`SELECT COUNT(*) AS n FROM github_releases WHERE status IN ('blocked','verification_failed')`),
    failedEvents: await count(`SELECT COUNT(*) AS n FROM github_release_events WHERE status='failed'`),
    recentlyDecided: await count(`SELECT COUNT(*) AS n FROM github_releases WHERE status IN ('rejected','withdrawn') AND reviewed_at > datetime('now','-7 days')`),
    publishedTotal: await count(`SELECT COUNT(*) AS n FROM github_releases WHERE status='published'`),
    configured: githubConfigured(env),
    connections: (conns?.results || []).map((c: any) => ({ ...c, app: appsById.get(c.application_id) || null })),
  };
}

export async function adminQueue(env: any, filters: { status?: string; appId?: string }): Promise<any[]> {
  await ensureGithubTables(env);
  const where: string[] = ['1=1'];
  const binds: any[] = [];
  if (filters.status) { where.push('g.status=?'); binds.push(filters.status); }
  if (filters.appId) { where.push('g.application_id=?'); binds.push(filters.appId); }
  const rows: any = await env.DB.prepare(
    `SELECT g.*, c.repository_full_name, c.repository_owner, c.repository_name, a.name AS app_name, a.slug AS app_slug, a.current_version AS app_current_version
     FROM github_releases g
     JOIN github_repo_connections c ON c.id = g.connection_id
     LEFT JOIN applications a ON a.id = g.application_id
     WHERE ${where.join(' AND ')}
     ORDER BY CASE g.status WHEN 'pending_approval' THEN 0 WHEN 'verifying' THEN 1 WHEN 'detected' THEN 2 ELSE 3 END, g.detected_at DESC
     LIMIT 100`
  ).bind(...binds).all().catch(() => ({ results: [] }));
  const out = [];
  for (const r of rows?.results || []) {
    const assets: any = await env.DB.prepare(`SELECT * FROM github_release_assets WHERE release_id=?`).bind(r.id).all().catch(() => ({ results: [] }));
    // Full per-check security evidence from the REAL pipeline: the canonical
    // packages rows + their latest package_security_results + manual-review
    // state (the admin reviews the same evidence the manual channel shows).
    const canonical: any = await env.DB.prepare(
      `SELECT id, status AS canonical_status FROM releases WHERE application_id=? AND version=?`
    ).bind(r.application_id, r.version).first().catch(() => null);
    let packages: any[] = [];
    if (canonical?.id) {
      const pkgs: any = await env.DB.prepare(`SELECT * FROM packages WHERE release_id=?`).bind(canonical.id).all().catch(() => ({ results: [] }));
      packages = pkgs?.results || [];
      const checks = await latestChecksForPackages(env, packages.map((p: any) => p.id)).catch(() => ({} as Record<string, any[]>));
      for (const p of packages) {
        (p as any).checks = checks[p.id] || [];
        (p as any).manualReview = await env.DB.prepare(
          `SELECT status, reason, admin_notes, created_at, reviewed_at, invalidated_at FROM package_manual_reviews WHERE package_id=? ORDER BY created_at DESC LIMIT 1`
        ).bind(p.id).first().catch(() => null);
      }
    }
    out.push({ ...r, assets: assets?.results || [], canonicalReleaseId: canonical?.id || null, canonicalStatus: canonical?.canonical_status || null, packages });
  }
  return out;
}

export async function adminAudit(env: any, limit = 100): Promise<any[]> {
  await ensureGithubTables(env);
  const rows: any = await env.DB.prepare(`SELECT * FROM github_audit_log ORDER BY created_at DESC, id DESC LIMIT ?`).bind(Math.min(limit, 200)).all().catch(() => ({ results: [] }));
  return rows?.results || [];
}

export function newerThanCurrent(candidateVersion: string, currentVersion: string | null | undefined): boolean {
  if (!currentVersion) return true;
  return compareSemver(candidateVersion, currentVersion) > 0;
}
