/**
 * Authentication Routes — D1 compatible, phone + email, refresh/rotation, reset.
 */
import { hashPassword, verifyPassword, needsRehash, generateToken, generateRefreshToken, verifyRefreshToken } from '../services/auth.ts';
import { validateEmail, validatePassword, PASSWORD_REQUIREMENT, validateId } from '../utils/validation.ts';
import { getSetting } from '../services/settings.ts';
import { createSession, findLiveSession, revokeByToken, revokeAllSessions, ensureSessionTable, touchSession } from '../services/sessions.ts';
import { apiErrorBody } from '../services/errors.ts';
import { sendEmail } from '../services/email.ts';

function normalizePhone(p: any): string | null {
  if (!p) return null;
  const s = String(p).trim().replace(/\s+/g, '');
  if (!/^\+?[0-9]{8,15}$/.test(s)) return null;
  return s;
}

/** Single-use password-reset token hashing (we never store the raw token). */
async function hashResetToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`rx-reset:${token}`));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether we may return a reset token directly to the client (DEV ONLY). */
function resetTokenDebugAllowed(env: any): boolean {
  if (String(env?.ENVIRONMENT || '').toLowerCase() === 'production') return false;
  return String(env?.RESET_TOKEN_DEBUG ?? '1') !== '0';
}

