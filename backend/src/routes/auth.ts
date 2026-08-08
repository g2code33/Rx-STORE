/**
 * Authentication Routes — D1 compatible, consistent error format
 */
import { hashPassword, verifyPassword, generateToken, generateRefreshToken } from '../services/auth';
import { validateEmail, validatePassword } from '../utils/validation';

export const authRoutes = {
  async register(request: Request, env: any) {
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const { name, email, password } = body || {};
    if (!name || !email || !password) return { code: 'VALIDATION_ERROR', message: 'Name, email and password are required' };
    if (!validateEmail(email)) return { code: 'VALIDATION_ERROR', message: 'Invalid email format' };
    if (!validatePassword(password)) return { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters' };

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) return { code: 'CONFLICT', message: 'Email already registered. Please sign in instead.' };

    const passwordHash = await hashPassword(password);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(id, (name as string).trim(), (email as string).trim().toLowerCase(), passwordHash, 'user').run();

    const token = generateToken({ userId: id, role: 'user' }, env.JWT_SECRET);
    const refreshToken = generateRefreshToken({ userId: id }, env.JWT_SECRET);
    return { user: { id, name: name.trim(), email: email.trim().toLowerCase(), role: 'user', avatar: '👤', joinDate: new Date().toISOString().slice(0,10), downloadedApps: [], subscriptions: [], notifications: [] }, token, refreshToken };
  },

  async login(request: Request, env: any) {
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const { email, password } = body || {};
    if (!email || !password) return { code: 'VALIDATION_ERROR', message: 'Email and password are required' };

    const user: any = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind((email as string).trim().toLowerCase()).first();
    if (!user || !(await verifyPassword(password as string, user.password_hash))) {
      return { code: 'UNAUTHORIZED', message: 'Invalid email or password. Please check and try again.' };
    }
    const token = generateToken({ userId: user.id, role: user.role }, env.JWT_SECRET);
    const refreshToken = generateRefreshToken({ userId: user.id }, env.JWT_SECRET);
    await env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).bind(user.id).run();
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar_url || '👤',
        role: user.role,
        joinDate: (user.created_at || new Date().toISOString()).slice(0,10),
        downloadedApps: [],
        subscriptions: [],
        notifications: [],
      },
      token,
      refreshToken,
    };
  },

  async logout(request: Request, env: any) {
    // Stateless JWT — client discards token. Optionally add to KV blocklist.
    return { success: true, message: 'Logged out' };
  },
};
