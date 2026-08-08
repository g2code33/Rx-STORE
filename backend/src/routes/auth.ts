/**
 * Authentication Routes
 * 
 * POST /auth/register - Register new user
 * POST /auth/login - User login
 * POST /auth/refresh - Refresh token
 * POST /auth/logout - Logout (invalidate token)
 * POST /auth/forgot-password - Password reset request
 * POST /auth/reset-password - Password reset with token
 */
import { hashPassword, verifyPassword, generateToken, generateRefreshToken } from '../services/auth';
import { validateEmail, validatePassword } from '../utils/validation';

export const authRoutes = {
  async register(request: Request, env: any) {
    const { name, email, password } = await request.json();
    
    if (!validateEmail(email)) {
      return { error: 'Invalid email format' };
    }
    if (!validatePassword(password)) {
      return { error: 'Password must be at least 8 characters' };
    }

    // Check if user exists
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) {
      return { error: 'Email already registered' };
    }

    const passwordHash = await hashPassword(password);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
    ).bind(id, name, email, passwordHash, 'user').run();

    const token = generateToken({ userId: id, role: 'user' }, env.JWT_SECRET);
    const refreshToken = generateRefreshToken({ userId: id }, env.JWT_SECRET);

    return {
      user: { id, name, email, role: 'user' },
      token,
      refreshToken,
    };
  },

  async login(request: Request, env: any) {
    const { email, password } = await request.json();
    
    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE email = ?'
    ).bind(email).first();

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return { error: 'Invalid credentials' };
    }

    const token = generateToken({ userId: user.id, role: user.role }, env.JWT_SECRET);
    const refreshToken = generateRefreshToken({ userId: user.id }, env.JWT_SECRET);

    // Update last login
    await env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).bind(user.id).run();

    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      token,
      refreshToken,
    };
  },
};
