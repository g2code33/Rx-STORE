/**
 * RX Store Backend API — Cloudflare Workers entry point
 */
import { Router } from './router';
import { authMiddleware } from './middleware/auth';
import { rateLimiter } from './middleware/rateLimiter';
import { corsMiddleware } from './middleware/cors';

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

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' } });
    }

    // AI routes — multi-provider (handle directly for correct dispatch)
    if (path.startsWith('/ai/') || path === '/ai') {
      // Public list of providers (no auth needed for status)
      if (path === '/ai/providers' && request.method === 'GET') {
        const data = await aiRoutes.providers(request, env);
        return json({ success: true, data });
      }
      // Chat / recommend require auth if JWT present; but allow unauthenticated for marketplace assistant
      if (path === '/ai/chat' && request.method === 'POST') {
        const data = await aiRoutes.chat(request, env);
        if ((data as any)?.error) return json({ success: false, error: data }, 400);
        return json({ success: true, data });
      }
      if (path === '/ai/recommend' && request.method === 'POST') {
        const data = await aiRoutes.recommend(request, env);
        return json({ success: true, data });
      }
      // Admin: update provider/model (and optionally apiKey via admin UI)
      if (path === '/admin/ai/settings' && (request.method === 'PUT' || request.method === 'POST')) {
        // simple admin check — require Authorization header; real check via adminRoutes middleware in future
        const auth = request.headers.get('Authorization') || '';
        if (!auth.startsWith('Bearer ')) return json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } }, 401);
        const data = await aiRoutes.updateSettings(request, env);
        if ((data as any)?.error) return json({ success: false, error: data }, 400);
        return json({ success: true, data });
      }
      if (path === '/ai/providers') return json({ success: false, error: { code: 'NOT_FOUND' } }, 404);
    }
    // Allow /admin/ai/settings via same path without /ai prefix already handled above

    return router.handle(request, env);
  },
};

interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  CACHE: KVNamespace;
  JWT_SECRET: string;
  // AI — multi-provider secrets (all optional, at least one needed for live AI)
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
