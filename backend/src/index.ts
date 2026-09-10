/**
 * RX Store Backend API — Cloudflare Workers entry point
 */
import { Router } from './router';
import { authMiddleware } from './middleware/auth';
import { rateLimiter } from './middleware/rateLimiter';
import { corsMiddleware, corsHeaders } from './middleware/cors';

import { authRoutes } from './routes/auth';
import { appsRoutes } from './routes/apps';
import { usersRoutes } from './routes/users';
import { paymentsRoutes } from './routes/payments';
import { adminRoutes } from './routes/admin';
import { aiRoutes } from './routes/ai';
import { getSetting, getAllSettings, putSettings, SETTING_DEFAULTS, PUBLIC_SETTING_KEYS } from './services/settings';
import { getAllContent, putContent, getContentHistory, revertContent } from './services/content';
import { trackAdEvent, getAdStats, createAdShare, listAdShares, revokeAdShare, getPublicShare } from './services/ads';
import { updatesRoutes } from './routes/updates';
import { devicesRoutes } from './routes/devices';
import { verifyAccessToken } from './services/auth';
import { apiErrorBody, statusForCode, requestIdFor, redact, type ErrorCode } from './services/errors';
import { selectPackage, buildManifest, normalizeChannel, defaultChannel } from './services/releases';

const router = new Router();

router.use(corsMiddleware);
router.use(rateLimiter);

router.use('/auth', authRoutes);
router.use('/apps', appsRoutes);
router.use('/categories', appsRoutes);
router.use('/updates', updatesRoutes);
router.use('/update', updatesRoutes);
router.use('/users', authMiddleware, usersRoutes);
router.use('/payments', authMiddleware, paymentsRoutes);
router.use('/admin', authMiddleware, adminRoutes);

router.get('/health', () => ({
  status: 'ok',
  version: '1.0.0',
  timestamp: new Date().toISOString(),
}));

/** Baseline security headers applied to every API response. */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

function jsonRaw(data: any, status = 200, origin = '', env?: any, requestId?: string) {
  const rid = requestId || '';
  // Attach the request id to error bodies so clients can reference it in support.
  const body = (data && typeof data === 'object' && data.success === false && data.error)
    ? { ...data, error: { requestId: rid, ...data.error } }
    : data;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(rid ? { 'X-Request-Id': rid } : {}),
      ...SECURITY_HEADERS,
      ...corsHeaders(origin, env),
    },
  });
}

// Decode the JWT payload and require the admin role (same decode pattern as /users/me)
async function isAdminRequest(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  try { return (await verifyAccessToken(auth.slice(7), env.JWT_SECRET || '')).role === 'admin'; }
  catch { return false; }
}

