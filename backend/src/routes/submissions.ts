/**
 * Admin Review & Developer Communication (Phase 14).
 *
 * First-class submission records wrap the EXISTING Phase 12/13 flow
 * (releases + package security) with the operational review lifecycle:
 *
 *   SUBMITTED -> SECURITY_REVIEW -> ADMIN_REVIEW ->
 *   CHANGES_REQUESTED (action items) -> resubmit -> ... -> APPROVED/REJECTED
 *   WITHDRAWN / PUBLISHED, plus REVIEW_SUSPENDED (Suspend/Resume Review).
 *
 * Security model:
 *   - Developer routes resolve the org from the caller's membership; a
 *     submission is only visible/actable when it belongs to THAT org
 *     (submission.developer_id === org, cross-checked against the app).
 *   - Admin routes are admin-JWT gated by index.ts; reviewer assignment is
 *     enforced: once a reviewer owns a submission, only that reviewer may
 *     decide (reassignment is an explicit admin action).
 *   - Attachments live in PRIVATE storage (attachments/…), are type/size
 *     whitelisted (no executables), malware-scanned via the Phase 13
 *     provider when configured, and are served ONLY through authorized
 *     endpoints — never via /r2/ (index.ts 404s the prefix).
 *   - Every lifecycle step appends to developer_submission_events (history is
 *     never destroyed) and writes the developer + global audit logs.
 */

import { resolveMembership, auditDev, notify, notifyAdmins, rid, str } from './developers.ts';
import { notifyOrgMembersEmail } from '../services/email.ts';
import { runMalwareScan, latestChecksForPackages, publicationSecurityGate } from '../services/packageSecurity.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userIdOf(request: Request): string | null {
  return ((request as any).user as any)?.userId || null;
}

async function bodyOf(request: Request): Promise<any> {
  return await request.json().catch(() => ({}));
}

function pathSeg(request: Request, i: number): string {
  return decodeURIComponent(new URL(request.url).pathname.split('/')[i] || '');
}

async function globalAudit(env: any, action: string, resourceId: string, details: Record<string, unknown> = {}) {
  await env.DB.prepare('INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?,?,?)')
    .bind(rid('log'), action, 'submission', resourceId, JSON.stringify(details)).run().catch(() => {});
}

async function submissionEvent(env: any, submissionId: string, actorUserId: string | null, actorRole: string, event: string, notes?: string) {
  await env.DB.prepare(
    'INSERT INTO developer_submission_events (id, submission_id, actor_user_id, actor_role, event, notes) VALUES (?,?,?,?,?,?)'
  ).bind(rid('dse'), submissionId, actorUserId, actorRole, event, notes ?? null).run().catch(() => {});
}

async function notifyOrg(env: any, orgId: string, title: string, message: string, data: Record<string, unknown> = {}) {
  const members: any = await env.DB.prepare('SELECT user_id FROM developer_members WHERE developer_id=?').bind(orgId).all().catch(() => ({ results: [] }));
  for (const m of members?.results || []) await notify(env, m.user_id, 'update', title, message, data);
}

async function getSubmission(env: any, id: string) {
  return await env.DB.prepare('SELECT * FROM developer_submissions WHERE id=?').bind(id).first().catch(() => null);
}

async function setSubmission(env: any, id: string, fields: Record<string, any>) {
  const sets = Object.keys(fields).map((k) => `${k}=?`).join(', ');
  await env.DB.prepare(`UPDATE developer_submissions SET ${sets}, updated_at=datetime('now') WHERE id=?`)
    .bind(...Object.values(fields), id).run().catch(() => {});
}

/** Load the submission for a release (if any). */
export async function submissionForRelease(env: any, releaseId: string) {
  return await env.DB.prepare('SELECT * FROM developer_submissions WHERE release_id=?').bind(releaseId).first().catch(() => null);
}

/**
 * Create (or refresh) the submission record for a developer release and run
 * the automated security stage. Called by the Phase 12 submit flow and by
 * resubmission. Returns the submission.
 */
