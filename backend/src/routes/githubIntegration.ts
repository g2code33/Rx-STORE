/**
 * RX Store — GitHub Releases integration routes.
 *
 * Three surfaces, three authorization models:
 *   1. Developer connect flow (/developers/...) — Bearer-authenticated org
 *      member who owns the app; the GitHub App INSTALLATION (not the browser)
 *      is the source of truth for repository access.
 *   2. Admin approval center (/admin/github/...) — dispatched behind the /admin
 *      gate in index.ts (verified admin JWT attached); every handler ALSO
 *      re-checks the admin role (defense in depth).
 *   3. Webhook (/webhooks/github) — GitHub App webhook, HMAC-SHA256
 *      signature-verified; can NEVER approve or publish anything.
 */
import { resolveMembership } from './developers.ts';
import {
  githubAppConfig, githubConfigured, installationRepos,
} from '../services/github.ts';
import {
  connectAppRepository, disconnectAppRepository, getConnectionForApp,
  bindRepositoryFromCode,
  processWebhook, verifyGithubRelease, publishGithubRelease,
  rejectGithubRelease, withdrawGithubRelease, syncAllConnections,
  adminOverview, adminQueue, adminAudit, verifyPendingDetections, ensureGithubTables,
} from '../services/githubReleases.ts';
import { issueOneTimeToken, consumeOneTimeToken, restoreOneTimeToken } from '../services/oauth.ts';

type Result = { code?: string; message?: string; [k: string]: any } | null | undefined;

function err(d: Result): { code: string; message: string } | null {
  if (!d || (!d.code && !d.message && d.error)) return { code: 'VALIDATION_ERROR', message: String((d as any).error) };
  if (d && (d.code || d.error)) return { code: String(d.code || d.error), message: String(d.message || 'Request failed') };
  return null;
}

// ---------------------------------------------------------------------------
// Developer routes (org-authenticated)
// ---------------------------------------------------------------------------

async function requireOrg(env: any, request: Request): Promise<{ orgId: string; userId: string } | { error: string }> {
  const userId = (request as any).user?.userId;
  if (!userId) return { error: 'Sign in required.' };
  const membership = await resolveMembership(env, userId);
  if (!membership?.developer?.id) return { error: 'Developer account required. Apply in Developer Center first.' };
  return { orgId: String(membership.developer.id), userId: String(userId) };
}

async function ownFreeApp(env: any, orgId: string, appId: string): Promise<any | { error: string; code: string }> {
  const app: any = await env.DB.prepare(`SELECT * FROM applications WHERE id=?`).bind(appId).first().catch(() => null);
  if (!app || String(app.developer_org_id || '') !== orgId) return { error: 'Application not found.', code: 'NOT_FOUND' };
  return app;
}

