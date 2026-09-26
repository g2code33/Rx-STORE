/**
 * Admin package-security routes (Phase 13 §12).
 *
 * All routes are admin-gated by index.ts (/admin/* requires an admin JWT
 * before any handler runs). The override is the ONLY way past a security
 * blocker and requires an explicit reason (server-enforced), records the
 * admin identity + timestamp, and writes both the global audit log and the
 * developer-scoped audit log.
 */

import { runSecurityPipeline, latestChecksForPackages, rid, manualReviewMalwareEligible, latestCheckStatus, validManualApproval } from '../services/packageSecurity.ts';

function pathSeg(request: Request, i: number): string {
  return decodeURIComponent(new URL(request.url).pathname.split('/')[i] || '');
}

function str(v: unknown, max = 1000): string {
  return String(v ?? '').trim().slice(0, max);
}

export const securityAdminRoutes = {

  /** GET /admin/security/packages?state=&overall= — the security dashboard. */
  async listPackages(request: Request, env: any) {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') || '';
    const overall = url.searchParams.get('overall') || '';
    const rows: any = await env.DB.prepare(
      `SELECT p.id, p.platform, p.architecture, p.filename, p.file_size, p.sha256, p.status AS package_status,
              p.security_state, p.overall_security, p.security_scan_status, p.signature_status,
              p.created_at AS uploaded_at, p.deployment_url,
              r.id AS release_id, r.version, r.status AS release_status,
              a.id AS app_id, a.name AS app_name, a.slug AS app_slug,
              d.id AS developer_id, pr.publisher_name,
              (SELECT COUNT(*) FROM package_security_overrides o WHERE o.package_id = p.id) AS override_count
       FROM packages p
       LEFT JOIN releases r ON r.id = p.release_id
       LEFT JOIN applications a ON a.id = p.application_id
       LEFT JOIN developers d ON d.id = r.developer_id
       LEFT JOIN developer_profiles pr ON pr.developer_id = d.id
       WHERE p.deployment_url IS NULL
       ORDER BY p.created_at DESC LIMIT 200`
    ).all().catch(() => ({ results: [] }));
    const all = rows?.results || [];
    const filtered = all.filter((p: any) =>
      (!state || p.security_state === state) && (!overall || p.overall_security === overall));
    return {
      packages: filtered.map((p: any) => ({
        ...p,
        overridden: Number(p.override_count) > 0,
        sizeBytes: Number(p.file_size) || 0,
      })),
    };
  },

  /** GET /admin/security/packages/:id — full detail: checks, history, overrides. */
  async getPackage(request: Request, env: any) {
    const id = pathSeg(request, 4);
    const pkg: any = await env.DB.prepare(
      `SELECT p.*, r.version, r.status AS release_status, a.name AS app_name, a.slug AS app_slug,
              a.android_package_id, a.linux_package_name, a.windows_executable, a.windows_uninstall_key,
              d.id AS developer_id, pr.publisher_name
       FROM packages p
       LEFT JOIN releases r ON r.id = p.release_id
       LEFT JOIN applications a ON a.id = p.application_id
       LEFT JOIN developers d ON d.id = r.developer_id
       LEFT JOIN developer_profiles pr ON pr.developer_id = d.id
       WHERE p.id=?`
    ).bind(id).first().catch(() => null);
    if (!pkg) return { error: 'Package not found', code: 'NOT_FOUND' };
    const checks = (await latestChecksForPackages(env, [id]))[id] || [];
    const history: any = await env.DB.prepare(
      `SELECT check_type, status, result, details, provider, error, created_at FROM package_security_results
       WHERE package_id=? ORDER BY created_at DESC LIMIT 100`
    ).bind(id).all().catch(() => ({ results: [] }));
    const overrides: any = await env.DB.prepare(
      `SELECT o.*, u.name AS admin_name FROM package_security_overrides o
       LEFT JOIN users u ON u.id = o.admin_user_id
       WHERE o.package_id=? AND o.invalidated_at IS NULL ORDER BY o.created_at DESC`
    ).bind(id).all().catch(() => ({ results: [] }));
    const reviews: any = await env.DB.prepare(
      `SELECT m.*, u.name AS admin_name FROM package_manual_reviews m
       LEFT JOIN users u ON u.id = m.admin_user_id
       WHERE m.package_id=? ORDER BY m.created_at DESC LIMIT 50`
    ).bind(id).all().catch(() => ({ results: [] }));
    // Public exposure state (the /r2/ serving gate is the enforcement).
    const publiclyServed = pkg.status === 'published';
    return {
      package: {
        id: pkg.id, platform: pkg.platform, architecture: pkg.architecture, filename: pkg.filename,
        sizeBytes: Number(pkg.file_size) || 0, sha256: pkg.sha256, storageKey: pkg.storage_key,
        securityState: pkg.security_state || 'QUARANTINED', overallSecurity: pkg.overall_security || 'PENDING',
        malwareStatus: pkg.security_scan_status || 'pending', signatureStatus: pkg.signature_status || 'pending',
        scanAt: pkg.scan_at, verifiedAt: pkg.verified_at,
        app: { id: pkg.app_id, name: pkg.app_name, slug: pkg.app_slug,
          androidPackageId: pkg.android_package_id, linuxPackageName: pkg.linux_package_name,
          windowsExecutable: pkg.windows_executable, windowsUninstallKey: pkg.windows_uninstall_key },
        release: { id: pkg.release_id, version: pkg.version, status: pkg.release_status },
        developer: { id: pkg.developer_id, publisherName: pkg.publisher_name },
        publiclyServed,
      },
      checks, history: history?.results || [], overrides: overrides?.results || [],
      manualReviews: (reviews?.results || []).map((m: any) => ({
        id: m.id, status: m.status, sha256: m.sha256, reason: m.reason, adminNotes: m.admin_notes,
        adminName: m.admin_name, openedAt: m.created_at, reviewedAt: m.reviewed_at, invalidatedAt: m.invalidated_at,
        automatedSnapshot: { integrity: m.automated_integrity, malware: m.automated_malware, overall: m.automated_overall },
        bindsCurrentBytes: String(m.sha256).toLowerCase() === String(pkg.sha256).toLowerCase(),
      })),
    };
  },

  /**
   * POST /admin/security/packages/:id/override {reason}
   * The ONLY bypass past a security blocker. Reason is REQUIRED (min 10 chars);
   * admin identity + timestamp recorded; audited globally and developer-side.
   */
  async overridePackage(request: Request, env: any) {
    const id = pathSeg(request, 4);
    const body = await request.json().catch(() => ({}));
    const reason = str(body.reason, 1000);
    if (reason.length < 10) {
      return { error: 'An override reason of at least 10 characters is required — overrides are audited decisions, not clicks.', code: 'VALIDATION_ERROR' };
    }
    const adminId = ((request as any).user as any)?.userId || null;
    if (!adminId) return { error: 'Admin identity required', code: 'UNAUTHORIZED' };

    const pkg: any = await env.DB.prepare('SELECT * FROM packages WHERE id=?').bind(id).first().catch(() => null);
    if (!pkg) return { error: 'Package not found', code: 'NOT_FOUND' };
    if (pkg.overall_security === 'PASSED' && pkg.security_state === 'SECURITY_REVIEW_COMPLETE') {
      return { error: 'This package already passed verification — no override needed', code: 'VALIDATION_ERROR' };
    }

    await env.DB.prepare(
      `INSERT INTO package_security_overrides (id, package_id, admin_user_id, reason, prior_state, prior_overall, sha256)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(rid('pso'), id, adminId, reason, pkg.security_state || 'QUARANTINED', pkg.overall_security || 'PENDING', String(pkg.sha256 || '')).run();
    await env.DB.prepare(
      `UPDATE packages SET security_state='SECURITY_OVERRIDE', overall_security='PASSED', verified_at=datetime('now') WHERE id=?`
    ).bind(id).run();

    // Audit: global + developer-scoped + a notification to the org.
    await env.DB.prepare(
      'INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?,?,?)'
    ).bind(rid('log'), 'security_override', 'package', id, JSON.stringify({ reason, adminId, prior: `${pkg.security_state}/${pkg.overall_security}` })).run().catch(() => {});
    if (pkg.developer_id ?? false) {
      await env.DB.prepare(
        'INSERT INTO developer_audit_logs (id, developer_id, actor_user_id, action, details) VALUES (?,?,?,?,?)'
      ).bind(rid('dl'), String(pkg.developer_id), adminId, 'security_override', JSON.stringify({ packageId: id, reason })).run().catch(() => {});
    }
    const members: any = await env.DB.prepare('SELECT user_id FROM developer_members WHERE developer_id=?')
      .bind(String(pkg.developer_id || '')).all().catch(() => ({ results: [] }));
    for (const m of members?.results || []) {
      await env.DB.prepare('INSERT INTO notifications (id, user_id, type, title, message, data, read) VALUES (?,?,?,?,?,?,0)')
        .bind(rid('n'), m.user_id, 'system', 'Security override applied to your package',
          `An administrator overrode a security blocker for ${pkg.filename}. Reason: ${reason}`).run().catch(() => {});
    }
    return { success: true, package: { id, securityState: 'SECURITY_OVERRIDE', overallSecurity: 'PASSED' } };
  },

  /**
   * GET /admin/security/review-queue — packages requiring MANUAL review,
   * prioritized: UNAVAILABLE → SCANNING → UNKNOWN → NEEDS_REVIEW (then age).
   * Displays everything the reviewer needs, including WHY automated
   * verification could not conclude and the current publication state.
   */
  async reviewQueue(request: Request, env: any) {
    const rows: any = await env.DB.prepare(
      `SELECT p.id AS package_id, p.platform, p.architecture, p.filename, p.file_size, p.sha256,
              p.security_state, p.overall_security, p.security_scan_status, p.signature_status, p.status AS package_status,
              r.id AS release_id, r.version, r.status AS release_status,
              a.name AS app_name, a.slug AS app_slug, d.id AS developer_id, pr.publisher_name,
              m.id AS review_id, m.status AS review_status, m.reason AS review_reason,
              m.automated_integrity, m.automated_malware, m.automated_overall, m.created_at AS review_created_at
       FROM packages p
       LEFT JOIN releases r ON r.id = p.release_id
       LEFT JOIN applications a ON a.id = p.application_id
       LEFT JOIN developers d ON d.id = r.developer_id
       LEFT JOIN developer_profiles pr ON pr.developer_id = d.id
       LEFT JOIN package_manual_reviews m ON m.package_id = p.id AND m.invalidated_at IS NULL
            AND m.id = (SELECT MAX(id) FROM package_manual_reviews m2 WHERE m2.package_id = p.id AND m2.invalidated_at IS NULL)
       WHERE p.deployment_url IS NULL
         AND p.overall_security != 'PASSED'
       ORDER BY p.created_at DESC LIMIT 300`
    ).all().catch(() => ({ results: [] }));
    const PRIORITY: Record<string, number> = { UNAVAILABLE: 0, SCANNING: 1, UNKNOWN: 2, NEEDS_REVIEW: 3, FAILED: 4, PENDING: 5, pending: 5 };
    const queue = (rows?.results || [])
      .map((p: any) => ({
        packageId: p.package_id, platform: p.platform, architecture: p.architecture, filename: p.filename,
        sizeBytes: Number(p.file_size) || 0, sha256: p.sha256,
        app: { name: p.app_name, slug: p.app_slug }, release: { id: p.release_id, version: p.version, status: p.release_status },
        developer: { id: p.developer_id, publisherName: p.publisher_name },
        automated: {
          securityState: p.security_state || 'QUARANTINED', overallSecurity: p.overall_security || 'PENDING',
          malwareStatus: p.security_scan_status || 'pending', signatureStatus: p.signature_status || 'pending',
        },
        manualReview: p.review_id ? {
          id: p.review_id, status: p.review_status, reason: p.review_reason,
          openedAt: p.review_created_at,
          automatedSnapshot: { integrity: p.automated_integrity, malware: p.automated_malware, overall: p.automated_overall },
        } : null,
        manualReviewEligible: manualReviewMalwareEligible(p.security_scan_status) || p.overall_security === 'NEEDS_REVIEW',
        publicationState: p.package_status === 'published' ? 'PUBLISHED' : 'BLOCKED',
        priority: PRIORITY[String(p.security_scan_status || '').toUpperCase()] ?? 6,
      }))
      .sort((a: any, b: any) => a.priority - b.priority);
    return { queue };
  },

  /**
   * POST /admin/security/packages/:id/manual-review {decision: 'APPROVE'|'REJECT', notes}
   *
   * The controlled manual fallback. Server-side enforced:
   *   - admin role verified from the users table (not just the JWT gate)
   *   - notes >= 10 chars (an audited decision, not a click)
   *   - a PENDING review must exist for EXACTLY the current sha256
   *   - automated integrity must be PASSED (bytes verified)
   *   - the latest malware verdict must NOT be DETECTED (detected malware is
   *     never manually approvable)
   * The automated statuses are NOT overwritten — the approval authorizes
   * publication separately (publication_authorization = MANUAL_APPROVAL).
   */
  async manualReview(request: Request, env: any) {
    const id = pathSeg(request, 4);
    const body = await request.json().catch(() => ({}));
    const decision = String(body.decision || '').toUpperCase();
    const notes = str(body.notes, 2000);
    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      return { error: "decision must be 'APPROVE' or 'REJECT'", code: 'VALIDATION_ERROR' };
    }
    if (notes.length < 10) {
      return { error: 'Review notes of at least 10 characters are required — manual reviews are audited decisions, not clicks.', code: 'VALIDATION_ERROR' };
    }
    const adminId = ((request as any).user as any)?.userId || null;
    if (!adminId) return { error: 'Admin identity required', code: 'UNAUTHORIZED' };
    // Server-side role enforcement (defense in depth beyond the /admin JWT gate).
    const admin: any = await env.DB.prepare('SELECT id, role FROM users WHERE id=?').bind(adminId).first().catch(() => null);
    if (!admin || admin.role !== 'admin') {
      return { error: 'Only administrators may approve or reject manual security reviews.', code: 'FORBIDDEN' };
    }

    const pkg: any = await env.DB.prepare('SELECT * FROM packages WHERE id=?').bind(id).first().catch(() => null);
    if (!pkg) return { error: 'Package not found', code: 'NOT_FOUND' };
    if (pkg.overall_security === 'PASSED' && pkg.security_state === 'SECURITY_REVIEW_COMPLETE') {
      return { error: 'This package already passed automated verification — no manual review needed', code: 'VALIDATION_ERROR' };
    }

    // The review record must be PENDING and bound to the EXACT current bytes.
    const review: any = await env.DB.prepare(
      `SELECT * FROM package_manual_reviews WHERE package_id=? AND status='PENDING' AND invalidated_at IS NULL ORDER BY created_at DESC LIMIT 1`
    ).bind(id).first().catch(() => null);
    if (!review) {
      return { error: 'No pending manual review for this package. Re-run the security pipeline first — reviews are opened automatically when verification cannot conclude.', code: 'NOT_FOUND' };
    }
    if (String(review.sha256).toLowerCase() !== String(pkg.sha256).toLowerCase()) {
      return { error: 'The pending review is bound to different package bytes (SHA-256 mismatch). Re-run the security pipeline for the current upload.', code: 'CONFLICT' };
    }

    if (decision === 'APPROVE') {
      // Approval preconditions (fail-closed).
      const integrity = await latestCheckStatus(env, id, 'integrity');
      if (integrity !== 'PASSED') {
        return { error: `Automated integrity is ${integrity || 'not recorded'} — manual approval requires verified bytes (integrity PASSED). Re-run the pipeline.`, code: 'FORBIDDEN' };
      }
      const malware = await latestCheckStatus(env, id, 'malware');
      if (malware === 'DETECTED') {
        return { error: 'Detected malware can never be manually approved. The automated verdict stands.', code: 'FORBIDDEN' };
      }
      if (malware && !manualReviewMalwareEligible(malware) && malware !== 'CLEAN') {
        return { error: `Automated malware status '${malware}' is not eligible for manual review.`, code: 'FORBIDDEN' };
      }
    }

    // Immutable audit event FIRST (every decision is audited).
    const auditId = rid('log');
    await env.DB.prepare(
      'INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?,?,?)'
    ).bind(auditId, decision === 'APPROVE' ? 'manual_security_review_approved' : 'manual_security_review_rejected', 'package', id,
      JSON.stringify({ reviewId: review.id, sha256: pkg.sha256, adminId, notes, automated: { integrity: review.automated_integrity, malware: review.automated_malware, overall: review.automated_overall } })
    ).run().catch(() => {});

    await env.DB.prepare(
      `UPDATE package_manual_reviews SET status=?, admin_user_id=?, admin_notes=?, reviewed_at=datetime('now'), audit_event_id=? WHERE id=?`
    ).bind(decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', adminId, notes, auditId, review.id).run();

    // Developer-side audit + notification (same pattern as the override).
    if (pkg.developer_id) {
      await env.DB.prepare(
        'INSERT INTO developer_audit_logs (id, developer_id, actor_user_id, action, details) VALUES (?,?,?,?,?)'
      ).bind(rid('dl'), String(pkg.developer_id), adminId, decision === 'APPROVE' ? 'manual_review_approved' : 'manual_review_rejected',
        JSON.stringify({ packageId: id, sha256: pkg.sha256, notes })).run().catch(() => {});
      const members: any = await env.DB.prepare('SELECT user_id FROM developer_members WHERE developer_id=?')
        .bind(String(pkg.developer_id)).all().catch(() => ({ results: [] }));
      for (const m of members?.results || []) {
        await env.DB.prepare('INSERT INTO notifications (id, user_id, type, title, message, data, read) VALUES (?,?,?,?,?,?,0)')
          .bind(rid('n'), m.user_id, 'system',
            decision === 'APPROVE' ? 'Manual security review approved' : 'Manual security review rejected',
            `${pkg.filename}: ${decision === 'APPROVE' ? 'an administrator approved the package after manual review' : 'an administrator rejected the package after manual review'}. Notes: ${notes}`)
          .run().catch(() => {});
      }
    }

    return {
      success: true,
      decision,
      // The automated verdict stays visible; the authorization is separate.
      automatedSecurityStatus: pkg.overall_security,
      manualReviewStatus: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      publicationAuthorization: decision === 'APPROVE' ? 'MANUAL_APPROVAL' : null,
      review: { id: review.id, sha256: review.sha256, reviewedAt: new Date().toISOString() },
    };
  },

  /** POST /admin/security/packages/:id/rescan — re-run the real pipeline. */
  async rescanPackage(request: Request, env: any) {
    const id = pathSeg(request, 4);
    const pkg: any = await env.DB.prepare('SELECT id FROM packages WHERE id=?').bind(id).first().catch(() => null);
    if (!pkg) return { error: 'Package not found', code: 'NOT_FOUND' };
    const result = await runSecurityPipeline(env, id);
    await env.DB.prepare(
      'INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?,?,?)'
    ).bind(rid('log'), 'security_rescan', 'package', id, JSON.stringify({ state: result.state, overall: result.overall })).run().catch(() => {});
    return { success: true, state: result.state, overall: result.overall, results: result.results };
  },
};
