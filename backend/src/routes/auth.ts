/**
 * Authentication Routes — D1 compatible, phone + email + forgot via email
 */
import { hashPassword, verifyPassword, generateToken, generateRefreshToken } from '../services/auth';
import { validateEmail, validatePassword } from '../utils/validation';
import { getSetting } from '../services/settings';

function normalizePhone(p: any): string | null {
  if (!p) return null;
  const s = String(p).trim().replace(/\s+/g, '');
  // allow +233..., 0..., or plain digits
  if (!/^\+?[0-9]{8,15}$/.test(s)) return null;
  return s;
}

export const authRoutes = {
  async register(request: Request, env: any) {
    // Live admin toggle: registration can be closed from Admin → Settings
    if (await getSetting(env, 'allow_registration', '1') === '0') {
      return { code: 'FORBIDDEN', message: 'Registration is currently closed. Please contact support.' };
    }
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const { name, email, phone, password } = body || {};
    if (!name || !email || !password) return { code: 'VALIDATION_ERROR', message: 'Name, email and password are required' };
    if (!validateEmail(email)) return { code: 'VALIDATION_ERROR', message: 'Invalid email format' };
    if (!validatePassword(password)) return { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters' };
    const phoneNorm = normalizePhone(phone);
    if (phone && !phoneNorm) return { code: 'VALIDATION_ERROR', message: 'Invalid phone number' };

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind((email as string).trim().toLowerCase()).first();
    if (existing) return { code: 'CONFLICT', message: 'Email already registered. Please sign in instead.' };
    if (phoneNorm) {
      const existsPhone = await env.DB.prepare('SELECT id FROM users WHERE phone = ?').bind(phoneNorm).first().catch(()=>null);
      if (existsPhone) return { code: 'CONFLICT', message: 'Phone already registered' };
    }

    const passwordHash = await hashPassword(password);
    const id = crypto.randomUUID();
    // Insert with phone if column exists; fallback without phone if migration not yet run
    try {
      await env.DB.prepare(
        `INSERT INTO users (id, name, email, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(id, (name as string).trim(), (email as string).trim().toLowerCase(), phoneNorm, passwordHash, 'user').run();
    } catch (e: any) {
      // column phone may not exist yet (existing DB without migration) — fallback
      if (String(e.message).includes('no column') || String(e.message).includes('has no column')) {
        await env.DB.prepare(
          `INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
        ).bind(id, (name as string).trim(), (email as string).trim().toLowerCase(), passwordHash, 'user').run();
      } else throw e;
    }

    const token = await generateToken({ userId: id, role: 'user' }, env.JWT_SECRET);
    const refreshToken = await generateRefreshToken({ userId: id }, env.JWT_SECRET);
    return { user: { id, name: name.trim(), email: email.trim().toLowerCase(), phone: phoneNorm, role: 'user', avatar: '👤', joinDate: new Date().toISOString().slice(0,10), downloadedApps: [], subscriptions: [], notifications: [] }, token, refreshToken };
  },

  async login(request: Request, env: any) {
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const { email, phone, identifier, password } = body || {};
    const idf = (identifier || email || phone || '') as string;
    if (!idf || !password) return { code: 'VALIDATION_ERROR', message: 'Email/phone and password are required' };

    const normEmail = String(idf).trim().toLowerCase();
    const normPhone = normalizePhone(idf);
    let user: any = null;
    // Try email first, then phone
    user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(normEmail).first().catch(()=>null);
    if (!user && normPhone) {
      user = await env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(normPhone).first().catch(()=>null);
    }
    // Also try raw identifier as phone without email lower
    if (!user && normPhone) {
      user = await env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(String(idf).trim()).first().catch(()=>null);
    }
    if (!user || !(await verifyPassword(password as string, user.password_hash))) {
      return { code: 'UNAUTHORIZED', message: 'Invalid email/phone or password. Please check and try again.' };
    }
    const token = await generateToken({ userId: user.id, role: user.role }, env.JWT_SECRET);
    const refreshToken = await generateRefreshToken({ userId: user.id }, env.JWT_SECRET);
    await env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).bind(user.id).run().catch(()=>{});
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone || null,
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

  async forgotPassword(request: Request, env: any) {
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const { email } = body || {};
    if (!email || !validateEmail(email)) return { code: 'VALIDATION_ERROR', message: 'Valid email is required' };
    const user: any = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(String(email).trim().toLowerCase()).first();
    if (!user) return { success: true, message: 'If that email exists, a reset link has been sent' }; // don't leak
    const token = crypto.randomUUID();
    const expiry = new Date(Date.now() + 60*60*1000).toISOString(); // 1h
    try {
      await env.DB.prepare(`UPDATE users SET reset_token=?, reset_token_expiry=?, updated_at=datetime('now') WHERE id=?`).bind(token, expiry, user.id).run();
    } catch { /* column may not exist yet */ }
    // In production, send email via service. For now return token for testing (remove in prod)
    return { success: true, message: 'Reset link sent to email', resetToken: token, note: 'In production this is emailed, not returned' };
  },

  async resetPassword(request: Request, env: any) {
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const { token, password, email } = body || {};
    if (!token || !password) return { code: 'VALIDATION_ERROR', message: 'Token and new password are required' };
    if (!validatePassword(password)) return { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters' };
    let user: any = null;
    try {
      user = await env.DB.prepare('SELECT * FROM users WHERE reset_token = ?').bind(token).first();
    } catch { return { code: 'NOT_FOUND', message: 'Reset token not found' }; }
    if (!user) return { code: 'NOT_FOUND', message: 'Invalid or expired reset token' };
    if (user.reset_token_expiry && new Date(user.reset_token_expiry).getTime() < Date.now()) {
      return { code: 'UNAUTHORIZED', message: 'Reset token expired. Please request a new one.' };
    }
    const hash = await hashPassword(password);
    await env.DB.prepare(`UPDATE users SET password_hash=?, reset_token=NULL, reset_token_expiry=NULL, updated_at=datetime('now') WHERE id=?`).bind(hash, user.id).run();
    return { success: true, message: 'Password reset successfully. Please sign in.' };
  },

  async logout(request: Request, env: any) {
    return { success: true, message: 'Logged out' };
  },
};
