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
  githubAppConfig, githubConfigured, githubMissingSecrets, installationRepos,
  githubAppOAuthConfigured, userAuthorizeUrl, exchangeUserCode,
  userInstallations, userInstallationRepos, type UserRepo,
} from '../services/github.ts';
import {
  connectAppRepository, disconnectAppRepository, getConnectionForApp,
  bindRepositoryFromCode,
  processWebhook, verifyGithubRelease, publishGithubRelease,
  rejectGithubRelease, withdrawGithubRelease, syncAllConnections,
  adminOverview, adminQueue, adminAudit, verifyPendingDetections, ensureGithubTables,
  adminConnectionsOverview, adminSetConnectionStatus,
} from '../services/githubReleases.ts';
import { issueOneTimeToken, consumeOneTimeToken, restoreOneTimeToken, apiCallbackBase } from '../services/oauth.ts';

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
      // Honest diagnostics: which required secrets are missing/empty (names
      // only — values are never exposed). Empty when everything is set.
      missing: githubConfigured(env) ? [] : githubMissingSecrets(env),
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

    // PREFERRED: user authorization with the GitHub App's own OAuth client.
    // It lists only the installations/repos THIS user can access, survives the
    // "already installed" case, and completes on a self-contained page (no
    // RX Store session needed in the browser that finishes it).
    if (githubAppOAuthConfigured(env)) {
      const state = await issueOneTimeToken(env, 'state', { userId: org.userId, appId, kind: 'github-oauth' });
      const redirectUri = `${apiCallbackBase(env, request)}/developers/github/callback`;
      const url = userAuthorizeUrl(env, { state, redirectUri });
      if (url) return { url };
    }

    // Fallback: GitHub App INSTALL redirect (needs a fresh install + state).
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
    const oauthCode = url.searchParams.get('code') || '';
    const webBase = String(env?.RX_STORE_WEB_URL || 'https://rx-store-web.pages.dev').replace(/\/+$/, '');

    // ---- USER-AUTHORIZATION callback: list the repos this user can access ----
    if (oauthCode) return oauthPicketResponse(env, request, { code: oauthCode, state, webBase });
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
    // Land on the APP DETAIL page — that is where the connect panel (and the
    // repository picker) lives. Redirecting to /developers left the completion
    // code unconsumed: the panel never saw it, the bind never happened, and
    // the user saw "Connect" again despite a successful GitHub installation.
    return Response.redirect(`${webBase}/developers/apps/${encodeURIComponent(String(payload.appId))}?gh_connect=${encodeURIComponent(code)}`, 302);
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
// User-authorization completion (self-contained pages, no RX Store session)
// ---------------------------------------------------------------------------

