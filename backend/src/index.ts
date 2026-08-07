/**
 * RX Store Backend API
 * 
 * Cloudflare Workers entry point (or Node.js server)
 * Handles all API requests for the RX Store platform.
 * 
 * Architecture:
 * - Authentication & Authorization
 * - Application management
 * - User management
 * - Payment processing
 * - File storage (R2)
 * - AI integration
 */

import { Router } from './router';
import { authMiddleware } from './middleware/auth';
import { rateLimiter } from './middleware/rateLimiter';
import { corsMiddleware } from './middleware/cors';

// Route handlers
import { authRoutes } from './routes/auth';
import { appsRoutes } from './routes/apps';
import { usersRoutes } from './routes/users';
import { paymentsRoutes } from './routes/payments';
import { adminRoutes } from './routes/admin';
import { aiRoutes } from './routes/ai';
import { updatesRoutes } from './routes/updates';

const router = new Router();

// Global middleware
router.use(corsMiddleware);
router.use(rateLimiter);

// Public routes
router.use('/auth', authRoutes);
router.use('/apps', appsRoutes);
router.use('/categories', appsRoutes);
router.use('/updates', updatesRoutes);
router.use('/update', updatesRoutes); // alias per spec: GET /api/update/check

// Protected routes
router.use('/users', authMiddleware, usersRoutes);
router.use('/payments', authMiddleware, paymentsRoutes);
router.use('/ai', authMiddleware, aiRoutes);

// Admin routes
router.use('/admin', authMiddleware, adminRoutes);

// Health check
router.get('/health', () => ({
  status: 'ok',
  version: '1.0.0',
  timestamp: new Date().toISOString(),
}));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return router.handle(request, env);
  },
};

interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  CACHE: KVNamespace;
  JWT_SECRET: string;
  OPENAI_API_KEY: string;
  PAYSTACK_SECRET_KEY: string;
}