function withCors(res: Response, origin: string, env?: any, requestId?: string): Response {
  const headers = new Headers(res.headers);
  const cors = corsHeaders(origin, env);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (requestId) headers.set('X-Request-Id', requestId);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.startsWith('/v1')) path = path.slice(3) || '/';
    const normalizedUrl = new URL(request.url);
    normalizedUrl.pathname = path;
    const normalizedRequest = new Request(normalizedUrl.toString(), request);
    const origin = request.headers.get('Origin') || '';

    // Correlation id for this request — returned in every response and attached
    // to error bodies so issues can be traced without exposing internals.
    const requestId = requestIdFor(request);
    const respond = (data: any, status = 200, originArg: string = origin) => jsonRaw(data, status, originArg, env, requestId);
    // Standardized error responder (never leaks internal messages).
    const fail = (code: ErrorCode, message: string, statusOverride?: number) =>
      respond(apiErrorBody(code, message, requestId), statusOverride ?? statusForCode(code));

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...corsHeaders(origin, env), 'X-Request-Id': requestId, ...SECURITY_HEADERS } });
    }

    // Every /admin/* endpoint requires a valid admin JWT (production hardening —
    // previously PUT/DELETE apps, releases, uploads etc. were open to any request)
    if (path.startsWith('/admin')) {
      if (!await isAdminRequest(request, env)) return respond({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
    }

    if ((path === '/updates/check' || path === '/update/check' || path === '/api/updates/check' || path === '/api/update/check') && request.method === 'GET') {
      const data = await updatesRoutes.checkUpdate(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: { code: 'NOT_FOUND', message: (data as any).error } }, 404, origin);
      return respond({ success: true, data }, 200, origin);
    }

    if (path === '/admin/ai/settings' && (request.method === 'PUT' || request.method === 'POST')) {
      if (!await isAdminRequest(request, env)) return respond({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      const data = await aiRoutes.updateSettings(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: data }, 400, origin);
      return respond({ success: true, data }, 200, origin);
    }
    // Admin: read full AI settings (unmasked keys) to pre-fill the Admin UI
    if (path === '/admin/ai/settings' && request.method === 'GET') {
      if (!await isAdminRequest(request, env)) return respond({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      const data = await aiRoutes.getSettings(normalizedRequest as any, env);
      return respond({ success: true, data }, 200, origin);
    }
    // Admin: test a provider key (typed in the form or stored) against the real provider
    if (path === '/admin/ai/test' && request.method === 'POST') {
      if (!await isAdminRequest(request, env)) return respond({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      const data = await aiRoutes.test(normalizedRequest as any, env);
      if ((data as any)?.error && !(data as any)?.ok) return respond({ success: false, error: data }, 400, origin);
      return respond({ success: true, data }, 200, origin);
    }
    if (path === '/admin/users' && request.method === 'GET') {
      const data = await adminRoutes.listUsers(normalizedRequest as any, env);
      return respond({ success: true, data }, 200, origin);
    }
    if (path.match(/^\/admin\/users\/[^\/]+\/role$/) && request.method === 'PATCH') {
      const data = await adminRoutes.updateUserRole(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: data }, 400, origin);
      return respond({ success: true, data }, 200, origin);
    }
    // Mark a user as having an active advertisement
    if (path.match(/^\/admin\/users\/[^\/]+\/advertiser$/) && request.method === 'PATCH') {
      const data = await (adminRoutes as any).setUserAdvertiser(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: data }, 400, origin);
      return respond({ success: true, data }, 200, origin);
    }
    // Admin resets a user's login for them (returns a temp password when none supplied)
    if (path.match(/^\/admin\/users\/[^\/]+\/reset-password$/) && request.method === 'POST') {
      const data = await (adminRoutes as any).resetUserPassword(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: data }, 400, origin);
      return respond({ success: true, data }, 200, origin);
    }
    if (path === '/admin/revenue' && request.method === 'GET') {
      const data = await adminRoutes.revenue(normalizedRequest as any, env);
      return respond({ success: true, data }, 200, origin);
    }
    if (path === '/admin/dashboard' && request.method === 'GET') {
      const data = await adminRoutes.dashboard(normalizedRequest as any, env);
      return respond({ success: true, data }, 200, origin);
    }
    // New Release Management
    if (path === '/admin/releases' && request.method === 'POST') {
      const data = await (adminRoutes as any).createNewRelease(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: { code: 'ERROR', message: (data as any).error } }, 400, origin);
      return respond({ success: true, data }, 200, origin);
    }
    if (path === '/admin/releases' && request.method === 'GET') {
      const data = await (adminRoutes as any).listReleases(normalizedRequest as any, env);
      return respond({ success: true, data }, 200, origin);
    }
    if (path.match(/^\/admin\/releases\/[^\/]+$/) && request.method === 'GET') {
      const data = await (adminRoutes as any).getRelease(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: data }, 404, origin);
      return respond({ success: true, data }, 200, origin);
    }
    if (path.match(/^\/admin\/releases\/[^\/]+\/publish$/) && request.method === 'POST') {
      const data = await (adminRoutes as any).publishRelease(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: { code: 'ERROR', message: (data as any).error } }, 400, origin);
      return respond({ success: true, data }, 200, origin);
    }
    // Package upload for a release: stores to R2 + sha256 + packages row, keeps releases in sync
    if (path.match(/^\/admin\/releases\/[^\/]+\/upload$/) && request.method === 'POST') {
      if (!await isAdminRequest(request, env)) return respond({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      try {
        const data = await (adminRoutes as any).uploadPackage(normalizedRequest as any, env);
        if ((data as any)?.error) return respond({ success: false, error: { code: 'ERROR', message: (data as any).error } }, 400, origin);
        return respond({ success: true, data }, 200, origin);
      } catch (e: any) { console.error(`[${requestId}] error:`, redact(String(e?.message||e))); return fail('INTERNAL', 'Something went wrong. Please try again.'); }
    }
    // Chunked upload for big installers: start → part×N → complete (R2 multipart)
    if (path.match(/^\/admin\/releases\/[^\/]+\/upload\/(start|part|complete|abort)$/) && request.method === 'POST') {
      if (!await isAdminRequest(request, env)) return respond({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      const step = path.split('/').pop() as string;
      const fn = { start: 'uploadPackageStart', part: 'uploadPackagePart', complete: 'uploadPackageComplete', abort: 'uploadPackageAbort' }[step] as string;
      try {
        const data = await (adminRoutes as any)[fn](normalizedRequest as any, env);
        if ((data as any)?.error) return respond({ success: false, error: { code: 'ERROR', message: (data as any).error } }, 400, origin);
        return respond({ success: true, data }, 200, origin);
      } catch (e: any) { console.error(`[${requestId}] error:`, redact(String(e?.message||e))); return fail('INTERNAL', 'Something went wrong. Please try again.'); }
    }
    if (path.match(/^\/admin\/releases\/[^\/]+\/rollback$/) && request.method === 'POST') {
      const data = await (adminRoutes as any).rollbackRelease(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: { code: 'ERROR', message: (data as any).error } }, 400, origin);
      return respond({ success: true, data }, 200, origin);
    }
    // Recycle Bin — list soft-deleted items and restore them
    if (path === '/admin/recycle' && request.method === 'GET') {
      const data = await adminRoutes.listDeleted(normalizedRequest as any, env);
      return respond({ success: true, data }, 200, origin);
    }
    if (path.match(/^\/admin\/apps\/[^\/]+\/restore$/) && request.method === 'POST') {
      const data = await adminRoutes.restoreApp(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: data }, 400, origin);
      return respond({ success: true, data }, 200, origin);
    }
    // Recycle Bin — permanent delete (only works on soft-deleted apps)
    if (path.match(/^\/admin\/apps\/[^\/]+\/purge$/) && request.method === 'POST') {
      try {
        const data = await (adminRoutes as any).purgeApp(normalizedRequest as any, env);
        if ((data as any)?.error) return respond({ success: false, error: { code: 'ERROR', message: (data as any).error } }, 400, origin);
        return respond({ success: true, data }, 200, origin);
      } catch (e: any) { console.error(`[${requestId}] error:`, redact(String(e?.message||e))); return fail('INTERNAL', 'Something went wrong. Please try again.'); }
    }
    // Site Settings — public safe subset vs full admin read/write
    if (path === '/settings' && request.method === 'GET') {
      const all = await getAllSettings(env);
      const out: Record<string, string> = {};
      for (const k of PUBLIC_SETTING_KEYS) out[k] = all[k] ?? (SETTING_DEFAULTS as any)[k] ?? '';
      return respond({ success: true, data: out }, 200, origin);
    }
    // Site Content (Live Website Builder) — public read, admin write
    if (path === '/content' && request.method === 'GET') {
      return respond({ success: true, data: await getAllContent(env) }, 200, origin);
    }
    if (path === '/admin/content' && (request.method === 'PUT' || request.method === 'POST')) {
      let body: any = {};
      try { body = await request.json(); } catch { /* empty */ }
      const src = (body && typeof body.content === 'object' && body.content)
        || (typeof body?.key === 'string' ? { [body.key]: body.value } : body) || {};
      const result = await putContent(env, src);
      return respond({ success: true, data: { message: `Saved ${result.saved.length} item(s)`, ...result, content: await getAllContent(env) } }, 200, origin);
    }
    // Revision history for one key (Live Website Builder → History)
    if (path === '/admin/content/history' && request.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      if (!key) return respond({ success: false, error: { code: 'BAD_REQUEST', message: 'key required' } }, 400, origin);
      return respond({ success: true, data: { revisions: await getContentHistory(env, key) } }, 200, origin);
    }
    if (path === '/admin/content/revert' && request.method === 'POST') {
      let body: any = {};
      try { body = await request.json(); } catch { /* empty */ }
      const r = await revertContent(env, String(body?.key || ''), Number(body?.id) || 0);
      if (!r.ok) return respond({ success: false, error: { code: 'NOT_FOUND', message: 'Revision not found' } }, 404, origin);
      return respond({ success: true, data: { message: 'Reverted', key: body?.key, value: r.value, content: await getAllContent(env) } }, 200, origin);
    }
    // Intro Ads — public beacon counts a view/click; admin reads the totals
    if (path === '/ads/track' && request.method === 'POST') {
      let body: any = {};
      try { body = await request.json(); } catch { /* empty */ }
      const r = await trackAdEvent(env, String(body?.id || ''), String(body?.type || ''));
      if (!r.ok) return respond({ success: false, error: { code: 'BAD_REQUEST', message: r.error } }, 400, origin);
      return respond({ success: true, data: { message: 'tracked' } }, 200, origin);
    }
    if (path === '/admin/ads/stats' && request.method === 'GET') {
      return respond({ success: true, data: { stats: await getAdStats(env) } }, 200, origin);
    }
    // Sponsor self-serve — admin mints a read-only dashboard link per ad
    if (path === '/admin/ads/shares' && request.method === 'POST') {
      let body: any = {};
      try { body = await request.json(); } catch { /* empty */ }
      const r = await createAdShare(env, String(body?.adId || ''), String(body?.label || ''));
      if (!r.ok) return respond({ success: false, error: { code: 'BAD_REQUEST', message: r.error } }, 400, origin);
      return respond({ success: true, data: r.share }, 200, origin);
    }
    if (path === '/admin/ads/shares' && request.method === 'GET') {
      return respond({ success: true, data: { shares: await listAdShares(env) } }, 200, origin);
    }
    if (path.match(/^\/admin\/ads\/shares\/[a-f0-9]{32}$/) && request.method === 'DELETE') {
      const token = path.split('/').pop() || '';
      const removed = await revokeAdShare(env, token);
      if (!removed) return respond({ success: false, error: { code: 'NOT_FOUND', message: 'Share link not found' } }, 404, origin);
      return respond({ success: true, data: { message: 'Share link revoked' } }, 200, origin);
    }
    // Public, token-gated sponsor dashboard data — totals + last 30 days
    if (path.match(/^\/ads\/public\/[a-f0-9]{32}$/) && request.method === 'GET') {
      const token = path.split('/').pop() || '';
      const stats = await getPublicShare(env, token);
      if (!stats) return respond({ success: false, error: { code: 'NOT_FOUND', message: 'Unknown or revoked sponsor link' } }, 404, origin);
      return respond({ success: true, data: stats }, 200, origin);
    }
    if (path === '/admin/settings' && request.method === 'GET') {
      const all = await getAllSettings(env);
      return respond({ success: true, data: { ...SETTING_DEFAULTS, ...all } }, 200, origin);
    }
    if (path === '/admin/settings' && (request.method === 'PUT' || request.method === 'POST')) {
      let body: any = {};
      try { body = await request.json(); } catch { /* empty body = no-op */ }
      const src = (body && typeof body.settings === 'object' && body.settings) || body || {};
      const updates: Record<string, string> = {};
      for (const k of Object.keys(SETTING_DEFAULTS)) {
        if (!(k in src)) continue;
        const v = src[k];
        updates[k] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v ?? '').slice(0, 500);
      }
      await putSettings(env, updates);
      return respond({ success: true, data: { message: 'Settings saved', settings: { ...SETTING_DEFAULTS, ...(await getAllSettings(env)) } } }, 200, origin);
    }
    if (path === '/admin/reset-stats' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ')) return respond({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      const data = await adminRoutes.resetStats(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: { code: 'FORBIDDEN', message: (data as any).error } }, 403, origin);
      return respond({ success: true, data }, 200, origin);
    }
    if (path === '/admin/apps/reset' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ')) return respond({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      const data = await (adminRoutes as any).resetApps(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: { code: 'FORBIDDEN', message: (data as any).error } }, 403, origin);
      return respond({ success: true, data }, 200, origin);
    }
    if (path.match(/^\/admin\/apps\/[^\/]+\/releases$/) && request.method === 'POST') {
      try {
        const data = await adminRoutes.createRelease(normalizedRequest as any, env);
        if ((data as any)?.error) return respond({ success: false, error: data }, 400, origin);
        return respond({ success: true, data }, 200, origin);
      } catch (e:any) { console.error(`[${requestId}] unhandled:`, redact(String(e?.message||e))); return fail('INTERNAL', 'Something went wrong. Please try again.'); }
    }
    if (path.match(/^\/admin\/apps\/[^\/]+$/) && request.method === 'PUT') {
      const data = await adminRoutes.updateApp(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: data }, 400, origin);
      return respond({ success: true, data }, 200, origin);
    }
    if (path.match(/^\/admin\/apps\/[^\/]+$/) && request.method === 'DELETE') {
      const data = await adminRoutes.deleteApp(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: data }, 400, origin);
      return respond({ success: true, data }, 200, origin);
    }
    if (path === '/admin/apps' && request.method === 'POST') {
      const data = await adminRoutes.createApp(normalizedRequest as any, env);
      if ((data as any)?.error) return respond({ success: false, error: data }, 400, origin);
      return respond({ success: true, data }, 200, origin);
    }
    // Upload logo/screenshot to R2 — returns URL
    if (path === '/admin/upload' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ')) return respond({ success:false, error:{ message:'Unauthorized' }},401,origin);
      try {
        const form = await normalizedRequest.formData();
        const file: any = form.get('file');
        const kind = (form.get('kind') as string) || 'icons';
        const slug = (form.get('slug') as string) || 'general';
        if (!file || typeof file.arrayBuffer !== 'function') return respond({ success:false, error:{ message:'No file' }},400,origin);
        const buf = await file.arrayBuffer();
        const ext = (file.name || 'png').split('.').pop() || 'png';
        const key = `assets/${kind}/${slug}-${Date.now()}.${ext}`;
        await env.STORAGE.put(key, buf, { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
        // Return Worker-proxied URL (works without public R2 domain)
        const url = `${new URL(request.url).origin}/r2/${key}`;
        return respond({ success:true, data:{ url, key }},200,origin);
      } catch (e:any) { console.error(`[${requestId}] error:`, redact(String(e?.message||e))); return fail('INTERNAL', 'Something went wrong. Please try again.'); }
    }
    // Serve R2 files via Worker (for private bucket)
    if (path.startsWith('/r2/') && request.method === 'GET') {
      try {
        const key = decodeURIComponent(path.slice(4)); // remove /r2/
        const obj: any = await env.STORAGE.get(key);
        if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders(origin) });
        // Content-Type: stored metadata first, extension fallback (case-insensitive).
        // NOTE: never set Content-Length manually on a streamed body — Workers rejects it.
        const ext = (key.split('.').pop() || '').toLowerCase();
        const types: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
          svg: 'image/svg+xml', ico: 'image/x-icon', zip: 'application/zip', pdf: 'application/pdf',
          json: 'application/json', txt: 'text/plain; charset=utf-8',
          exe: 'application/vnd.microsoft.portable-executable', msi: 'application/x-msi',
          deb: 'application/vnd.debian.binary-package', appimage: 'application/x-appimage', flatpak: 'application/vnd.flatpak',
          apk: 'application/vnd.android.package-archive', ipa: 'application/octet-stream', dmg: 'application/x-apple-diskimage',
        };
        const stored = obj.httpMetadata?.contentType || '';
        const ct = stored && stored !== 'application/octet-stream' ? stored : (types[ext] || stored || 'application/octet-stream');
        const headers = new Headers(corsHeaders(origin));
        headers.set('Content-Type', ct);
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        headers.set('ETag', obj.httpEtag || obj.etag || '');
        return new Response(obj.body, { headers });
      } catch (e: any) {
        console.error(`[${requestId}] r2 serve failed:`, redact(String(e?.message || e)));
        return fail('INTERNAL', 'The file could not be served. Please try again.');
      }
    }
    // Download — record and return URL (packages of the latest PUBLISHED release win, legacy app_versions fallback)
    if (path.match(/^\/apps\/[^\/]+\/download$/) && request.method === 'GET') {
      try {
        const slug = path.split('/')[2];
        let platform = (new URL(request.url).searchParams.get('platform') || 'web').toLowerCase();
        if (platform === 'deb') platform = 'linux_deb';
        if (platform === 'appimage') platform = 'linux_appimage';
        const app: any = await env.DB.prepare('SELECT id, name, current_version, website FROM applications WHERE slug=?').bind(slug).first();
        if (!app) return fail('NOT_FOUND', 'Application not found');
        // Live admin toggles: downloads + maintenance
        if (await getSetting(env, 'downloads_open', '1') === '0') return respond({ success:false, error:{ code:'DOWNLOADS_CLOSED', message:'Downloads are temporarily disabled by the administrator.' }},503,origin);
        if (!await isAdminRequest(request, env) && await getSetting(env, 'maintenance_mode', '0') === '1') return respond({ success:false, error:{ code:'MAINTENANCE', message:'RX Store is under maintenance. Please check back soon.' }},503,origin);
        const originUrl = new URL(request.url).origin;

        // 1. PWA apps: web/pwa/ios open the deployment URL, not a file
        const pkgPwa: any = await env.DB.prepare(`SELECT deployment_url, package_type FROM packages WHERE application_id=? AND platform IN ('web','pwa') AND status='published' ORDER BY created_at DESC LIMIT 1`).bind(app.id).first().catch(()=>null);
        if (platform === 'web' || platform === 'pwa' || platform === 'ios') {
          const deploymentUrl = pkgPwa?.deployment_url || (/^https:\/\//i.test(app.website || '') ? app.website : '');
          if (deploymentUrl) return respond({ success:true, data:{ url: deploymentUrl, isPWA: true, deploymentUrl, version: app.current_version, platform }},200,origin);
        }

        // 2. Canonical path: select the package from a PUBLISHED release using
        //    platform + architecture + channel. Unpublished releases are excluded
        //    by the query AND re-checked below. Selection is deterministic and
        //    never silently returns an incompatible package.
        const reqArch = new URL(request.url).searchParams.get('arch') || new URL(request.url).searchParams.get('architecture') || 'x64';
        const reqChannel = normalizeChannel(new URL(request.url).searchParams.get('channel')) || defaultChannel(null);
        // Only admins may request a non-stable channel.
        const channel = reqChannel === 'stable' ? 'stable' : ((await isAdminRequest(request, env)) ? reqChannel : 'stable');

        const pkgRows: any = await env.DB.prepare(
          `SELECT p.*, r.version AS release_version, r.channel AS release_channel, r.status AS release_status,
                  r.release_notes AS release_notes, r.published_at AS release_published_at
           FROM packages p
           JOIN releases r ON r.id = p.release_id
           WHERE p.application_id = ? AND r.status = 'published' AND r.channel = ?
                 AND p.status = 'published' AND (p.deleted_at IS NULL)
           ORDER BY r.published_at DESC`
        ).bind(app.id, channel).all().catch(() => ({ results: [] }));

        const candidates = (pkgRows.results || []).filter((p: any) => p.release_status === 'published');
        const { selected, reason } = selectPackage(candidates, { platform, architecture: reqArch });
        if (selected) {
          const pkg = selected.pkg;
          const isPwa = pkg.package_type === 'pwa' || (!pkg.storage_key && !!pkg.deployment_url);
          let notes: string[] = [];
          try { const n = JSON.parse(pkg.release_notes || '[]'); notes = Array.isArray(n) ? n : [String(n)]; } catch {}
          const manifest = buildManifest({
            pkg, matchedPlatform: selected.matchedPlatform, matchedArchitecture: selected.matchedArchitecture,
            app: { id: app.id, slug, name: app.name },
            channel, releaseNotes: notes, publishedAt: pkg.release_published_at, origin: originUrl,
          });
          if (!isPwa) {
            // Record the download for the authenticated user (never as an
            // installation). user_id is derived from the token, never from the
            // client body — a download record is NOT an installation record.
            let dlUser: string | null = null;
            try { const t = (request.headers.get('Authorization') || '').replace(/^Bearer /, ''); if (t) dlUser = (await verifyAccessToken(t, env.JWT_SECRET))?.userId || null; } catch {}
            try {
              await env.DB.prepare('INSERT INTO downloads (id, user_id, app_id, platform, version, created_at) VALUES (?,?,?,?,?,datetime(\'now\'))')
                .bind(`dl_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, dlUser, app.id, manifest.platform, manifest.version).run();
              await env.DB.prepare('UPDATE applications SET download_count = download_count + 1 WHERE id=?').bind(app.id).run();
            } catch {}
          }
          return respond({ success: true, data: {
            url: manifest.url, checksum: manifest.sha256, size: manifest.size, fileName: manifest.filename,
            version: manifest.version, platform: manifest.platform, architecture: manifest.architecture,
            channel: manifest.channel, releaseNotes: manifest.releaseNotes,
            minOsVersion: manifest.minOsVersion, minAndroidSdk: manifest.minAndroidSdk,
            isPWA: isPwa || undefined,
            manifest,
          }}, 200, origin);
        }
        // No compatible published package. Fall through to the legacy
        // app_versions compatibility path only for non-specific platforms.
        if (reason && candidates.length > 0 && platform !== 'web' && platform !== 'pwa') {
          // A package family exists but nothing matches the architecture: be honest.
          return respond({ success: false, error: { code: 'NO_COMPATIBLE_PACKAGE', message: reason } }, 404, origin);
        }

        // 3. Legacy app_versions.files (kept in sync on publish; supports old rows too)
        const ver: any = await env.DB.prepare('SELECT files FROM app_versions WHERE app_id=? ORDER BY created_at DESC LIMIT 1').bind(app.id).first().catch(()=>null);
        let url = `${originUrl}/r2/apps/${slug}/${app.current_version}/${platform}/download`;
        let checksum: any = null;
        if (ver?.files) {
          try {
            const files = JSON.parse(ver.files);
            const f = files[platform] || files[platform === 'linux' ? 'linux_deb' : platform] || files.generic || Object.values(files)[0] as any;
            if (f?.fileUrl || f?.url) {
              let candidate = f.fileUrl || f.url;
              if (candidate.includes('..r2.dev')) {
                const key = candidate.split('/assets/').pop() || candidate.split('/apps/').pop();
                if (key) candidate = `${originUrl}/r2/${key.includes('assets/') ? 'assets/' : 'apps/'}${key}`;
              }
              if (candidate.startsWith('assets/') || candidate.startsWith('apps/') || candidate.startsWith('r2://')) {
                const clean = candidate.replace(/^r2:\/\//,'');
                candidate = `${originUrl}/r2/${clean}`;
              }
              url = candidate;
            }
            if (f?.checksum) checksum = f.checksum;
          } catch {}
        }
        try {
          let dlUser: string | null = null;
          try { const t=(request.headers.get('Authorization')||'').replace(/^Bearer /,''); if(t) dlUser=(await verifyAccessToken(t,env.JWT_SECRET))?.userId||null; } catch {}
          await env.DB.prepare("INSERT INTO downloads (id, app_id, user_id, platform, version, created_at) VALUES (?,?,?,?,?, datetime('now'))").bind(`dl_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, app.id, dlUser, platform, app.current_version).run();
          await env.DB.prepare('UPDATE applications SET download_count = download_count + 1 WHERE id=?').bind(app.id).run();
        } catch {}
        return respond({ success:true, data:{ url, checksum, version: app.current_version, platform }},200,origin);
      } catch (e:any) { console.error(`[${requestId}] error:`, redact(String(e?.message||e))); return fail('INTERNAL', 'Something went wrong. Please try again.'); }
    }

    if (path.startsWith('/ai/') || path === '/ai') {
      // Live admin toggle: AI can be switched off from Admin → Settings
      if ((path === '/ai/chat' || path === '/ai/chat/stream' || path === '/ai/recommend') && request.method === 'POST') {
        if (await getSetting(env, 'ai_enabled', '1') === '0') {
          return respond({ success: false, error: { code: 'AI_DISABLED', message: 'The AI assistant is currently disabled by the administrator.' } }, 503, origin);
        }
      }
      if (path === '/ai/providers' && request.method === 'GET') {
        const data = await aiRoutes.providers(normalizedRequest as any, env);
        return respond({ success: true, data }, 200, origin);
      }
      if (path === '/ai/chat' && request.method === 'POST') {
        const data = await aiRoutes.chat(normalizedRequest as any, env);
        if ((data as any)?.error) return respond({ success: false, error: data }, 400, origin);
        return respond({ success: true, data }, 200, origin);
      }
      // Streaming chat — SSE passthrough for fast perceived response
      if (path === '/ai/chat/stream' && request.method === 'POST') {
        const res = await aiRoutes.chatStream(normalizedRequest as any, env);
        return withCors(res, origin, env, requestId);
      }
      if (path === '/ai/recommend' && request.method === 'POST') {
        const data = await aiRoutes.recommend(normalizedRequest as any, env);
        return respond({ success: true, data }, 200, origin);
      }
    }

    if (path === '/apps' && request.method === 'GET') {
      // Live admin toggle: maintenance mode hides the catalog from non-admins
      if (!await isAdminRequest(request, env) && await getSetting(env, 'maintenance_mode', '0') === '1') {
        return respond({ success: false, error: { code: 'MAINTENANCE', message: 'RX Store is under maintenance. Please check back soon.' } }, 503, origin);
      }
      try {
        const data = await appsRoutes.list(normalizedRequest as any, env);
        if ((data as any)?.error) return respond({ success: false, error: data }, 400, origin);
        return respond({ success: true, data }, 200, origin);
      } catch (e: any) { console.error(`[${requestId}] error:`, redact(String(e?.message||e))); return fail('INTERNAL', 'Something went wrong. Please try again.'); }
    }
    if (path === '/categories' && request.method === 'GET') {
      const cats = [
        { id: 'healthcare', name: 'Healthcare', icon: 'Heart', description: 'Clinical tools', count: 3, color: '#FF6B6B' },
        { id: 'education', name: 'Education', icon: 'GraduationCap', description: 'Learning platforms', count: 2, color: '#4ECDC4' },
        { id: 'productivity', name: 'Productivity', icon: 'Zap', description: 'Workflow tools', count: 2, color: '#45B7D1' },
        { id: 'technology', name: 'Technology', icon: 'Cpu', description: 'Developer tools', count: 2, color: '#96CEB4' },
        { id: 'gaming', name: 'Gaming', icon: 'Gamepad2', description: 'Educational games', count: 1, color: '#FFEAA7' },
        { id: 'social', name: 'Social', icon: 'Users', description: 'Community', count: 1, color: '#DDA0DD' },
      ];
      return respond({ success: true, data: cats }, 200, origin);
    }
    if (path.startsWith('/apps/') && (request.method === 'GET' || request.method === 'POST')) {
      try {
        if (path.endsWith('/reviews')) {
          const data = await appsRoutes.reviews(normalizedRequest as any, env);
          if ((data as any)?.error) return respond({ success: false, error: { code: 'ERROR', message: String((data as any).error) } }, 400, origin);
          return respond({ success: true, data }, 200, origin);
        }
        if (request.method === 'GET') {
          const data = await appsRoutes.detail(normalizedRequest as any, env);
          if ((data as any)?.error) return respond({ success: false, error: data }, 404, origin);
          return respond({ success: true, data }, 200, origin);
        }
      } catch (e: any) { console.error(`[${requestId}] error:`, redact(String(e?.message||e))); return fail('INTERNAL', 'Something went wrong. Please try again.'); }
    }
    if (path.startsWith('/auth/') && request.method === 'POST') {
      const seg = path.split('/')[2];
      // Map an auth-route result code to the standardized error shape + status.
      const authCodes: Record<string, ErrorCode> = {
        VALIDATION_ERROR: 'VALIDATION_ERROR', CONFLICT: 'CONFLICT', UNAUTHORIZED: 'AUTH_REQUIRED',
        FORBIDDEN: 'FORBIDDEN', NOT_FOUND: 'NOT_FOUND', TOKEN_EXPIRED: 'TOKEN_EXPIRED',
        INVALID_TOKEN: 'INVALID_TOKEN',
      };
      const finish = (d: any) => {
        if (d?.code || d?.error) {
          const code = authCodes[d.code] || 'VALIDATION_ERROR';
          return fail(code, String(d.message || d.error || 'Request failed'));
        }
        return respond({ success: true, data: d }, 200, origin);
      };
      try {
        if (seg === 'register') return finish(await authRoutes.register(normalizedRequest as any, env));
        if (seg === 'login') return finish(await authRoutes.login(normalizedRequest as any, env));
        if (seg === 'refresh') return finish(await authRoutes.refresh(normalizedRequest as any, env));
        if (seg === 'logout') {
          // Attach the authenticated identity when a valid access token is present
          // so "sign out all devices" can be authorized.
          const authHdr = request.headers.get('Authorization') || '';
          if (authHdr.startsWith('Bearer ')) {
            try { (normalizedRequest as any).user = await verifyAccessToken(authHdr.slice(7), env.JWT_SECRET); } catch { /* anonymous logout is fine */ }
          }
          return finish(await authRoutes.logout(normalizedRequest as any, env));
        }
        if (seg === 'forgot-password') return finish(await authRoutes.forgotPassword(normalizedRequest as any, env));
        if (seg === 'reset-password') return finish(await authRoutes.resetPassword(normalizedRequest as any, env));
      } catch (e: any) {
        console.error(`[${requestId}] auth error:`, redact(String(e?.message || e)));
        return fail('INTERNAL', 'Something went wrong. Please try again.');
      }
    }
    // Notifications — personal feed (stored rows + synthesized "update available" for installed apps)
    if (path === '/notifications' && request.method === 'GET') {
      const auth = request.headers.get('Authorization') || '';
      let userId = '';
      try { if (auth.startsWith('Bearer ')) userId = (await verifyAccessToken(auth.slice(7), env.JWT_SECRET))?.userId || ''; } catch {}
      if (!userId) return respond({ success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401, origin);
      try {
        const rows: any = await env.DB.prepare('SELECT id, type, title, message, data, read, created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(userId).all().catch(() => ({ results: [] }));
        const items: any[] = (rows?.results || [])
          .filter((n: any) => !(String(n.id).startsWith('upd_') && !n.title && !n.message)) // upd_ dismissal markers are internal
          .map((n: any) => {
            let data: any = {};
            try { data = JSON.parse(n.data || '{}'); } catch {}
            return { id: n.id, type: n.type, title: n.title, message: n.message, date: (n.created_at || '').slice(0, 10), read: !!n.read, link: data.link || '' };
          });
        const have = new Set(items.map((i) => i.id));
        // Synthesize update-available entries from the user's downloaded apps (id includes version → new per release)
        const mine: any = await env.DB.prepare(
          `SELECT a.id, a.name, a.slug, a.current_version, MAX(d.created_at) as last_dl FROM downloads d JOIN applications a ON a.id = d.app_id WHERE d.user_id=? GROUP BY a.id`
        ).bind(userId).all().catch(() => ({ results: [] }));
        for (const m of mine?.results || []) {
          const vid = `upd_${m.id}_${m.current_version}`;
          if (!m.current_version || have.has(vid)) continue;
          const dismiss: any = await env.DB.prepare('SELECT read FROM notifications WHERE user_id=? AND id=?').bind(userId, vid).first().catch(() => null);
          if (dismiss?.read) continue; // user dismissed this version's notice
          items.unshift({ id: vid, type: 'update', title: `Update available: ${m.name} ${m.current_version}`, message: `A newer version of ${m.name} is ready — open the app page to update.`, date: '', read: false, link: `/app/${m.slug}` });
        }
        return respond({ success: true, data: { notifications: items.slice(0, 50) } }, 200, origin);
      } catch (e: any) { console.error(`[${requestId}] error:`, redact(String(e?.message||e))); return fail('INTERNAL', 'Something went wrong. Please try again.'); }
    }
    if (path === '/notifications/read' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      let userId = '';
      try { if (auth.startsWith('Bearer ')) userId = (await verifyAccessToken(auth.slice(7), env.JWT_SECRET))?.userId || ''; } catch {}
      if (!userId) return respond({ success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401, origin);
      const body: any = await request.json().catch(() => ({}));
      const ids: string[] = Array.isArray(body?.ids) ? body.ids.slice(0, 100) : [];
      for (const id of ids) {
        if (String(id).startsWith('upd_')) {
          // dismissal marker for synthesized update notices
          await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, title, message, data, read) VALUES (?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET read=1`)
            .bind(String(id), userId, 'update', '', '', '{}').run().catch(() => {});
        } else {
          await env.DB.prepare('UPDATE notifications SET read=1 WHERE user_id=? AND id=?').bind(userId, String(id)).run().catch(() => {});
        }
      }
      return respond({ success: true, data: { read: ids.length } }, 200, origin);
    }
    if (path === '/admin/notifications/send' && request.method === 'POST') {
      try {
        const data = await (adminRoutes as any).sendNotification(normalizedRequest as any, env);
        if ((data as any)?.error) return respond({ success: false, error: { code: 'ERROR', message: (data as any).error } }, 400, origin);
        return respond({ success: true, data }, 200, origin);
      } catch (e: any) { console.error(`[${requestId}] error:`, redact(String(e?.message||e))); return fail('INTERNAL', 'Something went wrong. Please try again.'); }
    }

    if (path === '/users/me' && request.method === 'PATCH') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return respond({ success:false, error:{ code:'UNAUTHORIZED', message:'Sign in required' }},401,origin);
      try {
        const payload = await verifyAccessToken(token, env.JWT_SECRET);
        const userId = payload.userId;
        const body: any = await normalizedRequest.json();
        const name = body.name === undefined ? null : String(body.name).trim();
        const email = body.email === undefined ? null : String(body.email).trim().toLowerCase();
        if (name !== null && name.length < 2) return respond({ success:false, error:{ code:'VALIDATION_ERROR', message:'Full name is required' }},400,origin);
        if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return respond({ success:false, error:{ code:'VALIDATION_ERROR', message:'Enter a valid email address' }},400,origin);
        if (email !== null) {
          const duplicate: any = await env.DB.prepare('SELECT id FROM users WHERE email=? AND id!=?').bind(email, userId).first();
          if (duplicate) return respond({ success:false, error:{ code:'CONFLICT', message:'That email is already registered' }},409,origin);
        }
        const preferences = body.preferences === undefined ? null : JSON.stringify(body.preferences || {});
        await env.DB.prepare(`UPDATE users SET name=COALESCE(?,name), email=COALESCE(?,email), preferences=COALESCE(?,preferences), updated_at=datetime('now') WHERE id=?`)
          .bind(name, email, preferences, userId).run();
        const user: any = await env.DB.prepare('SELECT id,name,email,phone,avatar_url,role,preferences,created_at FROM users WHERE id=?').bind(userId).first();
        if (!user) return respond({ success:false, error:{ code:'NOT_FOUND', message:'User not found' }},404,origin);
        let parsedPreferences = {};
        try { parsedPreferences = JSON.parse(user.preferences || '{}'); } catch {}
        return respond({ success:true, data:{ user:{ id:user.id, name:user.name, email:user.email, phone:user.phone, avatar:user.avatar_url||'👤', role:user.role, joinDate:(user.created_at||'').slice(0,10), preferences:parsedPreferences }}},200,origin);
      } catch (e:any) { console.error(`[${requestId}] profile update:`, redact(String(e?.message||e))); return fail('VALIDATION_ERROR', 'Unable to save profile. Please check your details and try again.'); }
    }
    if (path === '/users/me' && request.method === 'GET') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return respond({ success:false, error:{ code:'UNAUTHORIZED', message:'No token' }},401,origin);
      try {
        const payload = await verifyAccessToken(token, env.JWT_SECRET);
        const userId = payload.userId;
        const user: any = await env.DB.prepare('SELECT id, name, email, phone, avatar_url, role, preferences, created_at FROM users WHERE id = ?').bind(userId).first();
        if (!user) return respond({ success:false, error:{ code:'NOT_FOUND', message:'User not found' }},404,origin);
        let preferences = {};
        try { preferences = JSON.parse(user.preferences || '{}'); } catch {}
        return respond({ success:true, data:{ user:{ id:user.id, name:user.name, email:user.email, phone:user.phone, avatar:user.avatar_url||'👤', role:user.role, joinDate:(user.created_at||'').slice(0,10), preferences }}},200,origin);
      } catch (e:any) { return fail('AUTH_REQUIRED', 'Your session is invalid or has expired. Please sign in again.'); }
    }
    // ---- Account-aware device + installation registry (authenticated) ----
    if (path.startsWith('/devices')) {
      const auth = request.headers.get('Authorization') || '';
      let userId = '';
      try { if (auth.startsWith('Bearer ')) userId = (await verifyAccessToken(auth.slice(7), env.JWT_SECRET))?.userId || ''; } catch {}
      if (!userId) return respond({ success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401, origin);
      // Attach the user to the request so the route module can read it directly.
      (normalizedRequest as any).user = { userId };
      try {
        let data: any;
        if (path === '/devices/register' && request.method === 'POST') data = await devicesRoutes.register(normalizedRequest as any, env);
        else if (path === '/devices/heartbeat' && request.method === 'POST') data = await devicesRoutes.heartbeat(normalizedRequest as any, env);
        else if (path === '/devices' && request.method === 'GET') data = await devicesRoutes.listDevices(normalizedRequest as any, env);
        else if (path.match(/^\/devices\/[^\/]+\/revoke$/) && request.method === 'POST') data = await devicesRoutes.revokeDevice(normalizedRequest as any, env);
        else if (path === '/devices/installations' && request.method === 'POST') data = await devicesRoutes.reportInstallation(normalizedRequest as any, env);
        else if (path === '/devices/installations' && request.method === 'GET') data = await devicesRoutes.listInstallations(normalizedRequest as any, env);
        else return respond({ success: false, error: { code: 'NOT_FOUND', message: 'Unknown device route' } }, 404, origin);
        if (data?.error) {
          const code: ErrorCode = data.code === 'UNAUTHORIZED' ? 'AUTH_REQUIRED' : data.code === 'NOT_FOUND' ? 'NOT_FOUND' : data.code === 'FORBIDDEN' ? 'FORBIDDEN' : 'VALIDATION_ERROR';
          return fail(code, String(data.error));
        }
        return respond({ success: true, data }, 200, origin);
      } catch (e: any) {
        console.error(`[${requestId}] device op:`, redact(String(e?.message||e))); return fail('INTERNAL', 'Device operation failed. Please try again.');
      }
    }

    // ---- Payments (DEV/TEST ONLY; fails closed in production) ----
    // The generic router does not dispatch path-mounted sub-routers, so payments
    // are handled explicitly here. No provider is integrated: production returns
    // PAYMENTS_NOT_ENABLED and never grants paid access.
    if (path.startsWith('/payments')) {
      const auth = request.headers.get('Authorization') || '';
      let payUserId = '';
      try { if (auth.startsWith('Bearer ')) payUserId = (await verifyAccessToken(auth.slice(7), env.JWT_SECRET))?.userId || ''; } catch {}
      if (!payUserId) return fail('AUTH_REQUIRED', 'Sign in required');
      (normalizedRequest as any).user = { userId: payUserId };
      try {
        if (path === '/payments/subscribe' && request.method === 'POST') {
          const d: any = await paymentsRoutes.subscribe(normalizedRequest as any, env);
          if (d?.code) {
            const code: ErrorCode = d.code === 'PAYMENTS_NOT_ENABLED' ? 'PAYMENTS_NOT_ENABLED' : d.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR';
            return fail(code, String(d.message || 'Payment could not be started'));
          }
          return respond({ success: true, data: d }, 200, origin);
        }
        if (path === '/payments/history' && request.method === 'GET') {
          const d = await paymentsRoutes.history(normalizedRequest as any, env);
          return respond({ success: true, data: d }, 200, origin);
        }
        return fail('NOT_FOUND', 'Unknown payments route');
      } catch (e: any) {
        console.error(`[${requestId}] payments:`, redact(String(e?.message || e)));
        return fail('INTERNAL', 'Payment request failed. Please try again.');
      }
    }

    if (path === '/health') return respond({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() },200,origin);

    const res = await router.handle(normalizedRequest as any, env);
    return withCors(res, origin, env, requestId);
  },
};

interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  CACHE: KVNamespace;
  JWT_SECRET: string;
  NVIDIA_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  GEMINI_API_KEY?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_FALLBACK?: string;
  AI_BASE_URL_NVIDIA?: string;
  AI_BASE_URL_OPENROUTER?: string;
  AI_BASE_URL_OPENAI?: string;
  AI_BASE_URL_GEMINI?: string;
  PAYSTACK_SECRET_KEY?: string;
}