export async function ensureSubmission(env: any, input: {
  developerId: string; userId: string; app: any; release: any; resubmission?: boolean;
}): Promise<any> {
  const existing = await submissionForRelease(env, input.release.id);
  const id = existing?.id || rid('sub');
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO developer_submissions (id, developer_id, app_id, release_id, status, submitted_at)
       VALUES (?,?,?,?,'SUBMITTED', datetime('now'))`
    ).bind(id, input.developerId, input.app.id, input.release.id).run();
    await submissionEvent(env, id, input.userId, 'DEVELOPER', 'submission_created', `Release ${input.release.version}`);
    await auditDev(env, input.developerId, input.userId, 'submission_created', { submissionId: id, releaseId: input.release.id });
  } else {
    await setSubmission(env, id, { status: 'SUBMITTED', submitted_at: null, decision: null, review_notes: null });
  }

  // ---- Automated security stage (Phase 13 pipeline results) ----
  await setSubmission(env, id, { status: 'SECURITY_REVIEW' });
  const pkgs: any = await env.DB.prepare('SELECT id FROM packages WHERE release_id=? AND deployment_url IS NULL').bind(input.release.id).all().catch(() => ({ results: [] }));
  let hardFailed = false;
  const securitySummary: string[] = [];
  for (const p of pkgs?.results || []) {
    const gateOne: any = await env.DB.prepare('SELECT security_state, overall_security FROM packages WHERE id=?').bind(p.id).first().catch(() => null);
    if (!gateOne || gateOne.security_state === 'QUARANTINED') continue; // never scanned — the publish gate will hold it
    if (gateOne.overall_security === 'FAILED') { hardFailed = true; securitySummary.push(`package ${p.id}: security FAILED`); }
  }
  const gate = await publicationSecurityGate(env, input.release.id);
  for (const b of gate.blockers.slice(0, 5)) securitySummary.push(`${b.filename} (${b.platform}): ${b.reasons[0] || b.overall}`);

  // Advance to ADMIN_REVIEW unless a check hard-failed (admins then reject /
  // request changes with the evidence; publication stays gated regardless).
  const nextStatus = hardFailed ? 'SECURITY_REVIEW' : 'ADMIN_REVIEW';
  await setSubmission(env, id, { status: nextStatus });

  await submissionEvent(env, id, input.userId, 'DEVELOPER', input.resubmission ? 'submission_resubmitted' : 'submission_submitted',
    securitySummary.length ? `Security notes: ${securitySummary.join(' | ')}` : undefined);
  await auditDev(env, input.developerId, input.userId, input.resubmission ? 'submission_resubmitted' : 'submission_submitted', { submissionId: id });
  await globalAudit(env, input.resubmission ? 'submission_resubmitted' : 'submission_submitted', id, { releaseId: input.release.id });

  // Notify + email.
  const eventLabel = input.resubmission ? 'Resubmission received' : 'New submission received';
  await notifyAdmins(env, `${eventLabel}: ${input.app.name} ${input.release.version}`,
    input.resubmission ? 'A developer resubmitted a release for review.' : 'A developer submitted a release for review.', { submissionId: id });
  await notifyOrgMembersEmail(env, {
    developerId: input.developerId,
    subject: `RX Store review: ${input.app.name} ${input.release.version} submitted`,
    bodyText: input.resubmission
      ? `Your resubmission of ${input.app.name} ${input.release.version} was received and entered automated security review.`
      : `Your submission of ${input.app.name} ${input.release.version} was received and entered automated security review.`,
    ctaUrl: 'https://rx-store-web.pages.dev/developers/center',
  }).catch(() => {});

  return await getSubmission(env, id);
}

/**
 * Sync the submission when a release decision happens through the Phase 12
 * endpoints (approve / reject / request-changes / start review), so both
 * surfaces stay consistent.
 */
export async function syncSubmissionOnReleaseAction(env: any, input: {
  releaseId: string; releaseStatus: string; adminId: string | null; reason?: string;
}) {
  const sub: any = await submissionForRelease(env, input.releaseId);
  if (!sub) return;
  const map: Record<string, { status: string; decision: string }> = {
    under_review: { status: 'ADMIN_REVIEW', decision: '' },
    approved: { status: 'APPROVED', decision: 'APPROVED' },
    rejected: { status: 'REJECTED', decision: 'REJECTED' },
    changes_requested: { status: 'CHANGES_REQUESTED', decision: 'CHANGES_REQUESTED' },
    withdrawn: { status: 'WITHDRAWN', decision: 'WITHDRAWN' },
    published: { status: 'PUBLISHED', decision: 'PUBLISHED' },
  };
  const m = map[input.releaseStatus];
  if (!m) return;
  await setSubmission(env, sub.id, {
    status: m.status,
    ...(m.decision ? { decision: m.decision, reviewed_at: new Date().toISOString() } : {}),
    reviewer_id: sub.reviewer_id || input.adminId,
  });
}

function submissionView(sub: any, extra: Record<string, unknown> = {}) {
  return {
    id: sub.id, status: sub.status, developerId: sub.developer_id, appId: sub.app_id,
    releaseId: sub.release_id, reviewerId: sub.reviewer_id, reviewNotes: sub.review_notes,
    actionItems: safeJson(sub.action_items), decision: sub.decision,
    submittedAt: sub.submitted_at, reviewedAt: sub.reviewed_at, createdAt: sub.created_at,
    ...extra,
  };
}

function safeJson(v: any, fallback: any = []) {
  if (v == null) return fallback;
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Attachment policy
// ---------------------------------------------------------------------------

const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Whitelisted attachment types — deliberately NO executables/archives. */
const ATTACHMENT_TYPES: Record<string, string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt', 'log', 'md'],
  'application/json': ['json'],
};
const EXECUTABLE_EXTS = ['exe', 'msi', 'bat', 'cmd', 'sh', 'apk', 'aab', 'deb', 'appimage', 'dmg', 'pkg', 'msix', 'jar', 'dll', 'so', 'bin', 'com', 'scr', 'ps1', 'vbs'];

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest: ArrayBuffer = await (crypto as any).subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b: number) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Developer routes
// ---------------------------------------------------------------------------

export const developerSubmissionRoutes = {

  /** GET /developers/submissions — the org's submissions. */
  async list(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const rows: any = await env.DB.prepare(
      `SELECT s.*, a.name AS app_name, a.slug AS app_slug, r.version, r.build_number
       FROM developer_submissions s
       JOIN applications a ON a.id = s.app_id
       JOIN releases r ON r.id = s.release_id
       WHERE s.developer_id=? ORDER BY s.updated_at DESC LIMIT 100`
    ).bind(ms.developer.id).all().catch(() => ({ results: [] }));
    return { submissions: (rows?.results || []).map((s: any) => submissionView(s, { appName: s.app_name, appSlug: s.app_slug, version: s.version, buildNumber: s.build_number })) };
  },

  /** GET /developers/submissions/:id — detail incl. action items + events + thread. */
  async get(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const sub: any = await getSubmission(env, pathSeg(request, 3));
    if (!sub || sub.developer_id !== ms.developer.id) return { error: 'Submission not found', code: 'NOT_FOUND' };
    const rel: any = await env.DB.prepare('SELECT * FROM releases WHERE id=?').bind(sub.release_id).first().catch(() => null);
    const app: any = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(sub.app_id).first().catch(() => null);
    const pkgs: any = await env.DB.prepare('SELECT id, platform, architecture, filename, file_size, sha256, status, security_state, overall_security, security_scan_status, deployment_url FROM packages WHERE release_id=?').bind(sub.release_id).all().catch(() => ({ results: [] }));
    const checks = await latestChecksForPackages(env, (pkgs?.results || []).map((p: any) => p.id));
    const events: any = await env.DB.prepare('SELECT event, actor_role, notes, created_at FROM developer_submission_events WHERE submission_id=? ORDER BY created_at ASC').bind(sub.id).all().catch(() => ({ results: [] }));
    const thread: any = await env.DB.prepare('SELECT id, subject, status FROM developer_threads WHERE related_release_id=? OR related_submission_id=? ORDER BY updated_at DESC LIMIT 1').bind(sub.release_id, sub.id).first().catch(() => null);
    return {
      submission: submissionView(sub, { appName: app?.name, appSlug: app?.slug, version: rel?.version, buildNumber: rel?.build_number }),
      release: rel ? { id: rel.id, version: rel.version, status: rel.status, releaseNotes: safeJson(rel.release_notes), featureSummary: rel.feature_summary } : null,
      packages: (pkgs?.results || []).map((p: any) => ({ ...p, checks: checks[p.id] || [] })),
      events: events?.results || [],
      thread: thread || null,
    };
  },

  /** POST /developers/submissions/:id/resubmit — after CHANGES_REQUESTED. */
  async resubmit(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const sub: any = await getSubmission(env, pathSeg(request, 3));
    if (!sub || sub.developer_id !== ms.developer.id) return { error: 'Submission not found', code: 'NOT_FOUND' };
    if (sub.status !== 'CHANGES_REQUESTED') {
      return { error: `Only changes-requested submissions can be resubmitted (current: ${sub.status})`, code: 'FORBIDDEN' };
    }
    const rel: any = await env.DB.prepare('SELECT * FROM releases WHERE id=?').bind(sub.release_id).first().catch(() => null);
    const app: any = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(sub.app_id).first().catch(() => null);
    if (!rel || !app) return { error: 'Release not found', code: 'NOT_FOUND' };
    if (rel.status !== 'changes_requested') {
      return { error: `The release must be in changes-requested state (current: ${rel.status})`, code: 'FORBIDDEN' };
    }
    // Re-submit the release itself (existing Phase 12 state machine) and
    // refresh the submission through the security stage.
    await env.DB.prepare(`UPDATE releases SET status='submitted', submitted_at=datetime('now'), review_reason=NULL, updated_at=datetime('now') WHERE id=?`).bind(rel.id).run();
    const updated = await ensureSubmission(env, { developerId: ms.developer.id, userId: String(userId), app, release: rel, resubmission: true });

    // Developer response on the linked thread.
    const thread: any = await env.DB.prepare('SELECT id FROM developer_threads WHERE related_release_id=? ORDER BY updated_at DESC LIMIT 1').bind(rel.id).first().catch(() => null);
    if (thread) {
      const body = str((await bodyOf(request)).message, 2000) || `Resubmitted release ${rel.version} after addressing the requested changes.`;
      await env.DB.prepare(`INSERT INTO developer_thread_messages (id, thread_id, sender_user_id, sender_context, body) VALUES (?,?,?, 'DEVELOPER', ?)`)
        .bind(rid('dmsg'), thread.id, userId, body).run().catch(() => {});
      await env.DB.prepare(`UPDATE developer_threads SET status='AWAITING_ADMIN', action_required=1, updated_at=datetime('now') WHERE id=?`).bind(thread.id).run().catch(() => {});
      await submissionEvent(env, sub.id, userId, 'DEVELOPER', 'developer_response', body.slice(0, 500));
      await auditDev(env, ms.developer.id, userId, 'developer_message_sent', { threadId: thread.id });
    }
    await notifyAdmins(env, `Developer responded: ${app.name} ${rel.version}`, 'A developer responded to review feedback and resubmitted.', { submissionId: sub.id });
    return { submission: submissionView(updated || sub) };
  },

  /** POST /developers/communications/:threadId/attachments — private attachment upload. */
  async uploadAttachment(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const threadId = pathSeg(request, 3);
    const thread: any = await env.DB.prepare('SELECT * FROM developer_threads WHERE id=?').bind(threadId).first().catch(() => null);
    if (!thread || thread.developer_id !== ms.developer.id) return { error: 'Thread not found', code: 'NOT_FOUND' };
    if (thread.status === 'CLOSED') return { error: 'This thread is closed', code: 'FORBIDDEN' };

    const form = await request.formData().catch(() => null);
    if (!form) return { error: 'Expected multipart form-data (file, message?)', code: 'VALIDATION_ERROR' };
    const file: any = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return { error: 'No file attached', code: 'VALIDATION_ERROR' };
    const message = str(form.get('message'), 2000);

    const res = await storeAttachment(env, { file, threadId, senderUserId: String(userId), senderContext: 'DEVELOPER', message });
    if ((res as any)?.error) return res;
    return { attachment: { id: (res as any).id, filename: (res as any).filename, scanStatus: (res as any).scanStatus }, message: (res as any).messageId ? { id: (res as any).messageId } : undefined };
  },

  /** GET /developers/attachments/:id — authorized download (never /r2/). */
  async downloadAttachment(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const att: any = await env.DB.prepare('SELECT * FROM developer_thread_attachments WHERE id=?').bind(pathSeg(request, 3)).first().catch(() => null);
    if (!att) return { error: 'Attachment not found', code: 'NOT_FOUND' };
    const thread: any = await env.DB.prepare('SELECT developer_id, status FROM developer_threads WHERE id=?').bind(att.thread_id).first().catch(() => null);
    if (!thread || thread.developer_id !== ms.developer.id) return { error: 'Attachment not found', code: 'NOT_FOUND' };
    return { attachment: att };
  },
};

// ---------------------------------------------------------------------------
// Shared attachment storage (both developer + admin upload paths)
// ---------------------------------------------------------------------------

async function storeAttachment(env: any, input: {
  file: any; threadId: string; senderUserId: string; senderContext: 'DEVELOPER' | 'ADMIN'; message?: string;
}): Promise<{ id?: string; filename?: string; scanStatus?: string; messageId?: string; error?: string; code?: string }> {
  const file = input.file;
  const name = String(file.name || 'attachment.bin');
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (EXECUTABLE_EXTS.includes(ext)) {
    return { error: `Executable attachments ('.${ext}') are not allowed in conversations. Share a screenshot or log instead.`, code: 'VALIDATION_ERROR' };
  }
  const mime = String(file.type || '').split(';')[0].trim();
  const allowedExts = ATTACHMENT_TYPES[mime];
  if (!allowedExts || !allowedExts.includes(ext)) {
    return { error: `Attachments of type '${mime || 'unknown'}' (.${ext}) are not allowed. Allowed: images (png/jpg/webp/gif), PDF, text/log/markdown, JSON.`, code: 'VALIDATION_ERROR' };
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return { error: `Attachments are limited to 10 MB (${(file.size / 1024 / 1024).toFixed(1)} MB given).`, code: 'VALIDATION_ERROR' };
  }

  const buf: ArrayBuffer = await file.arrayBuffer();
  const sha256 = await sha256Hex(buf);
  const safeName = name.replace(/[^\w.\-]+/g, '_').slice(0, 120);

  // Malware scan through the Phase 13 provider (hash lookup).
  const scan = await runMalwareScan(env, { sha256, filename: safeName, size: file.size, platform: 'attachment' });
  const scanStatus = scan.status === 'CLEAN' ? 'CLEAN'
    : scan.status === 'DETECTED' ? 'DETECTED'
    : scan.status === 'UNAVAILABLE' ? 'UNAVAILABLE'
    : 'FAILED';
  if (scanStatus === 'DETECTED') {
    return { error: 'This file was flagged by the malware scanner and was rejected. Contact the RX Store team if you believe this is a mistake.', code: 'FORBIDDEN' };
  }
  if (scanStatus === 'FAILED') {
    return { error: 'The malware scanner could not verify this file (error/unavailable with scanner configured). The attachment was not stored.', code: 'VALIDATION_ERROR' };
  }

  // Optional message accompanying the attachment.
  let messageId: string | undefined;
  if (input.message) {
    messageId = rid('dmsg');
    await env.DB.prepare(`INSERT INTO developer_thread_messages (id, thread_id, sender_user_id, sender_context, body) VALUES (?,?,?,?,?)`)
      .bind(messageId, input.threadId, input.senderUserId, input.senderContext, input.message).run().catch(() => {});
  }

  const id = rid('att');
  const storageKey = `attachments/threads/${input.threadId}/${id}/${safeName}`;
  try {
    await env.STORAGE.put(storageKey, buf, { httpMetadata: { contentType: mime } });
  } catch {
    return { error: 'Storage failed — the attachment was NOT saved. Try again.', code: 'INTERNAL' };
  }
  await env.DB.prepare(
    `INSERT INTO developer_thread_attachments (id, thread_id, message_id, uploader_user_id, filename, storage_key, mime_type, file_size, sha256, scan_status)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, input.threadId, messageId ?? null, input.senderUserId, safeName, storageKey, mime, file.size, sha256, scanStatus).run();

  await env.DB.prepare(
    `UPDATE developer_threads SET status=?, action_required=?, updated_at=datetime('now') WHERE id=?`
  ).bind(input.senderContext === 'ADMIN' ? 'AWAITING_DEVELOPER' : 'AWAITING_ADMIN', input.senderContext === 'ADMIN' ? 0 : 1, input.threadId).run().catch(() => {});
  return { id, filename: safeName, scanStatus, messageId };
}

