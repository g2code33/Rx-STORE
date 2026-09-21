/**
 * Developer App Management & Release Submission (Phase 12).
 *
 * Extends the Phase 11 developer platform and the EXISTING marketplace
 * release/package architecture (applications / releases / packages — the
 * Prompt 7 canonical model). No duplicate tables; admin tooling keeps working.
 *
 * Security model (all server-side):
 *   - Organization comes from the caller's own developer_members row.
 *   - App ownership  = applications.developer_org_id === caller's org.
 *   - Release ownership = releases.developer_id === caller's org AND the
 *     release's app belongs to the same org.
 *   - Package uploads go through the SAME writePackageRow the admin flow uses
 *     (unique per release+platform+architecture, old-schema tolerant).
 *   - File size + SHA-256 are computed IN THE WORKER from the uploaded bytes —
 *     never from client-supplied values.
 *   - Submission locks editable fields; publication additionally requires an
 *     explicit admin approval (status='approved') — see admin.ts publishRelease.
 *   - Draft/submitted/rejected apps + releases are never publicly visible:
 *     apps.list shows status='active' only and apps.detail rejects
 *     non-public statuses (PUBLIC_APP_STATUSES).
 *   - security_scan_status / signature_status / verification statuses stay
 *     'pending' — Prompt 13 builds the real verification pipeline. Nothing in
 *     this phase marks a package safe.
 */

import {
  resolveMembership, requirePermission, auditDev, notify, notifyAdmins, rid, str, isHttpUrl,
} from './developers.ts';
import { writePackageRow } from './admin.ts';
import { parseSemver, normalizeChannel } from '../services/releases.ts';
import { permissionsForRole } from '../services/developerPermissions.ts';
import { runSecurityPipeline, latestChecksForPackages } from '../services/packageSecurity.ts';
import { ensureSubmission, syncSubmissionOnReleaseAction } from './submissions.ts';

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

/** Application platforms (display ids used by applications.platforms). */
const APP_PLATFORMS = ['web', 'windows', 'linux', 'android', 'ios'];
/** Package platforms (existing marketplace model, admin's ALLOWED_PLATFORMS). */
const PACKAGE_PLATFORMS = ['android', 'windows', 'linux_deb', 'linux_appimage', 'macos', 'flatpak', 'web', 'pwa', 'ios'];
/** Allowed file extensions per package platform (no invented package types). */
const EXT_WHITELIST: Record<string, string[]> = {
  windows: ['exe', 'msi'],
  linux_deb: ['deb'],
  linux_appimage: ['appimage'],
  android: ['apk', 'aab'],
  macos: ['dmg', 'pkg'],
  flatpak: ['flatpak'],
  web: ['zip'],
};
/** Platforms delivered by deployment URL, not a file (iOS stays PWA-based). */
const URL_PLATFORMS = ['web', 'pwa', 'ios'];
/** One-shot upload ceiling (same budget as the admin upload; big files need chunked upload, a later phase). */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function userIdOf(request: Request): string | null {
  return ((request as any).user as any)?.userId || null;
}

async function bodyOf(request: Request): Promise<any> {
  return await request.json().catch(() => ({}));
}

function slugify(name: string): string {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'app';
}

