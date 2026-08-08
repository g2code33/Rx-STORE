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

    if ((path === '/updates/check' || path === '/update/check' || path === '/api/updates/check' || path === '/api/update/check') && request.method === 'GET') {
      const data = await updatesRoutes.checkUpdate(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: { code: 'NOT_FOUND', message: (data as any).error } }, 404, origin);
      return json({ success: true, data }, 200, origin);
    }

    if (path === '/admin/ai/settings' && (request.method === 'PUT' || request.method === 'POST')) {
      const auth = request.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ')) return json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401, origin);
      const data = await aiRoutes.updateSettings(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: data }, 400, origin);
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
    if (path.match(/^\/admin\/apps\/[^\/]+\/releases$/) && request.method === 'POST') {
      const data = await adminRoutes.createRelease(normalizedRequest as any, env);
      if ((data as any)?.error) return json({ success: false, error: data }, 400, origin);
      return json({ success: true, data }, 200, origin);
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
        // R2 public URL — if bucket is public, else Worker will serve via /assets/...
        const url = `https://rx-store-storage.${env.CLOUDFLARE_ACCOUNT_ID || ''}.r2.dev/${key}`;
        // For now return R2 key as url; frontend can use it via Worker proxy if needed
        return json({ success:true, data:{ url, key }},200,origin);
      } catch (e:any) { return json({ success:false, error:{ message:e.message }},500,origin); }
    }
    // Download — record and return URL (real R2 signed URL when file exists)
    if (path.match(/^\/apps\/[^\/]+\/download$/) && request.method === 'GET') {
      try {
        const slug = path.split('/')[2];
        const platform = new URL(request.url).searchParams.get('platform') || 'web';
        const app: any = await env.DB.prepare('SELECT id, current_version FROM applications WHERE slug=?').bind(slug).first();
        if (!app) return json({ success:false, error:{ message:'App not found' }},404,origin);
        // Try to get version file URL from app_versions
        const ver: any = await env.DB.prepare('SELECT files FROM app_versions WHERE app_id=? ORDER BY created_at DESC LIMIT 1').bind(app.id).first().catch(()=>null);
        let url = `https://rx-store-storage.r2.dev/apps/${slug}/${app.current_version}/${platform}/download`;
        let checksum: any = null;
        if (ver?.files) {
          try { const files = JSON.parse(ver.files); const f = files[platform] || files.generic || Object.values(files)[0]; if (f?.fileUrl) url = f.fileUrl; if (f?.checksum) checksum = f.checksum; } catch {}
        }
        // Record download
        try { await env.DB.prepare('INSERT INTO downloads (id, app_id, platform, version, created_at) VALUES (?,?,?, ?, datetime(\'now\'))').bind(`dl_${Date.now()}`, app.id, platform, app.current_version).run(); await env.DB.prepare('UPDATE applications SET download_count = download_count + 1 WHERE id=?').bind(app.id).run(); } catch {}
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
    if (path.startsWith('/apps/') && request.method === 'GET') {
      try {
        if (path.endsWith('/reviews')) {
          const data = await appsRoutes.reviews(normalizedRequest as any, env);
          return json({ success: true, data }, 200, origin);
        }
        const data = await appsRoutes.detail(normalizedRequest as any, env);
        if ((data as any)?.error) return json({ success: false, error: data }, 404, origin);
        return json({ success: true, data }, 200, origin);
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