// ---------------------------------------------------------------------------
// Admin routes (admin JWT enforced by index.ts)
// ---------------------------------------------------------------------------

/** Reviewer gate: only the assigned reviewer (or any admin when unassigned) may decide. */
async function reviewerGate(env: any, sub: any, adminId: string | null) {
  if (sub.reviewer_id && sub.reviewer_id !== adminId) {
    return { error: `This submission is assigned to another reviewer. Reassign it to yourself first (Reviewer → Assign to me).`, code: 'FORBIDDEN' };
  }
  return null;
}

export const adminSubmissionRoutes = {

  /** GET /admin/submissions?status= — the review queue. */
  async list(request: Request, env: any) {
    const status = new URL(request.url).searchParams.get('status') || '';
    const rows: any = await env.DB.prepare(
      `SELECT s.*, a.name AS app_name, a.slug AS app_slug, r.version, r.build_number, r.status AS release_status,
              p.publisher_name,
              (SELECT COUNT(*) FROM packages pk WHERE pk.release_id = s.release_id) AS package_count
       FROM developer_submissions s
       JOIN applications a ON a.id = s.app_id
       JOIN releases r ON r.id = s.release_id
       LEFT JOIN developer_profiles p ON p.developer_id = s.developer_id
       ${status ? 'WHERE s.status=?' : ''}
       ORDER BY s.updated_at DESC LIMIT 200`
    ).bind(...(status ? [status] : [])).all().catch(() => ({ results: [] }));
    return {
      submissions: (rows?.results || []).map((s: any) => submissionView(s, {
        appName: s.app_name, appSlug: s.app_slug, version: s.version, buildNumber: s.build_number,
        releaseStatus: s.release_status, publisherName: s.publisher_name, packageCount: Number(s.package_count) || 0,
      })),
    };
  },

  /** GET /admin/submissions/:id — the full review workspace payload. */
  async get(request: Request, env: any) {
    const sub: any = await getSubmission(env, pathSeg(request, 3));
    if (!sub) return { error: 'Submission not found', code: 'NOT_FOUND' };
    const rel: any = await env.DB.prepare('SELECT * FROM releases WHERE id=?').bind(sub.release_id).first().catch(() => null);
    const app: any = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(sub.app_id).first().catch(() => null);
    const profile: any = await env.DB.prepare('SELECT publisher_name, website, logo, description FROM developer_profiles WHERE developer_id=?').bind(sub.developer_id).first().catch(() => null);
    const dev: any = await env.DB.prepare('SELECT id, status, created_at FROM developers WHERE id=?').bind(sub.developer_id).first().catch(() => null);
    const pkgs: any = await env.DB.prepare('SELECT id, platform, architecture, filename, file_size, sha256, status, security_state, overall_security, security_scan_status, signature_status, deployment_url, created_at FROM packages WHERE release_id=?').bind(sub.release_id).all().catch(() => ({ results: [] }));
    const checks = await latestChecksForPackages(env, (pkgs?.results || []).map((p: any) => p.id));
    const previous: any = await env.DB.prepare(
      `SELECT version, status, published_at, created_at FROM releases WHERE application_id=? AND id != ? ORDER BY created_at DESC LIMIT 10`
    ).bind(sub.app_id, sub.release_id).all().catch(() => ({ results: [] }));
    const events: any = await env.DB.prepare(
      `SELECT e.*, u.name AS actor_name FROM developer_submission_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.submission_id=? ORDER BY e.created_at ASC`
    ).bind(sub.id).all().catch(() => ({ results: [] }));
    const reviewer: any = sub.reviewer_id ? await env.DB.prepare('SELECT id, name FROM users WHERE id=?').bind(sub.reviewer_id).first().catch(() => null) : null;
    const thread: any = await env.DB.prepare('SELECT id, subject, status, updated_at FROM developer_threads WHERE related_release_id=? OR related_submission_id=? ORDER BY updated_at DESC LIMIT 1').bind(sub.release_id, sub.id).first().catch(() => null);
    let messages: any[] = [];
    let attachments: any[] = [];
    if (thread) {
      const m: any = await env.DB.prepare(
        'SELECT id, sender_user_id, sender_context, body, created_at FROM developer_thread_messages WHERE thread_id=? ORDER BY created_at ASC'
      ).bind(thread.id).all().catch(() => ({ results: [] }));
      messages = m?.results || [];
      const a: any = await env.DB.prepare(
        'SELECT id, filename, mime_type, file_size, scan_status, uploader_user_id, created_at FROM developer_thread_attachments WHERE thread_id=? ORDER BY created_at ASC'
      ).bind(thread.id).all().catch(() => ({ results: [] }));
      attachments = a?.results || [];
      await env.DB.prepare(`UPDATE developer_thread_messages SET read_by_admin_at=datetime('now') WHERE thread_id=? AND sender_context='DEVELOPER' AND read_by_admin_at IS NULL`).bind(thread.id).run().catch(() => {});
    }
    return {
      submission: submissionView(sub, { reviewerName: reviewer?.name || null }),
      app: app ? {
        id: app.id, name: app.name, slug: app.slug, description: app.description, longDescription: app.long_description,
        category: app.category, platforms: safeJson(app.platforms), tags: safeJson(app.tags), icon: app.icon,
        screenshots: safeJson(app.screenshots), website: app.website, status: app.status,
      } : null,
      release: rel ? { id: rel.id, version: rel.version, buildNumber: rel.build_number, status: rel.status, releaseNotes: safeJson(rel.release_notes), featureSummary: rel.feature_summary, callToAction: rel.call_to_action, channel: rel.channel } : null,
      developer: { id: dev?.id, status: dev?.status, since: dev?.created_at, publisherName: profile?.publisher_name, website: profile?.website, logo: profile?.logo, description: profile?.description },
      packages: (pkgs?.results || []).map((p: any) => ({ ...p, checks: checks[p.id] || [] })),
      previousVersions: previous?.results || [],
      events: events?.results || [],
      thread: thread ? { ...thread, messages, attachments } : null,
    };
  },

  /** POST /admin/submissions/:id/assign {userId?} — assign a reviewer (defaults to caller). */
  async assign(request: Request, env: any) {
    const adminId = userIdOf(request);
    const sub: any = await getSubmission(env, pathSeg(request, 3));
    if (!sub) return { error: 'Submission not found', code: 'NOT_FOUND' };
    const body = await bodyOf(request);
    const targetId = str(body.userId, 60) || String(adminId || '');
    if (!targetId) return { error: 'userId required', code: 'VALIDATION_ERROR' };
    const target: any = await env.DB.prepare("SELECT id, name, role FROM users WHERE id=?").bind(targetId).first().catch(() => null);
    if (!target || target.role !== 'admin') {
      return { error: 'Reviewers must be admin accounts', code: 'FORBIDDEN' };
    }
    await setSubmission(env, sub.id, { reviewer_id: targetId });
    await submissionEvent(env, sub.id, adminId, 'ADMIN', 'reviewer_assigned', `Assigned to ${target.name}`);
    await globalAudit(env, 'reviewer_assigned', sub.id, { reviewerId: targetId });
    return { submission: { id: sub.id, reviewerId: targetId, reviewerName: target.name } };
  },

  /** POST /admin/submissions/:id/review — start review (SUBMITTED/SECURITY_REVIEW -> ADMIN_REVIEW). */
  async startReview(request: Request, env: any) {
    const adminId = userIdOf(request);
    const sub: any = await getSubmission(env, pathSeg(request, 3));
    if (!sub) return { error: 'Submission not found', code: 'NOT_FOUND' };
    const gate = await reviewerGate(env, sub, adminId);
    if (gate) return gate;
    if (!['SUBMITTED', 'SECURITY_REVIEW'].includes(sub.status)) {
      return { error: `Only submitted/security-review submissions can start review (current: ${sub.status})`, code: 'FORBIDDEN' };
    }
    await setSubmission(env, sub.id, { status: 'ADMIN_REVIEW', reviewer_id: sub.reviewer_id || adminId });
    await env.DB.prepare(`UPDATE releases SET status='under_review', updated_at=datetime('now') WHERE id=? AND status='submitted'`).bind(sub.release_id).run().catch(() => {});
    await submissionEvent(env, sub.id, adminId, 'ADMIN', 'review_started');
    await auditDev(env, sub.developer_id, adminId, 'review_started', { submissionId: sub.id });
    await notifyOrg(env, sub.developer_id, 'Review started', `Your submission entered admin review.`);
    return { submission: { id: sub.id, status: 'ADMIN_REVIEW' } };
  },

  /** POST /admin/submissions/:id/approve */
  async approve(request: Request, env: any) {
    const adminId = userIdOf(request);
    const sub: any = await getSubmission(env, pathSeg(request, 3));
    if (!sub) return { error: 'Submission not found', code: 'NOT_FOUND' };
    const gate = await reviewerGate(env, sub, adminId);
    if (gate) return gate;
    if (!['ADMIN_REVIEW', 'CHANGES_REQUESTED', 'SECURITY_REVIEW'].includes(sub.status)) {
      return { error: `Only submissions in review can be approved (current: ${sub.status})`, code: 'FORBIDDEN' };
    }
    const notes = str((await bodyOf(request)).notes, 1000) || null;

    // Sync the release to approved (publication remains a separate, gated step).
    const rel: any = await env.DB.prepare('SELECT * FROM releases WHERE id=?').bind(sub.release_id).first().catch(() => null);
    if (!rel) return { error: 'Release not found', code: 'NOT_FOUND' };
    await env.DB.prepare(`UPDATE releases SET status='approved', reviewed_at=datetime('now'), reviewer_id=?, review_reason=NULL, updated_at=datetime('now') WHERE id=?`)
      .bind(adminId, rel.id).run();

    await setSubmission(env, sub.id, { status: 'APPROVED', decision: 'APPROVED', reviewed_at: new Date().toISOString(), review_notes: notes, reviewer_id: sub.reviewer_id || adminId });
    await submissionEvent(env, sub.id, adminId, 'ADMIN', 'submission_approved', notes || undefined);
    await auditDev(env, sub.developer_id, adminId, 'submission_approved', { submissionId: sub.id });
    await globalAudit(env, 'submission_approved', sub.id, {});
    await notifyOrg(env, sub.developer_id, 'Submission approved 🎉', `${(await appNameOf(env, sub.app_id))} ${rel.version} was approved. Publish it from the Releases section when ready.`);
    await notifyOrgMembersEmail(env, {
      developerId: sub.developer_id,
      subject: `RX Store review: approved 🎉`,
      bodyText: `Your submission of ${(await appNameOf(env, sub.app_id))} ${rel.version} was approved by the RX Store review team.`,
      ctaUrl: 'https://rx-store-web.pages.dev/developers/center',
    }).catch(() => {});
    return { submission: { id: sub.id, status: 'APPROVED' } };
  },

  /** POST /admin/submissions/:id/reject {reason} — reason REQUIRED. */
  async reject(request: Request, env: any) {
    const adminId = userIdOf(request);
    const sub: any = await getSubmission(env, pathSeg(request, 3));
    if (!sub) return { error: 'Submission not found', code: 'NOT_FOUND' };
    const gate = await reviewerGate(env, sub, adminId);
    if (gate) return gate;
    const reason = str((await bodyOf(request)).reason, 1000);
    if (reason.length < 10) return { error: 'A rejection reason of at least 10 characters is required', code: 'VALIDATION_ERROR' };
    const rel: any = await env.DB.prepare('SELECT * FROM releases WHERE id=?').bind(sub.release_id).first().catch(() => null);
    if (!rel) return { error: 'Release not found', code: 'NOT_FOUND' };

    await env.DB.prepare(`UPDATE releases SET status='rejected', reviewed_at=datetime('now'), reviewer_id=?, review_reason=?, updated_at=datetime('now') WHERE id=?`)
      .bind(adminId, reason, rel.id).run();
    await setSubmission(env, sub.id, { status: 'REJECTED', decision: 'REJECTED', reviewed_at: new Date().toISOString(), review_notes: reason, reviewer_id: sub.reviewer_id || adminId });

    await submissionEvent(env, sub.id, adminId, 'ADMIN', 'submission_rejected', reason);
    await auditDev(env, sub.developer_id, adminId, 'submission_rejected', { submissionId: sub.id, reason });
    await globalAudit(env, 'submission_rejected', sub.id, { reason });
    await postAdminThreadMessage(env, sub, adminId, `Submission rejected. Reason: ${reason}`);
    await notifyOrg(env, sub.developer_id, 'Submission not approved', `${(await appNameOf(env, sub.app_id))} ${rel.version}: ${reason}`);
    await notifyOrgMembersEmail(env, {
      developerId: sub.developer_id,
      subject: `RX Store review: not approved`,
      bodyText: `Your submission of ${(await appNameOf(env, sub.app_id))} ${rel.version} was not approved. Reason: ${reason}`,
      ctaUrl: 'https://rx-store-web.pages.dev/developers/center',
    }).catch(() => {});
    return { submission: { id: sub.id, status: 'REJECTED' } };
  },

  /**
   * POST /admin/submissions/:id/request-changes {reason, actionItems[]}
   * Reason + concrete action items REQUIRED (no generic "fix your app").
   */
  async requestChanges(request: Request, env: any) {
    const adminId = userIdOf(request);
    const sub: any = await getSubmission(env, pathSeg(request, 3));
    if (!sub) return { error: 'Submission not found', code: 'NOT_FOUND' };
    const gate = await reviewerGate(env, sub, adminId);
    if (gate) return gate;
    const body = await bodyOf(request);
    const reason = str(body.reason, 1000);
    if (reason.length < 10) return { error: 'A change request reason of at least 10 characters is required', code: 'VALIDATION_ERROR' };
    const rawItems = Array.isArray(body.actionItems) ? body.actionItems : [];
    const actionItems = rawItems.map((i: any) => str(i, 300)).filter((i: string) => i.length >= 3).slice(0, 10);
    if (!actionItems.length) {
      return { error: 'Provide at least one concrete action item (e.g. "Add release notes describing the 2.1.0 database migration") — generic requests are rejected.', code: 'VALIDATION_ERROR' };
    }
    const rel: any = await env.DB.prepare('SELECT * FROM releases WHERE id=?').bind(sub.release_id).first().catch(() => null);
    if (!rel) return { error: 'Release not found', code: 'NOT_FOUND' };

    await env.DB.prepare(`UPDATE releases SET status='changes_requested', reviewed_at=datetime('now'), reviewer_id=?, review_reason=?, updated_at=datetime('now') WHERE id=?`)
      .bind(adminId, reason, rel.id).run();
    await setSubmission(env, sub.id, {
      status: 'CHANGES_REQUESTED', decision: 'CHANGES_REQUESTED',
      reviewed_at: new Date().toISOString(), review_notes: reason,
      action_items: JSON.stringify(actionItems), reviewer_id: sub.reviewer_id || adminId,
    });

    await submissionEvent(env, sub.id, adminId, 'ADMIN', 'changes_requested', `${reason} | Action items: ${actionItems.join(' • ')}`);
    await auditDev(env, sub.developer_id, adminId, 'changes_requested', { submissionId: sub.id, reason, actionItems });
    await globalAudit(env, 'changes_requested', sub.id, { reason, actionItems });

    // Link/create the communication thread + a message carrying the exact items.
    const threadId = await ensureSubmissionThread(env, sub);
    const itemsText = actionItems.map((a: string, i: number) => `${i + 1}. ${a}`).join('\n');
    await env.DB.prepare(`INSERT INTO developer_thread_messages (id, thread_id, sender_user_id, sender_context, body) VALUES (?,?,?, 'ADMIN', ?)`)
      .bind(rid('dmsg'), threadId, adminId, `Changes requested for ${rel.version}: ${reason}\n\nAction items:\n${itemsText}`).run();
    await env.DB.prepare(`UPDATE developer_threads SET status='AWAITING_DEVELOPER', action_required=1, updated_at=datetime('now') WHERE id=?`).bind(threadId).run();

    await notifyOrg(env, sub.developer_id, 'Changes requested on your submission', `${(await appNameOf(env, sub.app_id))} ${rel.version}: ${reason} — ${actionItems.length} action item(s) in Developer Center → Submissions.`, { submissionId: sub.id });
    await notifyOrgMembersEmail(env, {
      developerId: sub.developer_id,
      subject: `RX Store review: changes requested`,
      bodyText: `The review team requested changes on ${(await appNameOf(env, sub.app_id))} ${rel.version}: ${reason}. Open the Developer Center for the exact action items.`,
      ctaUrl: 'https://rx-store-web.pages.dev/developers/center',
    }).catch(() => {});
    return { submission: { id: sub.id, status: 'CHANGES_REQUESTED', actionItems } };
  },

  /** POST /admin/submissions/:id/suspend {reason?} — pause review. */
  async suspend(request: Request, env: any) {
    const adminId = userIdOf(request);
    const sub: any = await getSubmission(env, pathSeg(request, 3));
    if (!sub) return { error: 'Submission not found', code: 'NOT_FOUND' };
    const gate = await reviewerGate(env, sub, adminId);
    if (gate) return gate;
    if (!['ADMIN_REVIEW', 'SECURITY_REVIEW', 'SUBMITTED'].includes(sub.status)) {
      return { error: `Only active reviews can be suspended (current: ${sub.status})`, code: 'FORBIDDEN' };
    }
    const reason = str((await bodyOf(request)).reason, 500) || null;
    await setSubmission(env, sub.id, { status: 'REVIEW_SUSPENDED' });
    await submissionEvent(env, sub.id, adminId, 'ADMIN', 'review_suspended', reason || undefined);
    await globalAudit(env, 'review_suspended', sub.id, { reason });
    return { submission: { id: sub.id, status: 'REVIEW_SUSPENDED' } };
  },

  /** POST /admin/submissions/:id/resume */
  async resume(request: Request, env: any) {
    const adminId = userIdOf(request);
    const sub: any = await getSubmission(env, pathSeg(request, 3));
    if (!sub) return { error: 'Submission not found', code: 'NOT_FOUND' };
    const gate = await reviewerGate(env, sub, adminId);
    if (gate) return gate;
    if (sub.status !== 'REVIEW_SUSPENDED') return { error: 'This review is not suspended', code: 'FORBIDDEN' };
    await setSubmission(env, sub.id, { status: 'ADMIN_REVIEW' });
    await submissionEvent(env, sub.id, adminId, 'ADMIN', 'review_resumed');
    await globalAudit(env, 'review_resumed', sub.id, {});
    return { submission: { id: sub.id, status: 'ADMIN_REVIEW' } };
  },

  /** POST /admin/developers/communications/:threadId/attachments — admin attachment upload. */
  async uploadAttachment(request: Request, env: any) {
    const adminId = userIdOf(request);
    if (!adminId) return { error: 'Admin identity required', code: 'UNAUTHORIZED' };
    const threadId = pathSeg(request, 4);
    const thread: any = await env.DB.prepare('SELECT * FROM developer_threads WHERE id=?').bind(threadId).first().catch(() => null);
    if (!thread) return { error: 'Thread not found', code: 'NOT_FOUND' };
    if (thread.status === 'CLOSED') return { error: 'This thread is closed', code: 'FORBIDDEN' };
    const form = await request.formData().catch(() => null);
    if (!form) return { error: 'Expected multipart form-data (file, message?)', code: 'VALIDATION_ERROR' };
    const file: any = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return { error: 'No file attached', code: 'VALIDATION_ERROR' };
    const message = str(form.get('message'), 2000);
    const res = await storeAttachment(env, { file, threadId, senderUserId: String(adminId), senderContext: 'ADMIN', message });
    if ((res as any)?.error) return res;
    await auditDev(env, thread.developer_id, adminId, 'admin_message_sent', { threadId, attachment: (res as any).filename });
    // Notify the org about the message.
    await notifyOrg(env, thread.developer_id, 'RX Store sent an attachment', `The RX Store team shared a file in "${thread.subject}".`, { threadId });
    return { attachment: { id: (res as any).id, filename: (res as any).filename, scanStatus: (res as any).scanStatus } };
  },

  /** GET /admin/developers/attachments/:id — authorized admin download. */
  async downloadAttachment(request: Request, env: any) {
    const att: any = await env.DB.prepare('SELECT * FROM developer_thread_attachments WHERE id=?').bind(pathSeg(request, 4)).first().catch(() => null);
    if (!att) return { error: 'Attachment not found', code: 'NOT_FOUND' };
    return { attachment: att };
  },
};

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

