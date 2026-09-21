/**
 * Admin package-security routes (Phase 13 §12).
 *
 * All routes are admin-gated by index.ts (/admin/* requires an admin JWT
 * before any handler runs). The override is the ONLY way past a security
 * blocker and requires an explicit reason (server-enforced), records the
 * admin identity + timestamp, and writes both the global audit log and the
 * developer-scoped audit log.
 */

import { runSecurityPipeline, latestChecksForPackages, rid } from '../services/packageSecurity.ts';

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
       WHERE o.package_id=? ORDER BY o.created_at DESC`
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
      `INSERT INTO package_security_overrides (id, package_id, admin_user_id, reason, prior_state, prior_overall)
       VALUES (?,?,?,?,?,?)`
    ).bind(rid('pso'), id, adminId, reason, pkg.security_state || 'QUARANTINED', pkg.overall_security || 'PENDING').run();
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