export const githubDevRoutes = {
  /** GET /developers/apps/:id/github — connection status (honest config state). */
  async status(request: Request, env: any) {
    const org = await requireOrg(env, request);
    if ('error' in org) return { code: 'UNAUTHORIZED', message: org.error };
    const appId = new URL(request.url).pathname.split('/')[3];
    const app = await ownFreeApp(env, org.orgId, appId);
    if ((app as any).error) return app as any;
    await ensureGithubTables(env);
    const connection = await getConnectionForApp(env, appId);
    // Webhook events are scoped to THIS app's repository — never a global feed
    // (other developers' repository activity must not leak).
    const events: any = connection
      ? await env.DB.prepare(
          `SELECT event, action, status, detail, error, received_at FROM github_release_events WHERE repository_id=? ORDER BY received_at DESC LIMIT 5`
        ).bind(connection.repository_id).all().catch(() => ({ results: [] }))
      : { results: [] };
    return {
      configured: githubConfigured(env),
      setupHint: githubConfigured(env) ? null : 'An administrator must complete the GitHub App setup (docs/GITHUB_RELEASES.md) before repositories can be connected.',
      app: { id: (app as any).id, name: (app as any).name, priceType: (app as any).price_type },
      connection,
      recentEvents: events?.results || [],
    };
  },

  /**
   * POST /developers/apps/:id/github/connect — returns the GitHub App install
   * URL with a single-use state token binding {userId, appId}. The browser is
   * redirected to GitHub; nothing is connected yet.
   */
  async connect(request: Request, env: any) {
    const org = await requireOrg(env, request);
    if ('error' in org) return { code: 'UNAUTHORIZED', message: org.error };
    const cfg = githubAppConfig(env);
    if (!cfg) return { code: 'NOT_IMPLEMENTED', message: 'The GitHub integration is not configured on this deployment. An administrator must complete the GitHub App setup first (docs/GITHUB_RELEASES.md).' };
    const appId = new URL(request.url).pathname.split('/')[3];
    const app = await ownFreeApp(env, org.orgId, appId);
    if ((app as any).error) return app as any;
    if (['paid', 'subscription'].includes(String((app as any).price_type || 'free')) && Number((app as any).price_amount) > 0) {
      return { code: 'FORBIDDEN', message: 'GitHub distribution is available for FREE applications only. Paid applications use the manual admin upload channel.' };
    }
    const existing = await getConnectionForApp(env, appId);
    if (existing && existing.status === 'active') return { code: 'CONFLICT', message: 'This application is already connected. Disconnect it first to change repositories.' };
    const state = await issueOneTimeToken(env, 'state', { userId: org.userId, appId, kind: 'github-connect' });
    return { url: `https://github.com/apps/${cfg.appSlug}/installations/new?state=${encodeURIComponent(state)}` };
  },

  /**
   * GET /developers/github/callback — GitHub redirects the browser here after
   * the App installation. Validates the single-use state token (bound to the
   * initiating user + app), records the installation, and redirects to the
   * web app's repository picker with a one-time completion code. This route is
   * PUBLIC by necessity (GitHub -> browser redirect) but the state token is
   * the proof — no browser-supplied id is ever trusted beyond the match.
   */
  async callback(request: Request, env: any) {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') || '';
    const installationId = url.searchParams.get('installation_id') || '';
    const webBase = String(env?.RX_STORE_WEB_URL || 'https://rx-store-web.pages.dev').replace(/\/+$/, '');
    if (!state || !installationId) {
      return Response.redirect(`${webBase}/developers?gh_error=missing_parameters`, 302);
    }
    const payload = await consumeOneTimeToken(env, 'state', state);
    if (!payload || payload.kind !== 'github-connect' || !payload.userId || !payload.appId) {
      return Response.redirect(`${webBase}/developers?gh_error=invalid_state`, 302);
    }
    const code = await issueOneTimeToken(env, 'code', {
      kind: 'github-connect-complete', userId: String(payload.userId), appId: String(payload.appId),
      installationId: String(installationId),
    });
    return Response.redirect(`${webBase}/developers?gh_connect=${encodeURIComponent(code)}`, 302);
  },

  /**
   * POST /developers/github/complete {code} — exchange the completion code for
   * the server-resolved repository list of that installation. The caller must
   * be the SAME user who started the connection.
   */
  async complete(request: Request, env: any) {
    const org = await requireOrg(env, request);
    if ('error' in org) return { code: 'UNAUTHORIZED', message: org.error };
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const raw = String(body?.code || '');
    if (!raw) return { code: 'VALIDATION_ERROR', message: 'code is required' };
    const payload = await consumeOneTimeToken(env, 'code', raw, { allowRetry: true });
    if (!payload || payload.kind !== 'github-connect-complete') return { code: 'INVALID_TOKEN', message: 'This connection request is invalid or has expired. Start again.' };
    if (String(payload.userId) !== String(org.userId)) return { code: 'FORBIDDEN', message: 'This connection request was started by a different user.' };
    if (!githubConfigured(env)) return { code: 'NOT_IMPLEMENTED', message: 'The GitHub integration is not configured on this deployment.' };
    let repos: any[] = [];
    try { repos = await installationRepos(env, String(payload.installationId)); } catch {
      return { code: 'UNAUTHORIZED', message: 'The GitHub installation could not be read. Install the App on the repository and try again.' };
    }
    // The code stays live for the BIND step (it is consumed there, bound to
    // this user + app + installation — the client never re-supplies ids).
    await restoreOneTimeToken(env, raw);
    return {
      appId: String(payload.appId),
      installationId: String(payload.installationId),
      repos: repos.map((r) => ({ id: String(r.id), name: r.name, fullName: r.full_name, owner: r.owner?.login || '', private: r.private === true, url: r.html_url || '' })),
    };
  },

  /**
   * POST /developers/apps/:id/github/bind {code, repositoryId}
   * The installation comes from the SERVER-ISSUED completion code (bound to
   * the initiating user + app) — a client-supplied installationId is NEVER
   * trusted, so one developer cannot bind another organization's repository.
   */
  async bind(request: Request, env: any) {
    const org = await requireOrg(env, request);
    if ('error' in org) return { code: 'UNAUTHORIZED', message: org.error };
    const appId = new URL(request.url).pathname.split('/')[3];
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const out = await bindRepositoryFromCode(env, {
      orgId: org.orgId, userId: org.userId, appId,
      code: String(body?.code || ''), repositoryId: String(body?.repositoryId || ''),
    });
    if (!out.ok) return { code: out.code, message: out.message };
    return { connection: out.connection };
  },

  /** POST /developers/apps/:id/github/disconnect */
  async disconnect(request: Request, env: any) {
    const org = await requireOrg(env, request);
    if ('error' in org) return { code: 'UNAUTHORIZED', message: org.error };
    const appId = new URL(request.url).pathname.split('/')[3];
    const out = await disconnectAppRepository(env, { appId, orgId: org.orgId, userId: org.userId });
    if (!out.ok) return { code: out.code, message: out.message };
    return { success: true };
  },
};