async function uniqueSlug(env: any, base: string): Promise<string> {
  let slug = base;
  for (let i = 0; i < 5; i++) {
    const taken: any = await env.DB.prepare('SELECT id FROM applications WHERE slug=?').bind(slug).first().catch(() => null);
    if (!taken) return slug;
    slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Resolve an app the caller's org owns (never another org's). */
async function ownApp(env: any, orgId: string, appId: string) {
  const app: any = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(appId).first().catch(() => null);
  if (!app) return { error: 'App not found', code: 'NOT_FOUND' as const };
  if (app.developer_org_id !== orgId) return { error: 'App not found', code: 'NOT_FOUND' as const };
  return { app };
}

/** Resolve a release the caller's org owns (release + app both checked). */
async function ownRelease(env: any, orgId: string, releaseId: string) {
  const rel: any = await env.DB.prepare('SELECT * FROM releases WHERE id=?').bind(releaseId).first().catch(() => null);
  if (!rel) return { error: 'Release not found', code: 'NOT_FOUND' as const };
  if (rel.developer_id !== orgId) return { error: 'Release not found', code: 'NOT_FOUND' as const };
  const appRes = await ownApp(env, orgId, rel.application_id);
  if ('error' in appRes && (appRes as any).error) return appRes;
  return { rel, app: (appRes as any).app };
}

/** Find or create the communication thread for a release (existing developer_threads). */
async function releaseThread(env: any, orgId: string, app: any, rel: any): Promise<string> {
  const existing: any = await env.DB.prepare('SELECT id FROM developer_threads WHERE related_release_id=?').bind(rel.id).first().catch(() => null);
  if (existing) return existing.id;
  const id = rid('dt');
  await env.DB.prepare(
    `INSERT INTO developer_threads (id, developer_id, subject, related_app_id, related_release_id, status, action_required)
     VALUES (?,?,?,?,?, 'AWAITING_ADMIN', 1)`
  ).bind(id, orgId, `Release ${rel.version} — ${app.name}`, app.id, rel.id).run().catch(() => {});
  return id;
}

async function postToThread(env: any, threadId: string, senderUserId: string, context: 'DEVELOPER' | 'ADMIN', body: string) {
  await env.DB.prepare(
    `INSERT INTO developer_thread_messages (id, thread_id, sender_user_id, sender_context, body) VALUES (?,?,?,?,?)`
  ).bind(rid('dmsg'), threadId, senderUserId, context, body).run().catch(() => {});
  await env.DB.prepare(`UPDATE developer_threads SET status=?, action_required=?, updated_at=datetime('now') WHERE id=?`)
    .bind(context === 'ADMIN' ? 'AWAITING_DEVELOPER' : 'AWAITING_ADMIN', context === 'ADMIN' ? 0 : 1, threadId).run().catch(() => {});
}

async function notifyOrg(env: any, orgId: string, title: string, message: string, data: Record<string, unknown> = {}) {
  const members: any = await env.DB.prepare('SELECT user_id FROM developer_members WHERE developer_id=?').bind(orgId).all().catch(() => ({ results: [] }));
  for (const m of members?.results || []) await notify(env, m.user_id, 'update', title, message, data);
}

function releaseView(rel: any, app: any) {
  return {
    id: rel.id, appId: rel.application_id, appSlug: app?.slug, appName: app?.name,
    version: rel.version, buildNumber: rel.build_number, releaseType: rel.release_type,
    channel: rel.channel, releaseNotes: rel.release_notes, featureSummary: rel.feature_summary,
    callToAction: rel.call_to_action, minimumSupportedVersion: rel.minimum_supported_version,
    status: rel.status, securityStatus: rel.security_status, verificationStatus: rel.verification_status,
    reviewReason: rel.review_reason, reviewerId: rel.reviewer_id,
    createdAt: rel.created_at, submittedAt: rel.submitted_at, reviewedAt: rel.reviewed_at, publishedAt: rel.published_at,
  };
}

function appView(app: any, extra: Record<string, unknown> = {}) {
  return {
    id: app.id, slug: app.slug, name: app.name, description: app.description,
    longDescription: app.long_description, category: app.category, tags: app.tags,
    icon: app.icon, screenshots: app.screenshots, status: app.status,
    platforms: app.platforms, website: app.website, currentVersion: app.current_version,
    developer: app.developer, developerOrgId: app.developer_org_id,
    lastUpdated: app.last_updated || app.updated_at, createdAt: app.created_at,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Developer routes
// ---------------------------------------------------------------------------

export const developerAppRoutes = {

  /** POST /developers/apps — create an app (draft; never public until admin approval). */
  async createApp(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'app.create');
    if ('error' in guard && (guard as any).error) return guard;
    const ms = (guard as any).ms;
    if (ms.developer.status !== 'ACTIVE') return { error: 'This organization is suspended', code: 'FORBIDDEN' };

    const body = await bodyOf(request);
    const name = str(body.name, 100);
    const description = str(body.description, 500);
    const longDescription = str(body.longDescription ?? body.long_description, 5000);
    const category = str(body.category, 30).toLowerCase();
    const tags = Array.isArray(body.tags) ? body.tags.slice(0, 12).map((t: any) => str(t, 30)).filter(Boolean) : [];
    const platformInput: any[] = Array.isArray(body.platforms) ? body.platforms : [];
    const platforms = [...new Set(platformInput.map((p: any) => String(p).toLowerCase().trim()))].filter((p: string) => APP_PLATFORMS.includes(p));
    const website = str(body.website, 300);
    const icon = str(body.icon, 500);

    if (name.length < 2) return { error: 'App name is required (2+ characters)', code: 'VALIDATION_ERROR' };
    if (description.length < 10) return { error: 'A short description of at least 10 characters is required', code: 'VALIDATION_ERROR' };
    if (!['healthcare', 'education', 'productivity', 'technology', 'gaming', 'social'].includes(category)) {
      return { error: 'Category must be one of: healthcare, education, productivity, technology, gaming, social', code: 'VALIDATION_ERROR' };
    }
    if (!platforms.length) return { error: 'Select at least one supported platform', code: 'VALIDATION_ERROR' };
    if (website && !isHttpUrl(website)) return { error: 'Website must be a valid http(s) URL', code: 'VALIDATION_ERROR' };
    if (icon && !isHttpUrl(icon)) return { error: 'Icon must be a valid http(s) URL', code: 'VALIDATION_ERROR' };

    const profile: any = await env.DB.prepare('SELECT publisher_name FROM developer_profiles WHERE developer_id=?').bind(ms.developer.id).first().catch(() => null);
    const id = `app_${Date.now()}`;
    const slug = await uniqueSlug(env, slugify(name));
    await env.DB.prepare(
      `INSERT INTO applications (id, slug, name, description, long_description, category, tags, developer, developer_id, icon, status, platforms, website, developer_org_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?, datetime('now'), datetime('now'))`
    ).bind(id, slug, name, description, longDescription || null, category, JSON.stringify(tags),
      profile?.publisher_name || 'RX Store Developer', userId, icon || null,
      JSON.stringify(platforms), website || null, ms.developer.id).run();

    await auditDev(env, ms.developer.id, userId, 'developer_app_created', { appId: id, slug, name });
    return { app: { id, slug, status: 'draft' } };
  },

  /** GET /developers/apps — the org's apps with release/status detail. */
  async listApps(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const rows: any = await env.DB.prepare(
      `SELECT * FROM applications WHERE developer_org_id=? ORDER BY created_at DESC`
    ).bind(ms.developer.id).all().catch(() => ({ results: [] }));
    const apps = [];
    for (const a of rows?.results || []) {
      const rels: any = await env.DB.prepare(
        `SELECT status, COUNT(*) AS c FROM releases WHERE application_id=? GROUP BY status`
      ).bind(a.id).all().catch(() => ({ results: [] }));
      const byStatus: Record<string, number> = {};
      for (const r of rels?.results || []) byStatus[r.status] = Number(r.c) || 0;
      const latest: any = await env.DB.prepare(
        `SELECT version, status, created_at FROM releases WHERE application_id=? ORDER BY created_at DESC LIMIT 1`
      ).bind(a.id).first().catch(() => null);
      apps.push(appView(a, {
        releaseCounts: byStatus,
        latestRelease: latest || null,
        pendingReview: (byStatus['submitted'] || 0) + (byStatus['under_review'] || 0) > 0,
      }));
    }
    return { apps };
  },

  /** GET /developers/apps/:id — app management view (ownership enforced). */
  async getApp(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const appId = new URL(request.url).pathname.split('/')[3] || '';
    const res = await ownApp(env, ms.developer.id, appId);
    if ('error' in res && (res as any).error) return res;
    const app = (res as any).app;

    const rels: any = await env.DB.prepare(
      `SELECT * FROM releases WHERE application_id=? ORDER BY created_at DESC`
    ).bind(appId).all().catch(() => ({ results: [] }));
    const releases = [];
    for (const r of rels?.results || []) {
      const pkgs: any = await env.DB.prepare(
        `SELECT id, platform, architecture, filename, file_size, mime_type, status, security_scan_status, signature_status, deployment_url, created_at
         FROM packages WHERE release_id=? ORDER BY created_at ASC`
      ).bind(r.id).all().catch(() => ({ results: [] }));
      releases.push({ ...releaseView(r, app), packages: pkgs?.results || [] });
    }
    const thread: any = await env.DB.prepare(
      'SELECT id, subject, status, updated_at FROM developer_threads WHERE related_app_id=? ORDER BY updated_at DESC LIMIT 1'
    ).bind(appId).first().catch(() => null);
    return { app: appView(app), releases, thread: thread || null, myRole: ms.member.role, permissions: permissionsForRole(ms.member.role) };
  },

  /** PATCH /developers/apps/:id — edit metadata (draft / changes requested only). */
  async updateApp(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'app.edit');
    if ('error' in guard && (guard as any).error) return guard;
    const ms = (guard as any).ms;
    const appId = new URL(request.url).pathname.split('/')[3] || '';
    const res = await ownApp(env, ms.developer.id, appId);
    if ('error' in res && (res as any).error) return res;
    const app = (res as any).app;
    if (!['draft', 'changes_requested'].includes(app.status)) {
      return { error: `App metadata is locked while status is ${app.status} (admin controls listing changes)`, code: 'FORBIDDEN' };
    }

    const body = await bodyOf(request);
    const fields: Record<string, any> = {};
    if (body.name !== undefined) { const v = str(body.name, 100); if (v.length < 2) return { error: 'App name must be at least 2 characters', code: 'VALIDATION_ERROR' }; fields.name = v; }
    if (body.description !== undefined) { const v = str(body.description, 500); if (v.length < 10) return { error: 'Description must be at least 10 characters', code: 'VALIDATION_ERROR' }; fields.description = v; }
    if (body.longDescription !== undefined) fields.long_description = str(body.longDescription, 5000) || null;
    if (body.category !== undefined) {
      const v = str(body.category, 30).toLowerCase();
      if (!['healthcare', 'education', 'productivity', 'technology', 'gaming', 'social'].includes(v)) return { error: 'Invalid category', code: 'VALIDATION_ERROR' };
      fields.category = v;
    }
    if (body.tags !== undefined) fields.tags = JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 12).map((t: any) => str(t, 30)).filter(Boolean) : []);
    if (body.platforms !== undefined) {
      const list: any[] = Array.isArray(body.platforms) ? body.platforms : [];
      const v = [...new Set(list.map((p: any) => String(p).toLowerCase().trim()))].filter((p: string) => APP_PLATFORMS.includes(p));
      if (!v.length) return { error: 'Select at least one platform', code: 'VALIDATION_ERROR' };
      fields.platforms = JSON.stringify(v);
    }
    if (body.icon !== undefined) { const v = str(body.icon, 500); if (v && !isHttpUrl(v)) return { error: 'Icon must be a URL', code: 'VALIDATION_ERROR' }; fields.icon = v || null; }
    if (body.screenshots !== undefined) fields.screenshots = JSON.stringify(Array.isArray(body.screenshots) ? body.screenshots.slice(0, 8).filter((s: any) => isHttpUrl(String(s))) : []);
    if (body.website !== undefined) { const v = str(body.website, 300); if (v && !isHttpUrl(v)) return { error: 'Website must be a URL', code: 'VALIDATION_ERROR' }; fields.website = v || null; }
    if (body.privacyUrl !== undefined) { const v = str(body.privacyUrl, 300); if (v && !isHttpUrl(v)) return { error: 'Privacy policy must be a URL', code: 'VALIDATION_ERROR' }; fields.privacy_url = v || null; }
    if (!Object.keys(fields).length) return { error: 'Nothing to update', code: 'VALIDATION_ERROR' };

    const sets = Object.keys(fields).map((k) => `${k}=?`).join(', ');
    await env.DB.prepare(`UPDATE applications SET ${sets}, updated_at=datetime('now') WHERE id=?`)
      .bind(...Object.values(fields), appId).run();
    await auditDev(env, ms.developer.id, userId, 'developer_app_updated', { appId, fields: Object.keys(fields) });
    return { success: true };
  },

  /** POST /developers/apps/:id/submit — submit the APP for admin approval. */
  async submitApp(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    if (!['OWNER', 'ADMIN', 'RELEASE_MANAGER', 'DEVELOPER'].includes(ms.member.role)) {
      return { error: `Your role (${ms.member.role}) cannot submit apps`, code: 'FORBIDDEN' };
    }
    const appId = new URL(request.url).pathname.split('/')[3] || '';
    const res = await ownApp(env, ms.developer.id, appId);
    if ('error' in res && (res as any).error) return res;
    const app = (res as any).app;
    if (!['draft', 'changes_requested'].includes(app.status)) {
      return { error: `Only draft or changes-requested apps can be submitted (current: ${app.status})`, code: 'FORBIDDEN' };
    }

    // Pre-submission validation — report EVERYTHING missing at once.
    const missing: string[] = [];
    if (!app.name || String(app.name).trim().length < 2) missing.push('App name');
    if (!app.description || String(app.description).trim().length < 10) missing.push('Short description (10+ characters)');
    if (!app.category) missing.push('Category');
    if (!app.icon) missing.push('Icon URL');
    let platforms: string[] = [];
    try { platforms = JSON.parse(app.platforms || '[]'); } catch { /* handled below */ }
    if (!platforms.length) missing.push('At least one supported platform');
    if (missing.length) return { error: `Before submitting, fix: ${missing.join(', ')}`, code: 'VALIDATION_ERROR', errors: missing };

    await env.DB.prepare(`UPDATE applications SET status='submitted', updated_at=datetime('now') WHERE id=?`).bind(appId).run();
    await auditDev(env, ms.developer.id, userId, 'developer_app_submitted', { appId });
    await notifyAdmins(env, 'Developer app submitted for review', `${app.name} was submitted for listing review.`, { appId });
    return { app: { id: appId, status: 'submitted' } };
  },

  /** POST /developers/apps/:id/releases — create a DRAFT release. */
  async createRelease(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'release.create');
    if ('error' in guard && (guard as any).error) return guard;
    const ms = (guard as any).ms;
    const appId = new URL(request.url).pathname.split('/')[3] || '';
    const res = await ownApp(env, ms.developer.id, appId);
    if ('error' in res && (res as any).error) return res;
    const app = (res as any).app;
    if (app.status !== 'active') {
      return { error: `Releases can only be created for approved apps (current status: ${app.status})`, code: 'FORBIDDEN' };
    }

    const body = await bodyOf(request);
    const version = str(String(body.version ?? ''), 40);
    if (!parseSemver(version)) return { error: `Version '${version}' is not a valid semver (e.g. 1.2.0)`, code: 'VALIDATION_ERROR' };
    const dup: any = await env.DB.prepare('SELECT id FROM releases WHERE application_id=? AND version=?').bind(appId, version).first().catch(() => null);
    if (dup) return { error: `Version ${version} already exists for this app — each version needs its own release`, code: 'VALIDATION_ERROR' };
    const channel = normalizeChannel(body.channel) || 'stable';
    const releaseType = ['major', 'minor', 'patch'].includes(String(body.releaseType)) ? String(body.releaseType) : 'patch';

    const id = rid('rel');
    await env.DB.prepare(
      `INSERT INTO releases (id, application_id, version, build_number, release_notes, feature_summary, call_to_action, release_type, channel, minimum_supported_version, status, developer_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'draft', ?, datetime('now'), datetime('now'))`
    ).bind(id, appId, version, str(body.buildNumber, 40) || null,
      JSON.stringify(Array.isArray(body.releaseNotes) ? body.releaseNotes.slice(0, 20).map((n: any) => str(n, 300)) : []),
      str(body.featureSummary, 1000) || null, str(body.callToAction, 200) || null,
      releaseType, channel, str(body.minimumSupportedVersion, 40) || null, ms.developer.id).run();

    await auditDev(env, ms.developer.id, userId, 'developer_release_created', { appId, releaseId: id, version });
    return { release: { id, version, status: 'draft' } };
  },

  /** GET /developers/releases/:id — release management view. */
  async getRelease(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const releaseId = new URL(request.url).pathname.split('/')[3] || '';
    const res = await ownRelease(env, ms.developer.id, releaseId);
    if ('error' in res && (res as any).error) return res;
    const { rel, app } = res as any;
    const pkgs: any = await env.DB.prepare(
      `SELECT id, platform, architecture, filename, file_size, mime_type, sha256, status, security_scan_status, signature_status, deployment_url, created_at
       FROM packages WHERE release_id=? ORDER BY created_at ASC`
    ).bind(releaseId).all().catch(() => ({ results: [] }));
    const thread: any = await env.DB.prepare('SELECT id, subject, status, updated_at FROM developer_threads WHERE related_release_id=?').bind(releaseId).first().catch(() => null);
    const pkgRows = pkgs?.results || [];
    const checks = await latestChecksForPackages(env, pkgRows.map((p: any) => p.id));
    return {
      release: releaseView(rel, app),
      packages: pkgRows.map((p: any) => ({ ...p, checks: checks[p.id] || [] })),
      app: appView(app), thread: thread || null,
    };
  },

  /** PATCH /developers/releases/:id — edit draft/changes-requested releases only. */
  async updateRelease(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'release.edit');
    if ('error' in guard && (guard as any).error) return guard;
    const ms = (guard as any).ms;
    const releaseId = new URL(request.url).pathname.split('/')[3] || '';
    const res = await ownRelease(env, ms.developer.id, releaseId);
    if ('error' in res && (res as any).error) return res;
    const { rel } = res as any;
    if (!['draft', 'changes_requested'].includes(rel.status)) {
      return { error: `Release fields are locked while status is ${rel.status}. Withdraw it or create a new release.`, code: 'FORBIDDEN' };
    }

    const body = await bodyOf(request);
    const fields: Record<string, any> = {};
    if (body.buildNumber !== undefined) fields.build_number = str(body.buildNumber, 40) || null;
    if (body.releaseNotes !== undefined) fields.release_notes = JSON.stringify(Array.isArray(body.releaseNotes) ? body.releaseNotes.slice(0, 20).map((n: any) => str(n, 300)) : []);
    if (body.featureSummary !== undefined) fields.feature_summary = str(body.featureSummary, 1000) || null;
    if (body.callToAction !== undefined) fields.call_to_action = str(body.callToAction, 200) || null;
    if (body.minimumSupportedVersion !== undefined) fields.minimum_supported_version = str(body.minimumSupportedVersion, 40) || null;
    // version/channel/release_type changes only while still a draft (never after
    // submission — a new version or channel needs a NEW release).
    if (body.version !== undefined && rel.status === 'draft') {
      const v = str(String(body.version ?? ''), 40);
      if (!parseSemver(v)) return { error: `Version '${v}' is not a valid semver`, code: 'VALIDATION_ERROR' };
      const dup: any = await env.DB.prepare('SELECT id FROM releases WHERE application_id=? AND version=? AND id != ?').bind(rel.application_id, v, rel.id).first().catch(() => null);
      if (dup) return { error: `Version ${v} already exists for this app`, code: 'VALIDATION_ERROR' };
      fields.version = v;
    }
    if (!Object.keys(fields).length) return { error: 'Nothing to update', code: 'VALIDATION_ERROR' };

    const sets = Object.keys(fields).map((k) => `${k}=?`).join(', ');
    await env.DB.prepare(`UPDATE releases SET ${sets}, updated_at=datetime('now') WHERE id=?`)
      .bind(...Object.values(fields), releaseId).run();
    await auditDev(env, ms.developer.id, userId, 'developer_release_updated', { releaseId, fields: Object.keys(fields) });
    return { success: true };
  },

  /** POST /developers/releases/:id/submit — full pre-submission validation. */
  async submitRelease(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    if (!['OWNER', 'ADMIN', 'RELEASE_MANAGER'].includes(ms.member.role)) {
      return { error: `Your role (${ms.member.role}) cannot submit releases`, code: 'FORBIDDEN' };
    }
    const releaseId = new URL(request.url).pathname.split('/')[3] || '';
    const res = await ownRelease(env, ms.developer.id, releaseId);
    if ('error' in res && (res as any).error) return res;
    const { rel, app } = res as any;
    if (!['draft', 'changes_requested'].includes(rel.status)) {
      return { error: `Only draft or changes-requested releases can be submitted (current: ${rel.status})`, code: 'FORBIDDEN' };
    }
    if (app.status !== 'active') {
      return { error: 'The app must be approved and listed before releases can be submitted', code: 'FORBIDDEN' };
    }

    // Pre-submission validation — everything missing reported at once.
    const missing: string[] = [];
    if (!rel.build_number) missing.push('Build number');
    let notes: string[] = [];
    try { notes = JSON.parse(rel.release_notes || '[]'); } catch { /* flagged below */ }
    if (!notes.length) missing.push('Release notes (at least one line)');
    const pkgs: any = await env.DB.prepare('SELECT platform, deployment_url, file_size FROM packages WHERE release_id=?').bind(releaseId).all().catch(() => ({ results: [] }));
    const packageRows = pkgs?.results || [];
    if (!packageRows.length) missing.push('At least one package (upload a file or set a web deployment URL)');
    let appPlatforms: string[] = [];
    try { appPlatforms = JSON.parse(app.platforms || '[]'); } catch { /* ignore */ }
    if (appPlatforms.includes('web') && !packageRows.some((p: any) => ['web', 'pwa', 'ios'].includes(p.platform))) {
      missing.push('A web deployment URL (the app lists web/iOS as a platform)');
    }
    if (missing.length) return { error: `Before submitting, fix: ${missing.join(', ')}`, code: 'VALIDATION_ERROR', errors: missing };

    await env.DB.prepare(
      `UPDATE releases SET status='submitted', submitted_at=datetime('now'), review_reason=NULL, updated_at=datetime('now') WHERE id=?`
    ).bind(releaseId).run();
    await auditDev(env, ms.developer.id, userId, 'developer_release_submitted', { releaseId, version: rel.version, appId: app.id });

    // Communication context (existing developer ↔ admin threads).
    const threadId = await releaseThread(env, ms.developer.id, app, rel);
    await postToThread(env, threadId, userId, 'DEVELOPER', `Release ${rel.version} (build ${rel.build_number}) submitted for review.`);

    // PHASE 14: the first-class submission record (security stage -> review).
    const submission = await ensureSubmission(env, { developerId: ms.developer.id, userId, app, release: rel }).catch(() => null);

    return { release: { id: releaseId, status: 'submitted' }, submission: submission ? { id: submission.id, status: submission.status } : null };
  },

  /** POST /developers/releases/:id/withdraw — developer withdraws a submission. */
  async withdrawRelease(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const releaseId = new URL(request.url).pathname.split('/')[3] || '';
    const res = await ownRelease(env, ms.developer.id, releaseId);
    if ('error' in res && (res as any).error) return res;
    const { rel, app } = res as any;
    if (!['draft', 'submitted', 'changes_requested'].includes(rel.status)) {
      return { error: `Only draft, submitted or changes-requested releases can be withdrawn (current: ${rel.status})`, code: 'FORBIDDEN' };
    }
    await env.DB.prepare(`UPDATE releases SET status='withdrawn', updated_at=datetime('now') WHERE id=?`).bind(releaseId).run();
    await auditDev(env, ms.developer.id, userId, 'developer_release_withdrawn', { releaseId, version: rel.version });
    const threadId = await releaseThread(env, ms.developer.id, app, rel);
    await postToThread(env, threadId, userId, 'DEVELOPER', `Release ${rel.version} was withdrawn by the developer.`);
    // PHASE 14: sync the submission record.
    await syncSubmissionOnReleaseAction(env, { releaseId, releaseStatus: 'withdrawn', adminId: userId }).catch(() => {});
    return { release: { id: releaseId, status: 'withdrawn' } };
  },

  /** POST /developers/releases/:id/packages — file upload (multipart). */
  async uploadPackage(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'package.upload');
    if ('error' in guard && (guard as any).error) return guard;
    const ms = (guard as any).ms;
    const releaseId = new URL(request.url).pathname.split('/')[3] || '';
    const res = await ownRelease(env, ms.developer.id, releaseId);
    if ('error' in res && (res as any).error) return res;
    const { rel, app } = res as any;
    if (!['draft', 'changes_requested'].includes(rel.status)) {
      return { error: `Packages can only be changed while the release is a draft or changes were requested (current: ${rel.status})`, code: 'FORBIDDEN' };
    }

    const form = await request.formData().catch(() => null);
    if (!form) return { error: 'Expected multipart form-data (file, platform)', code: 'VALIDATION_ERROR' };
    const file: any = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return { error: 'No file attached', code: 'VALIDATION_ERROR' };

    let platform = String(form.get('platform') || '').toLowerCase().trim();
    if (platform === 'linux' || platform === 'deb') platform = 'linux_deb';
    if (platform === 'appimage') platform = 'linux_appimage';
    if (!PACKAGE_PLATFORMS.includes(platform)) {
      return { error: `Invalid platform '${platform}'. Use: ${PACKAGE_PLATFORMS.join(', ')}`, code: 'VALIDATION_ERROR' };
    }
    if (URL_PLATFORMS.includes(platform)) {
      return { error: `Platform '${platform}' uses a deployment URL, not a file upload`, code: 'VALIDATION_ERROR' };
    }
    // The package platform must match a platform the app claims to support.
    let appPlatforms: string[] = [];
    try { appPlatforms = JSON.parse(app.platforms || '[]'); } catch { /* checked below */ }
    const displayFor: Record<string, string> = { linux_deb: 'linux', linux_appimage: 'linux', flatpak: 'linux', macos: 'ios', windows: 'windows', android: 'android' };
    const needed = displayFor[platform] || platform;
    if (!appPlatforms.includes(needed)) {
      return { error: `The app does not list '${needed}' as a supported platform — update the app's platforms first`, code: 'VALIDATION_ERROR' };
    }

    // Extension whitelist per platform (no invented package types).
    const ext = String(file.name || '').split('.').pop()?.toLowerCase() || '';
    const allowed = EXT_WHITELIST[platform] || [];
    if (!allowed.includes(ext)) {
      return { error: `'.${ext}' is not a valid ${platform} package. Allowed: ${allowed.map((e) => `.${e}`).join(', ')}`, code: 'VALIDATION_ERROR' };
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return { error: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the developer upload limit is 50 MB in this phase`, code: 'VALIDATION_ERROR' };
    }

    // Size + SHA-256 are computed IN THE WORKER from the actual bytes — the
    // client never supplies either.
    const buf: ArrayBuffer = await file.arrayBuffer();
    const digest: ArrayBuffer = await (crypto as any).subtle.digest('SHA-256', buf);
    const sha256 = Array.from(new Uint8Array(digest)).map((b: number) => b.toString(16).padStart(2, '0')).join('');
    const safeName = String(file.name || 'package.bin').replace(/[^\w.\-]+/g, '_');
    const architecture = String(form.get('architecture') || 'x64').toLowerCase();
    if (!['x64', 'arm64', 'x86', 'arm', 'universal'].includes(architecture)) {
      return { error: `Invalid architecture '${architecture}'. Use: x64, arm64, x86, arm, universal.`, code: 'VALIDATION_ERROR' };
    }
    // PHASE 13: uploads land in PRIVATE quarantine storage. The /r2/ serving
    // route blocks quarantine/ (and unpublished apps/) keys entirely — the
    // binary is unreachable by URL until its package is published.
    const storageKey = `quarantine/${app.slug}/${rel.version}/${platform}/${architecture}/${safeName}`;
    try {
      await env.STORAGE.put(storageKey, buf, { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
    } catch {
      return { error: 'Storage failed — the package was NOT saved. Try again.', code: 'INTERNAL' };
    }

    const saved = await writePackageRow(env, { ...rel, app_slug: app.slug }, platform, {
      filename: safeName, storageKey, size: file.size, mime: file.type || 'application/octet-stream', sha256, architecture,
    });
    if ((saved as any)?.error) return saved;

    // (Re-)uploading resets verification to pending — nothing is ever assumed
    // safe — then the real pipeline runs (structure/integrity/duplicate/
    // malware/signature/certificate/dependency/identity) and quarantines.
    await env.DB.prepare(
      `UPDATE packages SET quarantine_key=?, security_state='QUARANTINED', overall_security='PENDING',
         security_scan_status='pending', signature_status='pending', scan_at=NULL, verified_at=NULL
       WHERE release_id=? AND platform=? AND architecture=?`
    ).bind(storageKey, releaseId, platform, architecture).run().catch(() => {});
    let security: any = null;
    try {
      const row: any = await env.DB.prepare(
        'SELECT id FROM packages WHERE release_id=? AND platform=? AND architecture=?'
      ).bind(releaseId, platform, architecture).first();
      if (row) security = await runSecurityPipeline(env, row.id);
    } catch { /* results are recorded even when the response shape degrades */ }

    await auditDev(env, ms.developer.id, userId, 'developer_package_uploaded', { releaseId, platform, architecture, filename: safeName, size: file.size });
    return { package: saved, security };
  },

  /** POST /developers/releases/:id/deployment-url — web/PWA/iOS URL package. */
  async setDeploymentUrl(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'package.upload');
    if ('error' in guard && (guard as any).error) return guard;
    const ms = (guard as any).ms;
    const releaseId = new URL(request.url).pathname.split('/')[3] || '';
    const res = await ownRelease(env, ms.developer.id, releaseId);
    if ('error' in res && (res as any).error) return res;
    const { rel, app } = res as any;
    if (!['draft', 'changes_requested'].includes(rel.status)) {
      return { error: `Packages can only be changed while the release is a draft or changes were requested (current: ${rel.status})`, code: 'FORBIDDEN' };
    }

    const body = await bodyOf(request);
    const url = str(body.url, 500);
    const platform = String(body.platform || 'web').toLowerCase();
    if (!URL_PLATFORMS.includes(platform)) return { error: `Platform must be one of: ${URL_PLATFORMS.join(', ')}`, code: 'VALIDATION_ERROR' };
    if (!/^https:\/\//i.test(url)) return { error: 'The deployment URL must be HTTPS', code: 'VALIDATION_ERROR' };
    let appPlatforms: string[] = [];
    try { appPlatforms = JSON.parse(app.platforms || '[]'); } catch { /* ignore */ }
    const needed = platform === 'ios' ? 'ios' : 'web';
    if (!appPlatforms.includes(needed)) {
      return { error: `The app does not list '${needed}' as a supported platform`, code: 'VALIDATION_ERROR' };
    }

    // URL packages carry a server-computed digest of the URL itself (the PWA
    // flow opens the URL; file-hash semantics arrive with Prompt 13).
    const digest: ArrayBuffer = await (crypto as any).subtle.digest('SHA-256', new TextEncoder().encode(`pwa-url:${url}`));
    const sha256 = Array.from(new Uint8Array(digest)).map((b: number) => b.toString(16).padStart(2, '0')).join('');
    const saved = await writePackageRow(env, { ...rel, app_slug: app.slug }, platform === 'ios' ? 'ios' : platform, {
      filename: 'web-deployment', storageKey: url, size: 0, mime: 'text/uri', sha256, architecture: 'universal',
    });
    if ((saved as any)?.error) return saved;
    // Persist the deployment URL for the PWA download flow.
    await env.DB.prepare(
      `UPDATE packages SET deployment_url=?, security_scan_status='pending', signature_status='pending', scan_at=NULL, verified_at=NULL WHERE release_id=? AND platform=?`
    ).bind(url, releaseId, platform === 'ios' ? 'ios' : platform).run().catch(() => {});

    await auditDev(env, ms.developer.id, userId, 'developer_package_uploaded', { releaseId, platform, deploymentUrl: url });
    return { package: saved };
  },

  /** GET /developers/security/packages/:id — the developer security view (own packages only). */
  async getPackageSecurity(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const packageId = new URL(request.url).pathname.split('/')[4] || '';
    const pkg: any = await env.DB.prepare('SELECT * FROM packages WHERE id=?').bind(packageId).first().catch(() => null);
    if (!pkg) return { error: 'Package not found', code: 'NOT_FOUND' };
    const res = await ownRelease(env, ms.developer.id, String(pkg.release_id));
    if ('error' in res && (res as any).error) return res; // ownership: another org's package is "not found"
    const checks = (await latestChecksForPackages(env, [packageId]))[packageId] || [];
    const overrides: any = await env.DB.prepare(
      'SELECT reason, created_at FROM package_security_overrides WHERE package_id=? ORDER BY created_at DESC'
    ).bind(packageId).all().catch(() => ({ results: [] }));
    return {
      package: {
        id: pkg.id, platform: pkg.platform, architecture: pkg.architecture, filename: pkg.filename,
        sizeBytes: Number(pkg.file_size) || 0, sha256: pkg.sha256,
        securityState: pkg.security_state || 'QUARANTINED', overallSecurity: pkg.overall_security || 'PENDING',
      },
      checks,
      overridden: (overrides?.results || []).length > 0,
      overrideReason: (overrides?.results || [])[0]?.reason || null,
    };
  },
};

// ---------------------------------------------------------------------------
// Admin routes (admin JWT enforced by index.ts for /admin/*)
// ---------------------------------------------------------------------------

function adminPathId(request: Request, seg: number): string {
  return new URL(request.url).pathname.split('/')[seg] || '';
}

async function adminAudit(env: any, action: string, resourceId: string, details: Record<string, unknown> = {}) {
  await env.DB.prepare('INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?,?,?)')
    .bind(rid('log'), action, 'developer_release', resourceId, JSON.stringify(details)).run().catch(() => {});
}

export const adminDeveloperAppRoutes = {

  /** GET /admin/developers/apps?status= — developer-created apps. */
  async listApps(request: Request, env: any) {
    const status = new URL(request.url).searchParams.get('status') || '';
    const rows: any = await env.DB.prepare(
      `SELECT a.*, p.publisher_name FROM applications a
       LEFT JOIN developer_profiles p ON p.developer_id = a.developer_org_id
       WHERE a.developer_org_id IS NOT NULL ${status ? 'AND a.status=?' : ''}
       ORDER BY a.updated_at DESC LIMIT 200`
    ).bind(...(status ? [status] : [])).all().catch(() => ({ results: [] }));
    return {
      apps: (rows?.results || []).map((a: any) => ({
        ...appView(a), publisherName: a.publisher_name,
      })),
    };
  },

  /** GET /admin/developers/apps/:id — app + releases + org. */
  async getApp(request: Request, env: any) {
    const appId = adminPathId(request, 4);
    const app: any = await env.DB.prepare('SELECT * FROM applications WHERE id=? AND developer_org_id IS NOT NULL').bind(appId).first().catch(() => null);
    if (!app) return { error: 'Developer app not found', code: 'NOT_FOUND' };
    const profile: any = await env.DB.prepare('SELECT publisher_name, website FROM developer_profiles WHERE developer_id=?').bind(app.developer_org_id).first().catch(() => null);
    const rels: any = await env.DB.prepare('SELECT * FROM releases WHERE application_id=? ORDER BY created_at DESC').bind(appId).all().catch(() => ({ results: [] }));
    return { app: appView(app), publisher: profile || null, releases: (rels?.results || []).map((r: any) => releaseView(r, app)) };
  },

  /** POST /admin/developers/apps/:id/review — submitted -> under_review. */
  async startAppReview(request: Request, env: any) {
    const appId = adminPathId(request, 4);
    const app: any = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(appId).first().catch(() => null);
    if (!app) return { error: 'App not found', code: 'NOT_FOUND' };
    if (app.status !== 'submitted') return { error: `Only submitted apps can enter review (current: ${app.status})`, code: 'FORBIDDEN' };
    await env.DB.prepare(`UPDATE applications SET status='under_review', updated_at=datetime('now') WHERE id=?`).bind(appId).run();
    await adminAudit(env, 'developer_app_review_started', appId, {});
    await notifyOrg(env, app.developer_org_id, 'App under review', `${app.name} is now under review.`);
    return { app: { id: appId, status: 'under_review' } };
  },

  /** POST /admin/developers/apps/:id/approve — lists the app publicly (status active). */
  async approveApp(request: Request, env: any) {
    const appId = adminPathId(request, 4);
    const app: any = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(appId).first().catch(() => null);
    if (!app) return { error: 'App not found', code: 'NOT_FOUND' };
    if (!['submitted', 'under_review', 'changes_requested'].includes(app.status)) {
      return { error: `Only submitted/under-review apps can be approved (current: ${app.status})`, code: 'FORBIDDEN' };
    }
    await env.DB.prepare(`UPDATE applications SET status='active', updated_at=datetime('now') WHERE id=?`).bind(appId).run();
    await auditDev(env, app.developer_org_id, userIdOf(request), 'developer_app_approved', { appId });
    await adminAudit(env, 'developer_app_approved', appId, {});
    await notifyOrg(env, app.developer_org_id, 'App approved 🎉', `${app.name} is now listed on RX Store. You can create releases for it.`, { appId });
    return { app: { id: appId, status: 'active' } };
  },

  /** POST /admin/developers/apps/:id/reject — reason REQUIRED. */
  async rejectApp(request: Request, env: any) {
    const appId = adminPathId(request, 4);
    const reason = str((await bodyOf(request)).reason, 1000);
    if (reason.length < 10) return { error: 'A rejection reason of at least 10 characters is required', code: 'VALIDATION_ERROR' };
    const app: any = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(appId).first().catch(() => null);
    if (!app) return { error: 'App not found', code: 'NOT_FOUND' };
    if (app.status === 'active') return { error: 'This app is already listed — suspend it instead', code: 'FORBIDDEN' };
    await env.DB.prepare(`UPDATE applications SET status='archived', updated_at=datetime('now') WHERE id=?`).bind(appId).run();
    await auditDev(env, app.developer_org_id, userIdOf(request), 'developer_app_rejected', { appId, reason });
    await adminAudit(env, 'developer_app_rejected', appId, { reason });
    await notifyOrg(env, app.developer_org_id, 'App not approved', `${app.name} was not approved. Reason: ${reason}`);
    return { app: { id: appId, status: 'archived' } };
  },

  /** POST /admin/developers/apps/:id/request-changes — reason REQUIRED. */
  async requestAppChanges(request: Request, env: any) {
    const appId = adminPathId(request, 4);
    const reason = str((await bodyOf(request)).reason, 1000);
    if (reason.length < 10) return { error: 'A change request reason of at least 10 characters is required', code: 'VALIDATION_ERROR' };
    const app: any = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(appId).first().catch(() => null);
    if (!app) return { error: 'App not found', code: 'NOT_FOUND' };
    if (!['submitted', 'under_review'].includes(app.status)) {
      return { error: `Changes can only be requested on submitted/under-review apps (current: ${app.status})`, code: 'FORBIDDEN' };
    }
    await env.DB.prepare(`UPDATE applications SET status='changes_requested', updated_at=datetime('now') WHERE id=?`).bind(appId).run();
    await auditDev(env, app.developer_org_id, userIdOf(request), 'developer_app_changes_requested', { appId, reason });
    await adminAudit(env, 'developer_app_changes_requested', appId, { reason });
    await notifyOrg(env, app.developer_org_id, 'Changes requested on your app', `${app.name}: ${reason}`);
    return { app: { id: appId, status: 'changes_requested' } };
  },

  /** POST /admin/developers/apps/:id/suspend — unlists the app. */
  async suspendApp(request: Request, env: any) {
    const appId = adminPathId(request, 4);
    const app: any = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(appId).first().catch(() => null);
    if (!app) return { error: 'App not found', code: 'NOT_FOUND' };
    if (app.status !== 'active') return { error: 'Only listed apps can be suspended', code: 'FORBIDDEN' };
    await env.DB.prepare(`UPDATE applications SET status='suspended', updated_at=datetime('now') WHERE id=?`).bind(appId).run();
    await auditDev(env, app.developer_org_id, userIdOf(request), 'developer_app_suspended', { appId });
    await adminAudit(env, 'developer_app_suspended', appId, {});
    await notifyOrg(env, app.developer_org_id, 'App suspended', `${app.name} was suspended from the marketplace.`);
    return { app: { id: appId, status: 'suspended' } };
  },

  /** POST /admin/developers/apps/:id/reinstate */
  async reinstateApp(request: Request, env: any) {
    const appId = adminPathId(request, 4);
    const app: any = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(appId).first().catch(() => null);
    if (!app) return { error: 'App not found', code: 'NOT_FOUND' };
    if (app.status !== 'suspended') return { error: 'This app is not suspended', code: 'FORBIDDEN' };
    await env.DB.prepare(`UPDATE applications SET status='active', updated_at=datetime('now') WHERE id=?`).bind(appId).run();
    await auditDev(env, app.developer_org_id, userIdOf(request), 'developer_app_reinstated', { appId });
    await adminAudit(env, 'developer_app_reinstated', appId, {});
    await notifyOrg(env, app.developer_org_id, 'App reinstated', `${app.name} is listed again.`);
    return { app: { id: appId, status: 'active' } };
  },

  /** GET /admin/developers/releases?status= — the release review queue. */
  async listReleases(request: Request, env: any) {
    const status = new URL(request.url).searchParams.get('status') || '';
    const rows: any = await env.DB.prepare(
      `SELECT r.*, a.name AS app_name, a.slug AS app_slug, p.publisher_name,
              (SELECT COUNT(*) FROM packages pk WHERE pk.release_id = r.id) AS package_count
       FROM releases r
       JOIN applications a ON a.id = r.application_id
       LEFT JOIN developer_profiles p ON p.developer_id = r.developer_id
       WHERE r.developer_id IS NOT NULL ${status ? 'AND r.status=?' : ''}
       ORDER BY r.updated_at DESC LIMIT 200`
    ).bind(...(status ? [status] : [])).all().catch(() => ({ results: [] }));
    return {
      releases: (rows?.results || []).map((r: any) => ({
        ...releaseView(r, r), publisherName: r.publisher_name, packageCount: Number(r.package_count) || 0,
      })),
    };
  },

  /** GET /admin/developers/releases/:id — full review detail. */
  async getRelease(request: Request, env: any) {
    const releaseId = adminPathId(request, 4);
    const rel: any = await env.DB.prepare(
      `SELECT r.*, a.name AS app_name, a.slug AS app_slug, a.id AS app_id, a.platforms AS app_platforms, p.publisher_name
       FROM releases r JOIN applications a ON a.id = r.application_id
       LEFT JOIN developer_profiles p ON p.developer_id = r.developer_id
       WHERE r.id=? AND r.developer_id IS NOT NULL`
    ).bind(releaseId).first().catch(() => null);
    if (!rel) return { error: 'Developer release not found', code: 'NOT_FOUND' };
    const pkgs: any = await env.DB.prepare(
      `SELECT id, platform, architecture, filename, file_size, mime_type, sha256, status, security_scan_status, signature_status, scan_at, verified_at, deployment_url, created_at
       FROM packages WHERE release_id=? ORDER BY created_at ASC`
    ).bind(releaseId).all().catch(() => ({ results: [] }));
    const prev: any = await env.DB.prepare(
      `SELECT version, published_at FROM releases WHERE application_id=? AND status='published' ORDER BY published_at DESC LIMIT 1`
    ).bind(rel.application_id).first().catch(() => null);
    return {
      release: { ...releaseView(rel, rel), publisherName: rel.publisher_name, previousVersion: prev?.version || null },
      packages: pkgs?.results || [],
      app: { id: rel.app_id, name: rel.app_name, slug: rel.app_slug, platforms: rel.app_platforms },
    };
  },

  /** POST /admin/developers/releases/:id/review — submitted -> under_review. */
  async startReleaseReview(request: Request, env: any) {
    const releaseId = adminPathId(request, 4);
    const rel: any = await env.DB.prepare('SELECT * FROM releases WHERE id=? AND developer_id IS NOT NULL').bind(releaseId).first().catch(() => null);
    if (!rel) return { error: 'Release not found', code: 'NOT_FOUND' };
    if (rel.status !== 'submitted') return { error: `Only submitted releases can enter review (current: ${rel.status})`, code: 'FORBIDDEN' };
    await env.DB.prepare(`UPDATE releases SET status='under_review', updated_at=datetime('now') WHERE id=?`).bind(releaseId).run();
    await syncSubmissionOnReleaseAction(env, { releaseId, releaseStatus: 'under_review', adminId: userIdOf(request) }).catch(() => {});
    await auditDev(env, rel.developer_id, userIdOf(request), 'developer_release_review_started', { releaseId });
    await adminAudit(env, 'developer_release_review_started', releaseId, {});
    await notifyOrg(env, rel.developer_id, 'Release under review', `Release ${rel.version} is now under review.`);
    return { release: { id: releaseId, status: 'under_review' } };
  },

  /** POST /admin/developers/releases/:id/approve — approved (publication is a separate step). */
  async approveRelease(request: Request, env: any) {
    const releaseId = adminPathId(request, 4);
    const rel: any = await env.DB.prepare('SELECT * FROM releases WHERE id=? AND developer_id IS NOT NULL').bind(releaseId).first().catch(() => null);
    if (!rel) return { error: 'Release not found', code: 'NOT_FOUND' };
    if (!['submitted', 'under_review', 'changes_requested'].includes(rel.status)) {
      return { error: `Only submitted/under-review releases can be approved (current: ${rel.status})`, code: 'FORBIDDEN' };
    }
    await env.DB.prepare(
      `UPDATE releases SET status='approved', reviewed_at=datetime('now'), reviewer_id=?, review_reason=NULL, updated_at=datetime('now') WHERE id=?`
    ).bind(userIdOf(request), releaseId).run();
    await syncSubmissionOnReleaseAction(env, { releaseId, releaseStatus: 'approved', adminId: userIdOf(request) }).catch(() => {});
    await auditDev(env, rel.developer_id, userIdOf(request), 'developer_release_approved', { releaseId, version: rel.version });
    await adminAudit(env, 'developer_release_approved', releaseId, { version: rel.version });
    const app: any = await env.DB.prepare('SELECT id, name FROM applications WHERE id=?').bind(rel.application_id).first().catch(() => null);
    const threadId = await releaseThread(env, rel.developer_id, app || {}, rel);
    await postToThread(env, threadId, String(userIdOf(request) || ''), 'ADMIN', `Release ${rel.version} approved. It becomes public when published (Admin → Releases → Publish).`);
    await notifyOrg(env, rel.developer_id, 'Release approved 🎉', `Release ${rel.version} of ${app?.name || 'your app'} was approved.`, { releaseId });
    return { release: { id: releaseId, status: 'approved' } };
  },

  /** POST /admin/developers/releases/:id/reject — reason REQUIRED, record preserved. */
  async rejectRelease(request: Request, env: any) {
    const releaseId = adminPathId(request, 4);
    const reason = str((await bodyOf(request)).reason, 1000);
    if (reason.length < 10) return { error: 'A rejection reason of at least 10 characters is required', code: 'VALIDATION_ERROR' };
    const rel: any = await env.DB.prepare('SELECT * FROM releases WHERE id=? AND developer_id IS NOT NULL').bind(releaseId).first().catch(() => null);
    if (!rel) return { error: 'Release not found', code: 'NOT_FOUND' };
    if (['published', 'approved'].includes(rel.status)) return { error: `This release is ${rel.status} — contact the developer or roll it back instead`, code: 'FORBIDDEN' };
    await env.DB.prepare(
      `UPDATE releases SET status='rejected', reviewed_at=datetime('now'), reviewer_id=?, review_reason=?, updated_at=datetime('now') WHERE id=?`
    ).bind(userIdOf(request), reason, releaseId).run();
    await syncSubmissionOnReleaseAction(env, { releaseId, releaseStatus: 'rejected', adminId: userIdOf(request), reason }).catch(() => {});
    await auditDev(env, rel.developer_id, userIdOf(request), 'developer_release_rejected', { releaseId, reason });
    await adminAudit(env, 'developer_release_rejected', releaseId, { reason });
    const app: any = await env.DB.prepare('SELECT id, name FROM applications WHERE id=?').bind(rel.application_id).first().catch(() => null);
    const threadId = await releaseThread(env, rel.developer_id, app || {}, rel);
    await postToThread(env, threadId, String(userIdOf(request) || ''), 'ADMIN', `Release ${rel.version} was not approved. Reason: ${reason}`);
    await notifyOrg(env, rel.developer_id, 'Release not approved', `Release ${rel.version}: ${reason}`);
    return { release: { id: releaseId, status: 'rejected' } };
  },

  /** POST /admin/developers/releases/:id/request-changes — reason REQUIRED; unlocks the developer's draft. */
  async requestReleaseChanges(request: Request, env: any) {
    const releaseId = adminPathId(request, 4);
    const reason = str((await bodyOf(request)).reason, 1000);
    if (reason.length < 10) return { error: 'A change request reason of at least 10 characters is required', code: 'VALIDATION_ERROR' };
    const rel: any = await env.DB.prepare('SELECT * FROM releases WHERE id=? AND developer_id IS NOT NULL').bind(releaseId).first().catch(() => null);
    if (!rel) return { error: 'Release not found', code: 'NOT_FOUND' };
    if (!['submitted', 'under_review'].includes(rel.status)) {
      return { error: `Changes can only be requested on submitted/under-review releases (current: ${rel.status})`, code: 'FORBIDDEN' };
    }
    await env.DB.prepare(
      `UPDATE releases SET status='changes_requested', reviewed_at=datetime('now'), reviewer_id=?, review_reason=?, updated_at=datetime('now') WHERE id=?`
    ).bind(userIdOf(request), reason, releaseId).run();
    await syncSubmissionOnReleaseAction(env, { releaseId, releaseStatus: 'changes_requested', adminId: userIdOf(request), reason }).catch(() => {});
    await auditDev(env, rel.developer_id, userIdOf(request), 'developer_release_changes_requested', { releaseId, reason });
    await adminAudit(env, 'developer_release_changes_requested', releaseId, { reason });
    const app: any = await env.DB.prepare('SELECT id, name FROM applications WHERE id=?').bind(rel.application_id).first().catch(() => null);
    const threadId = await releaseThread(env, rel.developer_id, app || {}, rel);
    await postToThread(env, threadId, String(userIdOf(request) || ''), 'ADMIN', `Changes requested for release ${rel.version}: ${reason}`);
    await notifyOrg(env, rel.developer_id, 'Changes requested on your release', `Release ${rel.version}: ${reason}`);
    return { release: { id: releaseId, status: 'changes_requested' } };
  },
};
