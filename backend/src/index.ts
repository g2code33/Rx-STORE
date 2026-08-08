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
import { updatesRoutes } from './routes/updates';

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

function json(data: any, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// Decode the JWT payload and require the admin role (same decode pattern as /users/me)
function isAdminRequest(request: Request): boolean {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1] || ''));
    return payload?.role === 'admin';
  } catch {
    return false;
  }
}

function withCors(res: Response, origin: string): Response {
  const headers = new Headers(res.headers);
  const cors = corsHeaders(origin);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
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

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Every /admin/* endpoint requires a valid admin JWT (production hardening —
    // previously PUT/DELETE apps, releases, uploads etc. were open to any request)
    if (path.startsWith('/admin')) {
      if (!isAdminRequest(request)) return json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
    }

    if ((path === '/updates/check' || path === '/update/check' || path === '/api/updates/check' || path === '/api/update/check') && request.method === 'GET') {
      const data = await updatesRoutes.checkUpdate(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: { code: 'NOT_FOUND', message: (data as any).error } }, 404, origin);
      return json({ success: true, data }, 200, origin);
    }

    if (path === '/admin/ai/settings' && (request.method === 'PUT' || request.method === 'POST')) {
      if (!isAdminRequest(request)) return json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      const data = await aiRoutes.updateSettings(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: data }, 400, origin);
      return json({ success: true, data }, 200, origin);
    }
    // Admin: read full AI settings (unmasked keys) to pre-fill the Admin UI
    if (path === '/admin/ai/settings' && request.method === 'GET') {
      if (!isAdminRequest(request)) return json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      const data = await aiRoutes.getSettings(normalizedRequest as any, env);
      return json({ success: true, data }, 200, origin);
    }
    // Admin: test a provider key (typed in the form or stored) against the real provider
    if (path === '/admin/ai/test' && request.method === 'POST') {
      if (!isAdminRequest(request)) return json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      const data = await aiRoutes.test(normalizedRequest as any, env);
      if ((data as any)?.error && !(data as any)?.ok) return json({ success: false, error: data }, 400, origin);
      return json({ success: true, data }, 200, origin);
    }
    if (path === '/admin/users' && request.method === 'GET') {
      const data = await adminRoutes.listUsers(normalizedRequest as any, env);
      return json({ success: true, data }, 200, origin);
    }
    if (path.match(/^\/admin\/users\/[^\/]+\/role$/) && request.method === 'PATCH') {
      const data = await adminRoutes.updateUserRole(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: data }, 400, origin);
      return json({ success: true, data }, 200, origin);
    }
    if (path === '/admin/revenue' && request.method === 'GET') {
      const data = await adminRoutes.revenue(normalizedRequest as any, env);
      return json({ success: true, data }, 200, origin);
    }
    if (path === '/admin/dashboard' && request.method === 'GET') {
      const data = await adminRoutes.dashboard(normalizedRequest as any, env);
      return json({ success: true, data }, 200, origin);
    }
    // New Release Management
    if (path === '/admin/releases' && request.method === 'POST') {
      const data = await (adminRoutes as any).createNewRelease(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: { code: 'ERROR', message: (data as any).error } }, 400, origin);
      return json({ success: true, data }, 200, origin);
    }
    if (path === '/admin/releases' && request.method === 'GET') {
      const data = await (adminRoutes as any).listReleases(normalizedRequest as any, env);
      return json({ success: true, data }, 200, origin);
    }
    if (path.match(/^\/admin\/releases\/[^\/]+$/) && request.method === 'GET') {
      const data = await (adminRoutes as any).getRelease(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: data }, 404, origin);
      return json({ success: true, data }, 200, origin);
    }
    if (path.match(/^\/admin\/releases\/[^\/]+\/publish$/) && request.method === 'POST') {
      const data = await (adminRoutes as any).publishRelease(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: { code: 'ERROR', message: (data as any).error } }, 400, origin);
      return json({ success: true, data }, 200, origin);
    }
    // Package upload for a release: stores to R2 + sha256 + packages row, keeps releases in sync
    if (path.match(/^\/admin\/releases\/[^\/]+\/upload$/) && request.method === 'POST') {
      if (!isAdminRequest(request)) return json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      try {
        const data = await (adminRoutes as any).uploadPackage(normalizedRequest as any, env);
        if ((data as any)?.error) return json({ success: false, error: { code: 'ERROR', message: (data as any).error } }, 400, origin);
        return json({ success: true, data }, 200, origin);
      } catch (e: any) { return json({ success: false, error: { message: e.message } }, 500, origin); }
    }
    // Chunked upload for big installers: start → part×N → complete (R2 multipart)
    if (path.match(/^\/admin\/releases\/[^\/]+\/upload\/(start|part|complete|abort)$/) && request.method === 'POST') {
      if (!isAdminRequest(request)) return json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      const step = path.split('/').pop() as string;
      const fn = { start: 'uploadPackageStart', part: 'uploadPackagePart', complete: 'uploadPackageComplete', abort: 'uploadPackageAbort' }[step] as string;
      try {
        const data = await (adminRoutes as any)[fn](normalizedRequest as any, env);
        if ((data as any)?.error) return json({ success: false, error: { code: 'ERROR', message: (data as any).error } }, 400, origin);
        return json({ success: true, data }, 200, origin);
      } catch (e: any) { return json({ success: false, error: { message: e.message } }, 500, origin); }
    }
    if (path.match(/^\/admin\/releases\/[^\/]+\/rollback$/) && request.method === 'POST') {
      const data = await (adminRoutes as any).rollbackRelease(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: { code: 'ERROR', message: (data as any).error } }, 400, origin);
      return json({ success: true, data }, 200, origin);
    }
    // Recycle Bin — list soft-deleted items and restore them
    if (path === '/admin/recycle' && request.method === 'GET') {
      const data = await adminRoutes.listDeleted(normalizedRequest as any, env);
      return json({ success: true, data }, 200, origin);
    }
    if (path.match(/^\/admin\/apps\/[^\/]+\/restore$/) && request.method === 'POST') {
      const data = await adminRoutes.restoreApp(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: data }, 400, origin);
      return json({ success: true, data }, 200, origin);
    }
    if (path === '/admin/reset-stats' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ')) return json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      const data = await adminRoutes.resetStats(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: { code: 'FORBIDDEN', message: (data as any).error } }, 403, origin);
      return json({ success: true, data }, 200, origin);
    }
    if (path === '/admin/apps/reset' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ')) return json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      const data = await (adminRoutes as any).resetApps(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: { code: 'FORBIDDEN', message: (data as any).error } }, 403, origin);
      return json({ success: true, data }, 200, origin);
    }
    if (path.match(/^\/admin\/apps\/[^\/]+\/releases$/) && request.method === 'POST') {
      try {
        const data = await adminRoutes.createRelease(normalizedRequest as any, env);
        if ((data as any)?.error) return json({ success: false, error: data }, 400, origin);
        return json({ success: true, data }, 200, origin);
      } catch (e:any) { return json({ success: false, error: { message: e.message, stack: e.stack } }, 500, origin); }
    }
    if (path.match(/^\/admin\/apps\/[^\/]+$/) && request.method === 'PUT') {
      const data = await adminRoutes.updateApp(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: data }, 400, origin);
      return json({ success: true, data }, 200, origin);
    }
    if (path.match(/^\/admin\/apps\/[^\/]+$/) && request.method === 'DELETE') {
      const data = await adminRoutes.deleteApp(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: data }, 400, origin);
      return json({ success: true, data }, 200, origin);
    }
    if (path === '/admin/apps' && request.method === 'POST') {
      const data = await adminRoutes.createApp(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: data }, 400, origin);
      return json({ success: true, data }, 200, origin);
    }
    // Upload logo/screenshot to R2 — returns URL
    if (path === '/admin/upload' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ')) return json({ success:false, error:{ message:'Unauthorized' }},401,origin);
      try {
        const form = await normalizedRequest.formData();
        const file: any = form.get('file');
        const kind = (form.get('kind') as string) || 'icons';
        const slug = (form.get('slug') as string) || 'general';
        if (!file || typeof file.arrayBuffer !== 'function') return json({ success:false, error:{ message:'No file' }},400,origin);
        const buf = await file.arrayBuffer();
        const ext = (file.name || 'png').split('.').pop() || 'png';
        const key = `assets/${kind}/${slug}-${Date.now()}.${ext}`;
        await env.STORAGE.put(key, buf, { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
        // Return Worker-proxied URL (works without public R2 domain)
        const url = `${new URL(request.url).origin}/r2/${key}`;
        return json({ success:true, data:{ url, key }},200,origin);
      } catch (e:any) { return json({ success:false, error:{ message:e.message }},500,origin); }
    }
    // Serve R2 files via Worker (for private bucket)
    if (path.startsWith('/r2/') && request.method === 'GET') {
      const key = path.slice(4); // remove /r2/
      const obj: any = await env.STORAGE.get(key);
      if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders(origin) });
      const headers = new Headers();
      headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
      headers.set('Content-Length', String(obj.size));
      headers.set('Cache-Control', 'public, max-age=31536000');
      for (const [k,v] of Object.entries(corsHeaders(origin))) headers.set(k,v);
      return new Response(obj.body, { headers });
    }
    // Download — record and return URL (packages of the latest PUBLISHED release win, legacy app_versions fallback)
    if (path.match(/^\/apps\/[^\/]+\/download$/) && request.method === 'GET') {
      try {
        const slug = path.split('/')[2];
        let platform = (new URL(request.url).searchParams.get('platform') || 'web').toLowerCase();
        if (platform === 'deb') platform = 'linux_deb';
        if (platform === 'appimage') platform = 'linux_appimage';
        const app: any = await env.DB.prepare('SELECT id, current_version FROM applications WHERE slug=?').bind(slug).first();
        if (!app) return json({ success:false, error:{ message:'App not found' }},404,origin);
        const originUrl = new URL(request.url).origin;

        // 1. PWA apps: web/pwa/ios open the deployment URL, not a file
        const pkgPwa: any = await env.DB.prepare(`SELECT deployment_url, package_type FROM packages WHERE application_id=? AND platform IN ('web','pwa') AND status='published' ORDER BY created_at DESC LIMIT 1`).bind(app.id).first().catch(()=>null);
        if ((platform === 'web' || platform === 'pwa' || platform === 'ios') && pkgPwa?.deployment_url) {
          return json({ success:true, data:{ url: pkgPwa.deployment_url, isPWA: true, deploymentUrl: pkgPwa.deployment_url, version: app.current_version, platform }},200,origin);
        }

        // 2. Package from the latest PUBLISHED release (uploads ↔ releases ↔ install pipeline)
        //    'linux' requests match linux_deb packages (alias used by old upload UI)
        const plats = platform === 'linux' ? ['linux','linux_deb','linux_appimage'] : [platform];
        const pkg: any = await env.DB.prepare(
          `SELECT p.storage_key, p.sha256, p.file_size, p.filename, p.deployment_url, p.package_type, p.version FROM packages p
           JOIN releases r ON r.id = p.release_id AND r.status = 'published'
           WHERE p.application_id=? AND p.status='published' AND p.platform IN (${plats.map(()=>'?').join(',')})
           ORDER BY r.published_at DESC LIMIT 1`
        ).bind(app.id, ...plats).first().catch(()=>null);
        if (pkg?.storage_key && pkg?.package_type !== 'pwa') {
          try { await env.DB.prepare('INSERT INTO downloads (id, app_id, platform, version, created_at) VALUES (?,?,?,?,datetime(\'now\'))').bind(`dl_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, app.id, platform, pkg.version || app.current_version).run(); await env.DB.prepare('UPDATE applications SET download_count = download_count + 1 WHERE id=?').bind(app.id).run(); } catch {}
          return json({ success:true, data:{ url: `${originUrl}/r2/${pkg.storage_key}`, checksum: pkg.sha256, size: pkg.file_size, fileName: pkg.filename, version: pkg.version || app.current_version, platform }},200,origin);
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
        try { await env.DB.prepare('INSERT INTO downloads (id, app_id, platform, version, created_at) VALUES (?,?,?, ?, datetime(\'now\'))').bind(`dl_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, app.id, platform, app.current_version).run(); await env.DB.prepare('UPDATE applications SET download_count = download_count + 1 WHERE id=?').bind(app.id).run(); } catch {}
        return json({ success:true, data:{ url, checksum, version: app.current_version, platform }},200,origin);
      } catch (e:any) { return json({ success:false, error:{ message:e.message }},500,origin); }
    }

    if (path.startsWith('/ai/') || path === '/ai') {
      if (path === '/ai/providers' && request.method === 'GET') {
        const data = await aiRoutes.providers(normalizedRequest as any, env);
        return json({ success: true, data }, 200, origin);
      }
      if (path === '/ai/chat' && request.method === 'POST') {
        const data = await aiRoutes.chat(normalizedRequest as any, env);
        if ((data as any)?.error) return json({ success: false, error: data }, 400, origin);
        return json({ success: true, data }, 200, origin);
      }
      // Streaming chat — SSE passthrough for fast perceived response
      if (path === '/ai/chat/stream' && request.method === 'POST') {
        const res = await aiRoutes.chatStream(normalizedRequest as any, env);
        return withCors(res, origin);
      }
      if (path === '/ai/recommend' && request.method === 'POST') {
        const data = await aiRoutes.recommend(normalizedRequest as any, env);
        return json({ success: true, data }, 200, origin);
      }
    }

    if (path === '/apps' && request.method === 'GET') {
      try {
        const data = await appsRoutes.list(normalizedRequest as any, env);
        if ((data as any)?.error) return json({ success: false, error: data }, 400, origin);
        return json({ success: true, data }, 200, origin);
      } catch (e: any) { return json({ success: false, error: { message: e.message } }, 500, origin); }
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
      return json({ success: true, data: cats }, 200, origin);
    }
    if (path.startsWith('/apps/') && (request.method === 'GET' || request.method === 'POST')) {
      try {
        if (path.endsWith('/reviews')) {
          const data = await appsRoutes.reviews(normalizedRequest as any, env);
          if ((data as any)?.error) return json({ success: false, error: data }, 400, origin);
          return json({ success: true, data }, 200, origin);
        }
        if (request.method === 'GET') {
          const data = await appsRoutes.detail(normalizedRequest as any, env);
          if ((data as any)?.error) return json({ success: false, error: data }, 404, origin);
          return json({ success: true, data }, 200, origin);
        }
      } catch (e: any) { return json({ success: false, error: { message: e.message } }, 500, origin); }
    }
    if (path.startsWith('/auth/') && request.method === 'POST') {
      const seg = path.split('/')[2];
      if (seg === 'register') { const d: any = await authRoutes.register(normalizedRequest as any, env); if (d.code || d.error) return json({ success:false, error:{ code: d.code || 'ERROR', message: d.message || d.error } }, d.code==='CONFLICT'?409:400,origin); return json({ success:true, data:d },200,origin); }
      if (seg === 'login') { const d: any = await authRoutes.login(normalizedRequest as any, env); if (d.code || d.error) return json({ success:false, error:{ code: d.code || 'ERROR', message: d.message || d.error } }, d.code==='UNAUTHORIZED'?401:400,origin); return json({ success:true, data:d },200,origin); }
      if (seg === 'logout') { const d: any = await authRoutes.logout(normalizedRequest as any, env); return json({ success:true, data:d },200,origin); }
      if (seg === 'forgot-password') { const d: any = await authRoutes.forgotPassword(normalizedRequest as any, env); if (d.code || d.error) return json({ success:false, error:{ code: d.code || 'ERROR', message: d.message || d.error } },400,origin); return json({ success:true, data:d },200,origin); }
      if (seg === 'reset-password') { const d: any = await authRoutes.resetPassword(normalizedRequest as any, env); if (d.code || d.error) return json({ success:false, error:{ code: d.code || 'ERROR', message: d.message || d.error } },400,origin); return json({ success:true, data:d },200,origin); }
    }
    if (path === '/users/me' && request.method === 'GET') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return json({ success:false, error:{ code:'UNAUTHORIZED', message:'No token' }},401,origin);
      try {
        const payload = JSON.parse(atob(token.split('.')[1] || ''));
        const userId = payload.userId;
        const user: any = await env.DB.prepare('SELECT id, name, email, avatar_url, role, created_at FROM users WHERE id = ?').bind(userId).first();
        if (!user) return json({ success:false, error:{ code:'NOT_FOUND', message:'User not found' }},404,origin);
        return json({ success:true, data:{ user:{ id:user.id, name:user.name, email:user.email, avatar:user.avatar_url||'👤', role:user.role, joinDate:(user.created_at||'').slice(0,10) }}},200,origin);
      } catch (e:any) { return json({ success:false, error:{ message:e.message }},401,origin); }
    }
    if (path === '/health') return json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() },200,origin);

    const res = await router.handle(normalizedRequest as any, env);
    return withCors(res, origin);
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