// ---------------------------------------------------------------------------
// Admin routes (behind the /admin gate; role re-checked here)
// ---------------------------------------------------------------------------

function requireAdmin(request: Request): { userId: string; label: string } | { error: string } {
  const u = (request as any).user;
  if (!u?.userId) return { error: 'Admin identity required.' };
  if (String(u.role || '') !== 'admin') return { error: 'Admin role required.' };
  return { userId: String(u.userId), label: `admin:${String(u.userId).slice(0, 8)}` };
}

export const githubAdminRoutes = {
  /** GET /admin/github/overview */
  async overview(request: Request, env: any) {
    const admin = requireAdmin(request);
    if ('error' in admin) return { code: 'UNAUTHORIZED', message: admin.error };
    return adminOverview(env);
  },

  /** GET /admin/github/releases?status=&appId= */
  async releases(request: Request, env: any) {
    const admin = requireAdmin(request);
    if ('error' in admin) return { code: 'UNAUTHORIZED', message: admin.error };
    const url = new URL(request.url);
    return {
      releases: await adminQueue(env, {
        status: url.searchParams.get('status') || undefined,
        appId: url.searchParams.get('appId') || undefined,
      }),
    };
  },

  /** POST /admin/github/releases/:id/publish {overrideSecurity?, reason?} */
  async publish(request: Request, env: any, ctx?: any) {
    const admin = requireAdmin(request);
    if ('error' in admin) return { code: 'UNAUTHORIZED', message: admin.error };
    const id = new URL(request.url).pathname.split('/')[4] || '';
    let body: any = {};
    try { body = await request.json(); } catch {}
    const out = await publishGithubRelease(env, admin, id, {
      overrideSecurity: body?.overrideSecurity === true,
      reason: String(body?.reason || ''),
    });
    if (!out.ok) return { code: out.code, message: out.message };
    return { success: true, version: out.version };
  },

  /** POST /admin/github/releases/:id/reject {reason} */
  async reject(request: Request, env: any) {
    const admin = requireAdmin(request);
    if ('error' in admin) return { code: 'UNAUTHORIZED', message: admin.error };
    const id = new URL(request.url).pathname.split('/')[4] || '';
    let body: any = {};
    try { body = await request.json(); } catch {}
    const out = await rejectGithubRelease(env, admin, id, String(body?.reason || ''));
    if (!out.ok) return { code: out.code, message: out.message };
    return { success: true };
  },

  /** POST /admin/github/releases/:id/withdraw {reason} */
  async withdraw(request: Request, env: any) {
    const admin = requireAdmin(request);
    if ('error' in admin) return { code: 'UNAUTHORIZED', message: admin.error };
    const id = new URL(request.url).pathname.split('/')[4] || '';
    let body: any = {};
    try { body = await request.json(); } catch {}
    const out = await withdrawGithubRelease(env, admin, id, String(body?.reason || ''));
    if (!out.ok) return { code: out.code, message: out.message };
    return { success: true };
  },

  /** POST /admin/github/releases/:id/retry — re-run verification (never publishes). */
  async retry(request: Request, env: any) {
    const admin = requireAdmin(request);
    if ('error' in admin) return { code: 'UNAUTHORIZED', message: admin.error };
    const id = new URL(request.url).pathname.split('/')[4] || '';
    const out = await verifyGithubRelease(env, id);
    if (!out.ok && out.status === 'not_found') return { code: 'NOT_FOUND', message: out.message };
    return { success: out.ok, status: out.status, message: out.message };
  },

  /** POST /admin/github/sync — reconcile all active connections now. */
  async sync(request: Request, env: any, ctx?: any) {
    const admin = requireAdmin(request);
    if ('error' in admin) return { code: 'UNAUTHORIZED', message: admin.error };
    const out = await syncAllConnections(env, admin);
    if (ctx?.waitUntil) ctx.waitUntil(verifyPendingDetections(env).catch(() => {}));
    return out;
  },

  /** GET /admin/github/audit */
  async audit(request: Request, env: any) {
    const admin = requireAdmin(request);
    if ('error' in admin) return { code: 'UNAUTHORIZED', message: admin.error };
    return { entries: await adminAudit(env) };
  },
};

// ---------------------------------------------------------------------------
// Webhook (public, signature-verified)
// ---------------------------------------------------------------------------

export const githubWebhookRoutes = {
  async handle(request: Request, env: any, ctx?: any) {
    const rawBody = await request.text();
    const out = await processWebhook(env, {
      rawBody,
      signatureHeader: request.headers.get('X-Hub-Signature-256'),
      deliveryId: request.headers.get('X-GitHub-Delivery'),
      event: request.headers.get('X-GitHub-Event'),
    });
    // Detection happened -> kick a bounded background verification (never
    // publishes; the approval gate is admin-only).
    if (out.status === 200 && out.body?.data?.status === 'detected' && ctx?.waitUntil) {
      ctx.waitUntil(verifyPendingDetections(env).catch(() => {}));
    }
    return out;
  },
};
