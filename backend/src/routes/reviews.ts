/**
 * Ratings & Reviews (Phase 17).
 *
 * Production review system over the EXISTING reviews table (comment = body;
 * UNIQUE(app_id, user_id) enforces one active review per user per app, so a
 * resubmission is an EDIT, never a duplicate row).
 *
 * Honesty rules:
 *   - Aggregates (average, count, distribution) are computed ONLY from
 *     visible reviews — hidden/removed are excluded everywhere.
 *   - verified_install is a FACTUAL marker (download ledger or device
 *     installation record exists for this user+app). The marketplace's
 *     existing rules do not gate reviews on purchase (apps are free), so it
 *     labels evidence — it never gates submission and is never fabricated.
 *   - Moderation never deletes rows: hidden/removed are statuses; every
 *     action writes audit_logs with the recorded reason.
 *   - Developer responses are attributable (responder id + org name) and
 *     rendered as clearly-labelled developer responses.
 */

import { verifyAccessToken } from '../services/auth.ts';
import { getSetting } from '../services/settings.ts';
import { resolveMembership, requirePermission, auditDev } from './developers.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

async function bodyOf(request: Request): Promise<any> {
  return await request.json().catch(() => ({}));
}

async function globalAudit(env: any, action: string, resourceId: string, details: Record<string, unknown> = {}) {
  await env.DB.prepare('INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?,?,?)')
    .bind(rid('log'), action, 'review', resourceId, JSON.stringify(details)).run().catch(() => {});
}

/** Recompute the canonical aggregate from VISIBLE reviews only. */
export async function recomputeAppRating(env: any, appId: string) {
  const agg: any = await env.DB.prepare(
    `SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM reviews WHERE app_id=? AND status='visible'`
  ).bind(appId).first().catch(() => null);
  await env.DB.prepare('UPDATE applications SET rating=?, review_count=? WHERE id=?')
    .bind(Math.round((Number(agg?.avg) || 0) * 100) / 100, Number(agg?.cnt) || 0, appId).run().catch(() => {});
}

/**
 * Pure spam/abuse heuristics for review text (unit-tested). Returns an error
 * string or null. Deliberately simple and explainable.
 */
export function reviewSpamCheck(input: { title?: string; body?: string }): string | null {
  const title = str(input.title, 120);
  const body = str(input.body, 4000);
  if (body.length < 4) return 'Please write a review of at least 4 characters.';
  if (body.length > 2000) return 'Reviews are limited to 2000 characters.';
  if (title.length > 120) return 'Titles are limited to 120 characters.';
  // Same character run (e.g. "aaaaaaaaaa") — classic spam filler.
  if (/(.)\1{9,}/.test(body)) return 'This review looks like filler text. Please describe your actual experience.';
  // SHOUTING: >70% caps in a substantial body.
  const letters = body.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 30) {
    const caps = body.replace(/[^A-Z]/g, '').length;
    if (caps / letters.length > 0.7) return 'Please write your review in normal letter case (not all caps).';
  }
  return null;
}

/** Factual evidence of acquisition/install/use: download ledger OR a device
 *  installation record for this user+app. Never fabricated, never required. */
async function hasInstallEvidence(env: any, appId: string, userId: string): Promise<boolean> {
  const dl: any = await env.DB.prepare(
    'SELECT 1 AS ok FROM downloads WHERE app_id=? AND user_id=? LIMIT 1'
  ).bind(appId, userId).first().catch(() => null);
  if (dl) return true;
  const inst: any = await env.DB.prepare(
    `SELECT 1 AS ok FROM app_installations WHERE application_id=? AND user_id=? AND status IN ('installed','update_available') LIMIT 1`
  ).bind(appId, userId).first().catch(() => null);
  return !!inst;
}

function reviewView(r: any) {
  return {
    id: r.id,
    rating: r.rating,
    title: r.title || null,
    body: r.comment,
    userName: r.user_name || 'User',
    date: (r.created_at || '').slice(0, 10),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    appVersion: r.app_version || null,
    platform: r.platform || null,
    verifiedInstall: !!r.verified_install,
    helpful: Number(r.helpful_count) || 0,
    status: r.status || 'visible',
    developerResponse: r.developer_response ? {
      body: r.developer_response,
      respondedAt: r.developer_responded_at,
      byOrgName: r.developer_org_name || null,
    } : null,
  };
}

// ---------------------------------------------------------------------------
// Public / user routes
// ---------------------------------------------------------------------------