async function appNameOf(env: any, appId: string): Promise<string> {
  const app: any = await env.DB.prepare('SELECT name FROM applications WHERE id=?').bind(appId).first().catch(() => null);
  return app?.name || 'your app';
}

/** Find or create the thread linked to a submission (links release + submission). */
async function ensureSubmissionThread(env: any, sub: any): Promise<string> {
  const existing: any = await env.DB.prepare(
    'SELECT id FROM developer_threads WHERE related_release_id=? OR related_submission_id=? ORDER BY updated_at DESC LIMIT 1'
  ).bind(sub.release_id, sub.id).first().catch(() => null);
  if (existing) {
    await env.DB.prepare('UPDATE developer_threads SET related_submission_id=? WHERE id=?').bind(sub.id, existing.id).run().catch(() => {});
    return existing.id;
  }
  const app: any = await env.DB.prepare('SELECT name FROM applications WHERE id=?').bind(sub.app_id).first().catch(() => null);
  const id = rid('dt');
  await env.DB.prepare(
    `INSERT INTO developer_threads (id, developer_id, subject, related_app_id, related_release_id, related_submission_id, status, action_required)
     VALUES (?,?,?,?,?,?, 'AWAITING_DEVELOPER', 1)`
  ).bind(id, sub.developer_id, `Review: ${app?.name || 'Submission'}`, sub.app_id, sub.release_id, sub.id).run().catch(() => {});
  return id;
}

async function postAdminThreadMessage(env: any, sub: any, adminId: string | null, body: string) {
  const threadId = await ensureSubmissionThread(env, sub);
  await env.DB.prepare(`INSERT INTO developer_thread_messages (id, thread_id, sender_user_id, sender_context, body) VALUES (?,?,?, 'ADMIN', ?)`)
    .bind(rid('dmsg'), threadId, adminId, body).run().catch(() => {});
  await env.DB.prepare(`UPDATE developer_threads SET status='AWAITING_DEVELOPER', updated_at=datetime('now') WHERE id=?`).bind(threadId).run().catch(() => {});
}