function htmlPage(title: string, body: string): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" /><title>${title}</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;background:#0f1419;color:#e6e8eb;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
 .wrap{max-width:720px;margin:0 auto;padding:40px 20px}
 h1{font-size:20px;margin:0 0 6px}
 p.sub{color:#9aa4b2;margin:0 0 24px;font-size:13px}
 .card{background:#1a2332;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px;margin-bottom:10px;display:flex;align-items:center;gap:12px}
 .card button{background:#ffd600;color:#0f1419;border:0;border-radius:10px;padding:8px 14px;font-weight:700;cursor:pointer;margin-left:auto}
 .card button:disabled{opacity:.45;cursor:not-allowed}
 .muted{color:#9aa4b2;font-size:12px}
 .ok{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.35)}
 .err{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.35)}
 .btn{display:inline-block;background:#ffd600;color:#0f1419;border:0;border-radius:10px;padding:10px 16px;font-weight:700;text-decoration:none}
 .brand{font-weight:800;letter-spacing:.02em;margin-bottom:22px}
 .brand span{color:#ffd600}
</style></head><body><div class="wrap"><div class="brand">RX <span>Store</span></div>${body}</div></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
}

function errorPage(message: string, webBase: string): Response {
  return htmlPage('RX Store — GitHub connection', `<div class="card err"><div><h1>Could not finish connecting</h1><p class="muted">${message}</p></div></div>
    <a class="btn" href="${webBase}/developers/apps">Back to RX Store</a>`);
}

/**
 * Exchange the user authorization code, list the installations/repositories
 * THIS user can access, and render the picker. The completion code is a
 * server-issued one-time token bound to {user, app, allowed repos} — the
 * browser never decides what it may bind.
 */
async function oauthPicketResponse(env: any, request: Request, input: { code: string; state: string; webBase: string }): Promise<Response> {
  if (!githubAppOAuthConfigured(env)) return errorPage('User authorization is not configured on this deployment.', input.webBase);
  const payload = await consumeOneTimeToken(env, 'state', input.state);
  if (!payload || payload.kind !== 'github-oauth' || !payload.userId || !payload.appId) {
    return errorPage('This connection request expired or was already used. Start again from RX Store.', input.webBase);
  }
  const redirectUri = `${apiCallbackBase(env, request)}/developers/github/callback`;
  const token = await exchangeUserCode(env, { code: input.code, redirectUri });
  if (!token) return errorPage('GitHub did not return a valid authorization. Try again from RX Store.', input.webBase);

  const installations = await userInstallations(token);
  const repos: UserRepo[] = [];
  for (const inst of installations) {
    const list = await userInstallationRepos(token, inst.installationId);
    repos.push(...list);
    if (repos.length >= 300) break;
  }
  if (!repos.length) {
    return errorPage('No repositories are available. Install the RX Store Releases app on a repository first, then start again.', input.webBase);
  }
  // Server-issued completion code: only these repo ids may be bound.
  const completion = await issueOneTimeToken(env, 'code', {
    kind: 'github-oauth-bind', userId: String(payload.userId), appId: String(payload.appId),
    allowed: repos.map((r) => ({ id: r.repositoryId, installationId: r.installationId, fullName: r.fullName })),
  });

  const publicRepos = repos.filter((r) => !r.private);
  const privateCount = repos.length - publicRepos.length;
  const rows = publicRepos.map((r) => `
    <form class="card" method="POST" action="/v1/developers/github/oauth/bind">
      <input type="hidden" name="code" value="${escapeHtml(completion)}" />
      <input type="hidden" name="repositoryId" value="${escapeHtml(r.repositoryId)}" />
      <div><strong>${escapeHtml(r.fullName)}</strong><div class="muted">public repository</div></div>
      <button type="submit">Connect</button>
    </form>`).join('');
  return htmlPage('RX Store — connect a repository', `
    <h1>Choose the repository for your app</h1>
    <p class="sub">RX Store Releases will read this repository's releases and release assets (read-only). Users download installers straight from GitHub.</p>
    ${rows || '<div class="card"><div>No public repositories found.</div></div>'}
    ${privateCount ? `<p class="muted">${privateCount} private repository(ies) are not listed — RX Store needs a public repository so users can download without credentials.</p>` : ''}
    <p style="margin-top:24px"><a class="btn" href="${escapeHtml(input.webBase)}/developers/apps">Cancel</a></p>`);
}

function escapeHtml(v: string): string {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export const githubOAuthRoutes = {
  /** POST /developers/github/oauth/bind (public form post; the code is the proof). */
  async bind(request: Request, env: any): Promise<Response> {
    const webBase = String(env?.RX_STORE_WEB_URL || 'https://rx-store-web.pages.dev').replace(/\/+$/, '');
    let code = '';
    let repositoryId = '';
    try {
      const ct = String(request.headers.get('Content-Type') || '');
      if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
        const fd: any = await request.formData();
        code = String(fd.get('code') || '');
        repositoryId = String(fd.get('repositoryId') || '');
      } else {
        const j: any = await request.json().catch(() => ({}));
        code = String(j?.code || ''); repositoryId = String(j?.repositoryId || '');
      }
    } catch { /* handled below */ }
    if (!code || !repositoryId) return errorPage('Missing connection details — start again from RX Store.', webBase);

    const payload = await consumeOneTimeToken(env, 'code', code, { allowRetry: true });
    if (!payload || payload.kind !== 'github-oauth-bind') return errorPage('This connection link expired or was already used — start again from RX Store.', webBase);
    const allowed: Array<{ id: string; installationId: string; fullName: string }> = Array.isArray(payload.allowed) ? payload.allowed : [];
    const match = allowed.find((r) => String(r.id) === String(repositoryId));
    if (!match) {
      await restoreOneTimeToken(env, code);
      return errorPage('That repository is not part of this authorization. Pick one from the list.', webBase);
    }
    // Resolve the developer org from the user who STARTED the flow (server-side).
    const { resolveMembership } = await import('./developers.ts');
    const ms = await resolveMembership(env, String(payload.userId));
    if (!ms?.developer?.id) return errorPage('Your RX Store developer account could not be found.', webBase);

    const out = await connectAppRepository(env, {
      appId: String(payload.appId), orgId: String(ms.developer.id), userId: String(payload.userId),
      installationId: match.installationId, repositoryId: match.id,
    });
    if (!out.ok) {
      await restoreOneTimeToken(env, code);
      return errorPage(String(out.message || 'The repository could not be connected.'), webBase);
    }
    return htmlPage('RX Store — connected', `
      <div class="card ok"><div><h1>Repository connected ✓</h1><p class="muted">${escapeHtml(match.fullName)} is now linked. Publish a GitHub Release there and it will appear in Admin → GitHub Releases for approval.</p></div></div>
      <p class="muted">You can close this window — RX Store picks up the connection automatically.</p>
      <p style="margin-top:20px"><a class="btn" href="${escapeHtml(webBase)}/developers/apps/${encodeURIComponent(String(payload.appId))}">Back to your app</a></p>`);
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

  /** GET /admin/github/connections — every app + its GitHub connection state. */
  async connections(request: Request, env: any) {
    const admin = requireAdmin(request);
    if ('error' in admin) return { code: 'UNAUTHORIZED', message: admin.error };
    return adminConnectionsOverview(env);
  },

  /** POST /admin/github/connections/:appId/suspend|reinstate|disconnect {reason} */
  async connectionAction(request: Request, env: any) {
    const admin = requireAdmin(request);
    if ('error' in admin) return { code: 'UNAUTHORIZED', message: admin.error };
    const parts = new URL(request.url).pathname.split('/');
    // /admin/github/connections/<appId>/<action>
    const appId = parts[4] || '';
    const action = parts[5] || '';
    if (!['suspend', 'reinstate', 'disconnect'].includes(action)) {
      return { code: 'VALIDATION_ERROR', message: 'Unknown connection action.' };
    }
    let body: any = {};
    try { body = await request.json(); } catch {}
    const out = await adminSetConnectionStatus(env, admin, appId, action as any, String(body?.reason || ''));
    if (!out.ok) return { code: out.code, message: out.message };
    return { success: true, status: out.status };
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