export const reviewRoutes = {

  /**
   * GET /apps/:slug/reviews?page=&limit= — visible reviews (newest first)
   * with the TRUE summary (average/count/distribution over ALL visible
   * reviews, not just this page) and pagination metadata.
   */
  async list(request: Request, env: any) {
    const url = new URL(request.url);
    const slug = url.pathname.split('/').filter(Boolean)[1];
    const app: any = await env.DB.prepare('SELECT id FROM applications WHERE slug=?').bind(slug).first().catch(() => null);
    if (!app) return { error: 'Application not found', code: 'NOT_FOUND' };

    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1') || 1);
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '10') || 10));

    // Summary over ALL visible reviews (never manufactured, never page-scoped).
    const dist: any = await env.DB.prepare(
      `SELECT rating, COUNT(*) AS c FROM reviews WHERE app_id=? AND status='visible' GROUP BY rating`
    ).bind(app.id).all().catch(() => ({ results: [] }));
    const byRating: Record<number, number> = {};
    let total = 0;
    for (const row of dist?.results || []) { byRating[Number(row.rating)] = Number(row.c); total += Number(row.c); }
    const avg = total ? (Object.entries(byRating).reduce((s, [r, c]) => s + Number(r) * Number(c), 0) / total) : 0;
    const distribution = [5, 4, 3, 2, 1].map((stars) => ({
      stars, count: byRating[stars] || 0,
      percentage: total ? Math.round(((byRating[stars] || 0) / total) * 100) : 0,
    }));

    // Mark the caller's own review when a valid token is supplied (for
    // edit-in-place UX). Optional — the endpoint stays public.
    let viewerId: string | null = null;
    const auth = request.headers.get('Authorization') || '';
    if (auth.startsWith('Bearer ')) {
      try { viewerId = (await verifyAccessToken(auth.slice(7), env.JWT_SECRET))?.userId || null; } catch { viewerId = null; }
    }

    const rows: any = await env.DB.prepare(
      `SELECT r.*, u.name AS user_name, p.publisher_name AS developer_org_name
       FROM reviews r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN applications a ON a.id = r.app_id
       LEFT JOIN developer_profiles p ON p.developer_id = a.developer_org_id
       WHERE r.app_id=? AND r.status='visible'
       ORDER BY r.created_at DESC LIMIT ? OFFSET ?`
    ).bind(app.id, limit, (page - 1) * limit).all().catch(() => ({ results: [] }));

    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
      reviews: (rows?.results || []).map((r: any) => ({ ...reviewView(r), own: !!(viewerId && r.user_id === viewerId) })),
      summary: { average: Math.round(avg * 100) / 100, count: total, distribution },
      pagination: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrevious: page > 1 },
    };
  },

  /**
   * POST /apps/:slug/reviews — create or EDIT the caller's single review for
   * the app (UNIQUE(app_id, user_id); resubmission = edit by design).
   * Authenticated only; anti-abuse: spam heuristics, per-user write cooldown,
   * no-op edit rejection.
   */
  async submit(request: Request, env: any) {
    // Live admin toggle (Admin → Settings) — reviews can be paused entirely.
    if (await getSetting(env, 'reviews_open', '1') === '0') {
      return { error: 'Reviews are temporarily disabled by the administrator.', code: 'FORBIDDEN' };
    }

    const url = new URL(request.url);
    const slug = url.pathname.split('/').filter(Boolean)[1];
    const app: any = await env.DB.prepare('SELECT id, current_version FROM applications WHERE slug=?').bind(slug).first().catch(() => null);
    if (!app) return { error: 'Application not found', code: 'NOT_FOUND' };

    // ---- Authentication ----
    const auth = request.headers.get('Authorization') || '';
    if (!auth.startsWith('Bearer ')) return { error: 'Please sign in to review', code: 'UNAUTHORIZED' };
    let uid: string | null = null;
    try {
      uid = (await verifyAccessToken(auth.slice(7), env.JWT_SECRET))?.userId || null;
    } catch { uid = null; }
    if (!uid) return { error: 'Please sign in to review', code: 'UNAUTHORIZED' };

    const body = await bodyOf(request);
    const rating = Math.trunc(Number(body.rating));
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return { error: 'Rating must be 1-5 stars.', code: 'VALIDATION_ERROR' };
    }
    const title = str(body.title, 120);
    const text = str(body.comment ?? body.body, 4000);
    const platform = str(body.platform, 20).toLowerCase() || null;

    const spam = reviewSpamCheck({ title, body: text });
    if (spam) return { error: spam, code: 'VALIDATION_ERROR' };

    // ---- Cooldown: at most 5 review rows created/edited per hour per user
    //      (one row per app — this bounds review output across the catalog). ----
    const recent: any = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM reviews WHERE user_id=? AND updated_at >= datetime('now', '-1 hour')`
    ).bind(uid).first().catch(() => ({ c: 0 }));
    if (Number(recent?.c || 0) >= 5) {
      return { error: 'You have submitted several reviews recently. Please wait a while before reviewing again.', code: 'RATE_LIMITED' };
    }

    const verified = await hasInstallEvidence(env, app.id, uid);

    // ---- Create or EDIT (one active review per user per app) ----
    const existing: any = await env.DB.prepare(
      'SELECT id, rating, comment, title FROM reviews WHERE app_id=? AND user_id=?'
    ).bind(app.id, uid).first().catch(() => null);

    if (existing) {
      if (existing.rating === rating && str(existing.comment, 4000) === text && (existing.title || '') === title) {
        return { error: 'No changes — this is the same review you already submitted.', code: 'VALIDATION_ERROR' };
      }
      await env.DB.prepare(
        `UPDATE reviews SET rating=?, title=?, comment=?, app_version=?, platform=?, verified_install=?, updated_at=datetime('now') WHERE id=?`
      ).bind(rating, title || null, text, app.current_version || null, platform, verified ? 1 : 0, existing.id).run();
      await recomputeAppRating(env, app.id);
      const fresh: any = await env.DB.prepare('SELECT * FROM reviews WHERE id=?').bind(existing.id).first().catch(() => null);
      return { review: fresh ? reviewView({ ...fresh, user_name: undefined }) : null, edited: true };
    }

    const id = rid('rev');
    await env.DB.prepare(
      `INSERT INTO reviews (id, app_id, user_id, rating, title, comment, app_version, platform, verified_install, helpful_count)
       VALUES (?,?,?,?,?,?,?,?,?,0)`
    ).bind(id, app.id, uid, rating, title || null, text, app.current_version || null, platform, verified ? 1 : 0).run();
    await recomputeAppRating(env, app.id);
    const created: any = await env.DB.prepare('SELECT * FROM reviews WHERE id=?').bind(id).first().catch(() => null);
    await globalAudit(env, 'review_created', id, { appId: app.id, rating, verified });
    return { review: created ? reviewView(created) : null, edited: false };
  },

  /**
   * POST /reviews/:id/report {reason, details?} — report a review.
   * One report per (review, reporter); fixed reason vocabulary.
   */
  async report(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Sign in to report a review', code: 'UNAUTHORIZED' };
    const reviewId = decodeURIComponent(new URL(request.url).pathname.split('/')[2] || '');
    const body = await bodyOf(request);
    const REASONS = ['spam', 'harassment', 'irrelevant', 'fraudulent', 'malicious_content', 'other'];
    const reason = str(body.reason, 30).toLowerCase();
    if (!REASONS.includes(reason)) {
      return { error: `Reason must be one of: ${REASONS.join(', ')}.`, code: 'VALIDATION_ERROR' };
    }
    const details = str(body.details, 500) || null;

    const review: any = await env.DB.prepare('SELECT id, app_id FROM reviews WHERE id=?').bind(reviewId).first().catch(() => null);
    if (!review) return { error: 'Review not found', code: 'NOT_FOUND' };

    const dup: any = await env.DB.prepare(
      'SELECT id, status FROM review_reports WHERE review_id=? AND reporter_user_id=?'
    ).bind(reviewId, userId).first().catch(() => null);
    if (dup) {
      return { error: dup.status === 'open' ? 'You have already reported this review — it is awaiting moderation.' : 'You have already reported this review.', code: 'VALIDATION_ERROR' };
    }

    const id = rid('rep');
    await env.DB.prepare(
      'INSERT INTO review_reports (id, review_id, reporter_user_id, reason, details) VALUES (?,?,?,?,?)'
    ).bind(id, reviewId, userId, reason, details).run();
    await globalAudit(env, 'review_reported', reviewId, { reason, reporter: userId });
    return { report: { id, reason } };
  },
};

// ---------------------------------------------------------------------------
// Developer responses (approved developer support roles)
// ---------------------------------------------------------------------------

export const developerReviewRoutes = {

  /**
   * POST /developers/reviews/:id/respond {response} — a member of the app's
   * organization holding reviews.manage (OWNER/ADMIN/ANALYST/SUPPORT) may
   * respond. The response is stored on the review, clearly attributable.
   */
  async respond(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'reviews.manage');
    if ('error' in guard && (guard as any).error) return guard;
    const ms = (guard as any).ms;

    const reviewId = decodeURIComponent(new URL(request.url).pathname.split('/')[3] || '');
    const responseText = str((await bodyOf(request)).response, 2000);
    if (responseText.length < 3) return { error: 'Write a response of at least 3 characters.', code: 'VALIDATION_ERROR' };

    // The review's app must belong to the caller's organization.
    const review: any = await env.DB.prepare(
      `SELECT r.id, a.id AS app_id, a.developer_org_id FROM reviews r JOIN applications a ON a.id = r.app_id WHERE r.id=?`
    ).bind(reviewId).first().catch(() => null);
    if (!review) return { error: 'Review not found', code: 'NOT_FOUND' };
    if (review.developer_org_id !== ms.developer.id) {
      return { error: 'This review is not for one of your organization\u2019s applications.', code: 'FORBIDDEN' };
    }

    await env.DB.prepare(
      `UPDATE reviews SET developer_response=?, developer_responded_at=datetime('now'), developer_responder_id=? WHERE id=?`
    ).bind(responseText, userId, reviewId).run();
    await auditDev(env, ms.developer.id, userId, 'developer_review_response', { reviewId });
    return { success: true };
  },
};

// ---------------------------------------------------------------------------
// Admin moderation (admin JWT enforced by index.ts)
// ---------------------------------------------------------------------------

export const adminReviewRoutes = {

  /** GET /admin/reviews/reports?status=open — the moderation queue. */
  async listReports(request: Request, env: any) {
    const status = new URL(request.url).searchParams.get('status') || 'open';
    const rows: any = await env.DB.prepare(
      `SELECT rp.id AS report_id, rp.reason, rp.details, rp.status AS report_status, rp.created_at AS reported_at,
              rp.reporter_user_id, ru.name AS reporter_name,
              r.id AS review_id, r.rating, r.title, r.comment AS body, r.status AS review_status,
              r.app_version, r.created_at AS review_created_at,
              au.name AS author_name,
              a.name AS app_name, a.slug AS app_slug
       FROM review_reports rp
       JOIN reviews r ON r.id = rp.review_id
       LEFT JOIN users ru ON ru.id = rp.reporter_user_id
       LEFT JOIN users au ON au.id = r.user_id
       LEFT JOIN applications a ON a.id = r.app_id
       WHERE rp.status = ?
       ORDER BY rp.created_at DESC LIMIT 200`
    ).bind(status).all().catch(() => ({ results: [] }));
    return { reports: rows?.results || [] };
  },

  /** GET /admin/reviews?status=hidden|removed|visible — moderation history / review states. */
  async listReviews(request: Request, env: any) {
    const status = new URL(request.url).searchParams.get('status') || '';
    const rows: any = await env.DB.prepare(
      `SELECT r.*, u.name AS user_name, a.name AS app_name, a.slug AS app_slug
       FROM reviews r LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN applications a ON a.id = r.app_id
       ${status ? 'WHERE r.status = ?' : ''} ORDER BY r.updated_at DESC LIMIT 100`
    ).bind(...(status ? [status] : [])).all().catch(() => ({ results: [] }));
    return { reviews: rows?.results || [] };
  },

  /**
   * POST /admin/reviews/:id/moderate {action: hide|restore|remove, reason}
   * Reason REQUIRED. Never deletes the row; resolves the review's open
   * reports; recomputes the aggregate; writes the audit history.
   */
  async moderate(request: Request, env: any) {
    const adminId = ((request as any).user as any)?.userId || null;
    if (!adminId) return { error: 'Admin identity required', code: 'UNAUTHORIZED' };
    const reviewId = decodeURIComponent(new URL(request.url).pathname.split('/')[3] || '');
    const body = await bodyOf(request);
    const action = str(body.action, 10).toLowerCase();
    if (!['hide', 'restore', 'remove'].includes(action)) {
      return { error: 'action must be hide, restore or remove', code: 'VALIDATION_ERROR' };
    }
    const reason = str(body.reason, 1000);
    if (reason.length < 10) {
      return { error: 'A moderation reason of at least 10 characters is required — it is recorded in the audit history.', code: 'VALIDATION_ERROR' };
    }

    const review: any = await env.DB.prepare('SELECT id, app_id, status FROM reviews WHERE id=?').bind(reviewId).first().catch(() => null);
    if (!review) return { error: 'Review not found', code: 'NOT_FOUND' };

    const newStatus = action === 'hide' ? 'hidden' : action === 'remove' ? 'removed' : 'visible';
    if (review.status === newStatus) {
      return { error: `This review is already ${newStatus}.`, code: 'VALIDATION_ERROR' };
    }

    await env.DB.prepare(
      `UPDATE reviews SET status=?, moderation_reason=?, moderated_at=datetime('now'), moderated_by=? WHERE id=?`
    ).bind(newStatus, reason, adminId, reviewId).run();

    // Resolve this review's open reports (the moderation decision answers them).
    await env.DB.prepare(
      `UPDATE review_reports SET status='resolved', resolved_by=?, resolved_at=datetime('now') WHERE review_id=? AND status='open'`
    ).bind(adminId, reviewId).run().catch(() => {});

    await recomputeAppRating(env, review.app_id);
    await globalAudit(env, `review_${action === 'restore' ? 'restored' : action === 'hide' ? 'hidden' : 'removed'}`, reviewId, { reason, adminId, priorStatus: review.status });
    return { review: { id: reviewId, status: newStatus } };
  },
};