export const authRoutes = {
  async register(request: Request, env: any) {
    if (await getSetting(env, 'allow_registration', '1') === '0') {
      return { code: 'FORBIDDEN', message: 'Registration is currently closed. Please contact support.' };
    }
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const { name, email, phone, password, deviceId } = body || {};
    if (!name || !email || !password) return { code: 'VALIDATION_ERROR', message: 'Name, email and password are required' };
    if (!validateEmail(email)) return { code: 'VALIDATION_ERROR', message: 'Invalid email format' };
    if (!validatePassword(password)) return { code: 'VALIDATION_ERROR', message: PASSWORD_REQUIREMENT };
    const phoneNorm = normalizePhone(phone);
    if (phone && !phoneNorm) return { code: 'VALIDATION_ERROR', message: 'Invalid phone number' };
    if (deviceId && !validateId(deviceId)) return { code: 'VALIDATION_ERROR', message: 'Invalid device identifier' };

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind((email as string).trim().toLowerCase()).first();
    if (existing) return { code: 'CONFLICT', message: 'Email already registered. Please sign in instead.' };
    if (phoneNorm) {
      const existsPhone = await env.DB.prepare('SELECT id FROM users WHERE phone = ?').bind(phoneNorm).first().catch(()=>null);
      if (existsPhone) return { code: 'CONFLICT', message: 'Phone already registered' };
    }

    const passwordHash = await hashPassword(password);
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        `INSERT INTO users (id, name, email, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(id, (name as string).trim().slice(0, 120), (email as string).trim().toLowerCase(), phoneNorm, passwordHash, 'user').run();
    } catch (e: any) {
      if (String(e.message).includes('no column') || String(e.message).includes('has no column')) {
        await env.DB.prepare(
          `INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
        ).bind(id, (name as string).trim().slice(0, 120), (email as string).trim().toLowerCase(), passwordHash, 'user').run();
      } else throw e;
    }

    const token = await generateToken({ userId: id, role: 'user' }, env.JWT_SECRET);
    const refreshToken = await generateRefreshToken();
    // Persistent session: no expiry — ends only on sign-out / revocation.
    await createSession(env, { userId: id, refreshToken, deviceId, userAgent: request.headers.get('User-Agent') || '' }).catch(() => {});
    return { user: { id, name: name.trim(), email: email.trim().toLowerCase(), phone: phoneNorm, role: 'user', avatar: '👤', joinDate: new Date().toISOString().slice(0,10), downloadedApps: [], subscriptions: [], notifications: [] }, token, refreshToken };
  },

  async login(request: Request, env: any) {
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const { email, phone, identifier, password, deviceId } = body || {};
    const idf = (identifier || email || phone || '') as string;
    if (!idf || !password) return { code: 'VALIDATION_ERROR', message: 'Email/phone and password are required' };
    if (deviceId && !validateId(deviceId)) return { code: 'VALIDATION_ERROR', message: 'Invalid device identifier' };

    const normEmail = String(idf).trim().toLowerCase();
    const normPhone = normalizePhone(idf);
    let user: any = null;
    user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(normEmail).first().catch(()=>null);
    if (!user && normPhone) {
      user = await env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(normPhone).first().catch(()=>null);
    }
    if (!user && normPhone) {
      user = await env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(String(idf).trim()).first().catch(()=>null);
    }
    if (!user || !(await verifyPassword(password as string, user.password_hash))) {
      return { code: 'UNAUTHORIZED', message: 'Invalid email/phone or password. Please check and try again.' };
    }

    // Transparently upgrade a legacy (or below-cost) hash on successful login.
    if (needsRehash(user.password_hash)) {
      try {
        const upgraded = await hashPassword(password as string);
        await env.DB.prepare('UPDATE users SET password_hash=?, updated_at=datetime(\'now\') WHERE id=?').bind(upgraded, user.id).run();
      } catch { /* upgrade is best-effort; login still succeeds */ }
    }

    const token = await generateToken({ userId: user.id, role: user.role }, env.JWT_SECRET);
    const refreshToken = await generateRefreshToken();
    // Persistent session: no expiry — ends only on sign-out / revocation.
    await createSession(env, { userId: user.id, refreshToken, deviceId, userAgent: request.headers.get('User-Agent') || '' }).catch(() => {});
    await env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).bind(user.id).run().catch(()=>{});
    return {
      user: {
        id: user.id, name: user.name, email: user.email, phone: user.phone || null,
        avatar: user.avatar_url || '👤', role: user.role,
        joinDate: (user.created_at || new Date().toISOString()).slice(0,10),
        downloadedApps: [], subscriptions: [], notifications: [],
      },
      token, refreshToken,
    };
  },

  /**
   * POST /auth/refresh { refreshToken } → rotate: the presented refresh token is
   * revoked and a brand-new access + refresh pair is issued. Replaying an old
   * refresh token fails (it is already revoked), which is the point of rotation.
   *
   * The server-side session row is THE authority — this accepts both current
   * opaque tokens and legacy 30-day JWT refresh tokens (both are matched by
   * hash), and migrates any live legacy session to the persistent model:
   * the replacement session has no expiry and keeps the original device +
   * user-agent association. A legacy JWT whose signature/expiry no longer
   * verifies but whose session row is still live still refreshes (the DB
   * record decides); a revoked or genuinely expired session does not.
   */
  async refresh(request: Request, env: any) {
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const refreshToken = String(body?.refreshToken || '');
    if (!refreshToken) return { code: 'VALIDATION_ERROR', message: 'refreshToken is required' };

    // 1. The live session row decides. Works for opaque AND legacy JWT tokens.
    const session = await findLiveSession(env, refreshToken);
    if (!session) {
      // 2. Diagnostics only: for a legacy JWT we can say precisely WHY it is
      //    dead (expired vs signed-out vs malformed). The outcome was already
      //    decided above — no session, no refresh.
      try {
        await verifyRefreshToken(refreshToken, env.JWT_SECRET);
        return { code: 'INVALID_TOKEN', message: 'This session was signed out or has expired.' };
      } catch (e: any) {
        const code = String(e?.message || '');
        return { code: code === 'EXPIRED' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', message: code === 'EXPIRED' ? 'Session expired. Please sign in again.' : 'Invalid refresh token.' };
      }
    }

    // The session row (not any client-supplied claim) identifies the account.
    const user: any = await env.DB.prepare('SELECT id, role, name, email, phone, avatar_url, created_at FROM users WHERE id=?').bind(session.user_id).first().catch(()=>null);
    if (!user) return { code: 'INVALID_TOKEN', message: 'Invalid refresh token.' };

    // Rotate: revoke the old session, issue a new token pair + session. The
    // replacement preserves the original device + user-agent and is persistent
    // (no expiry) — so a legacy 30-day session is migrated on its first refresh.
    await revokeByToken(env, refreshToken).catch(() => {});
    const token = await generateToken({ userId: user.id, role: user.role }, env.JWT_SECRET);
    const newRefresh = await generateRefreshToken();
    await createSession(env, {
      userId: user.id,
      refreshToken: newRefresh,
      deviceId: session.device_id || undefined,
      userAgent: session.user_agent || request.headers.get('User-Agent') || '',
    }).catch(() => {});
    await touchSession(env, session.id).catch(() => {});

    return {
      token,
      refreshToken: newRefresh,
      user: {
        id: user.id, name: user.name, email: user.email, phone: user.phone || null,
        avatar: user.avatar_url || '👤', role: user.role,
        joinDate: (user.created_at || new Date().toISOString()).slice(0,10),
        downloadedApps: [], subscriptions: [], notifications: [],
      },
    };
  },

  /**
   * POST /auth/logout { refreshToken?, allDevices? } → revoke the current
   * session, or ALL sessions when allDevices is true. This only ends sessions;
   * it never touches application installations.
   */
  async logout(request: Request, env: any) {
    await ensureSessionTable(env);
    let body: any = {};
    try { body = await request.json(); } catch { /* body optional */ }
    const refreshToken = String(body?.refreshToken || '');
    const allDevices = body?.allDevices === true;

    // Prefer the authenticated identity (set by the auth middleware) when
    // available. The access token may legitimately have EXPIRED by the time the
    // user presses "Sign out all devices" — in that case resolve the account
    // from the presented refresh credential's live session instead, so
    // "all devices" still revokes every session and not just the current one.
    let authedUserId = (request as any)?.user?.userId as string | undefined;
    if (!authedUserId && refreshToken) {
      const session = await findLiveSession(env, refreshToken).catch(() => null);
      if (session) authedUserId = session.user_id;
    }

    if (allDevices && authedUserId) {
      const n = await revokeAllSessions(env, authedUserId);
      return { success: true, message: `Signed out of ${n} session(s).`, revoked: n };
    }
    if (refreshToken) {
      const revoked = await revokeByToken(env, refreshToken);
      return { success: true, message: revoked ? 'Signed out.' : 'Session already ended.', revoked: revoked ? 1 : 0 };
    }
    if (authedUserId) {
      const n = await revokeAllSessions(env, authedUserId);
      return { success: true, message: `Signed out of ${n} session(s).`, revoked: n };
    }
    return { success: true, message: 'Signed out.' };
  },

  async forgotPassword(request: Request, env: any) {
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const { email } = body || {};
    if (!email || !validateEmail(email)) return { code: 'VALIDATION_ERROR', message: 'Valid email is required' };

    const isProduction = String(env?.ENVIRONMENT || '').toLowerCase() === 'production';
    // TRUTHFUL states (§ production gate 9) — the API never implies an email
    // was sent when email delivery is not configured, and NEVER returns the
    // reset token in production.
    const emailConfigured = !!(env?.RESEND_API_KEY && env?.FROM_EMAIL);
    const unconfigured = {
      success: true,
      delivery: 'unconfigured',
      message: 'Password reset emails are not configured on this deployment. Contact support to reset your password.',
    };
    if (!emailConfigured && isProduction) return unconfigured;

    const generic = { success: true, delivery: 'sent', message: 'If that email is registered, a reset link has been sent.' };
    const user: any = await env.DB.prepare('SELECT id, name FROM users WHERE email = ?').bind(String(email).trim().toLowerCase()).first().catch(() => null);
    if (!user) return generic; // never leak whether an account exists

    // Single-use, short-lived, stored HASHED (never the raw token).
    const rawToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const tokenHash = await hashResetToken(rawToken);
    const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes
    try {
      await env.DB.prepare(`UPDATE users SET reset_token=?, reset_token_expiry=?, updated_at=datetime('now') WHERE id=?`)
        .bind(tokenHash, expiry, user.id).run();
    } catch { return generic; }

    // Production + configured email → actually SEND the recovery email through
    // the existing provider boundary (services/email.ts). The raw token only
    // ever travels inside that email — never in an API response.
    if (isProduction) {
      const webBase = String(env?.RX_STORE_WEB_URL || 'https://rx-store-web.pages.dev').replace(/\/+$/, '');
      const link = `${webBase}/login?reset=${rawToken}`;
      const sent = await sendEmail(env, {
        to: String(email).trim().toLowerCase(),
        subject: 'Reset your RX Store password',
        html: `<p>Hello ${String(user.name || 'there').replace(/[<>&]/g, '')},</p>
               <p>Someone requested a password reset for your RX Store account. This link expires in 30 minutes:</p>
               <p><a href="${link}">Reset my password</a></p>
               <p>If you did not request this, you can ignore this email — your password stays unchanged.</p>`,
      });
      // Delivery result is reported honestly without leaking internals.
      return sent.ok ? generic : { success: true, delivery: 'failed', message: 'The reset email could not be sent right now. Please try again shortly or contact support.' };
    }

    // Non-production: the debug token keeps the flow testable locally.
    if (resetTokenDebugAllowed(env)) {
      return { ...generic, delivery: 'debug', resetToken: rawToken, devNote: 'DEV ONLY: resetToken is returned because ENVIRONMENT is not production.' };
    }
    return generic;
  },

  async resetPassword(request: Request, env: any) {
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const { token, password } = body || {};
    if (!token || !password) return { code: 'VALIDATION_ERROR', message: 'Token and new password are required' };
    if (!validatePassword(password)) return { code: 'VALIDATION_ERROR', message: PASSWORD_REQUIREMENT };

    const tokenHash = await hashResetToken(String(token));
    let user: any = null;
    // Look up by hash (current format) with a legacy fallback for rows written
    // before hashing was introduced (those expire within 30 min).
    user = await env.DB.prepare('SELECT * FROM users WHERE reset_token = ?').bind(tokenHash).first().catch(() => null);
    if (!user) user = await env.DB.prepare('SELECT * FROM users WHERE reset_token = ?').bind(String(token)).first().catch(() => null);
    if (!user) return { code: 'NOT_FOUND', message: 'Invalid or expired reset token' };
    if (user.reset_token_expiry && new Date(user.reset_token_expiry).getTime() < Date.now()) {
      return { code: 'TOKEN_EXPIRED', message: 'Reset token expired. Please request a new one.' };
    }

    const hash = await hashPassword(password);
    await env.DB.prepare(`UPDATE users SET password_hash=?, reset_token=NULL, reset_token_expiry=NULL, updated_at=datetime('now') WHERE id=?`).bind(hash, user.id).run();
    // A password change invalidates all existing sessions.
    await revokeAllSessions(env, user.id).catch(() => {});
    return { success: true, message: 'Password reset successfully. Please sign in.' };
  },
};
