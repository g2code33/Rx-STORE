/**
 * OAuth Routes — Google + GitHub as SECONDARY authentication methods.
 *
 * Everything resolves to the NORMAL RX Store session machinery (JWT access
 * token + opaque persistent refresh credential + auth_sessions row from
 * services/sessions.ts). No separate session architecture exists.
 *
 * Endpoints (dispatched inline from index.ts):
 *   GET  /auth/oauth/providers            public: which providers are configured
 *   GET  /auth/oauth/:provider[/start]    start the flow (302 to the provider)
 *   GET  /auth/oauth/:provider/callback   provider callback (302 to the web app)
 *   POST /auth/oauth/complete             exchange the one-time completion code
 *                                         for a normal session (login response)
 *   POST /auth/oauth/link-start           (auth) start CONNECTING a provider
 *   POST /auth/oauth/link/confirm         confirm linking to an existing
 *                                         account with its PASSWORD (Phase 5)
 *   POST /auth/oauth/pairing-code         (auth) issue a one-time sign-in code
 *                                         for another device/shell
 *   GET  /auth/methods                    (auth) connected authentication methods
 *   POST /auth/oauth/:provider/disconnect (auth) remove a linked provider
 *   POST /auth/set-password               (auth) set an RX Store password for a
 *                                         social-only account
 *
 * Flow (web): SPA → /auth/oauth/google?redirect=/profile → provider → callback
 * → 302 {WEB}/oauth/callback?code=<one-time>&status=<state> → SPA POSTs the
 * code to /auth/oauth/complete → normal login response persisted by the
 * existing client. The redirect target is a SAFE IN-APP PATH only (never a
 * URL, never client-controlled origins — no open redirect).
 */
import { verifyAccessToken, generateToken, generateRefreshToken } from '../services/auth.ts';
import { verifyPassword, hashPassword } from '../services/password.ts';
import { validatePassword, PASSWORD_REQUIREMENT, validateId } from '../utils/validation.ts';
import { createSession } from '../services/sessions.ts';
import { getSetting } from '../services/settings.ts';
import {
  isOAuthProvider, providerConfigured, providerConfig, OAUTH_PROVIDERS,
  issueOneTimeToken, consumeOneTimeToken, restoreOneTimeToken,
  webCallbackBase, apiCallbackBase, safeInAppRedirect,
  googleAuthorizeUrl, exchangeGoogleCode, githubAuthorizeUrl, exchangeGithubCode,
  findIdentity, linkIdentity, unlinkIdentity, listIdentitiesForUser, touchIdentityLogin,
  createSocialUser, isPlaceholderEmail,
} from '../services/oauth.ts';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function sessionResponse(env: any, request: Request, user: any, opts?: { deviceId?: string | null }): Promise<any> {
  const token = await generateToken({ userId: user.id, role: user.role }, env.JWT_SECRET);
  const refreshToken = await generateRefreshToken();
  await createSession(env, {
    userId: user.id, refreshToken,
    deviceId: opts?.deviceId || undefined,
    userAgent: request.headers.get('User-Agent') || '',
  }).catch(() => {});
  return {
    user: {
      id: user.id, name: user.name, email: isPlaceholderEmail(user.email) ? null : user.email, phone: user.phone || null,
      avatar: user.avatar_url || '👤', role: user.role,
      joinDate: (user.created_at || new Date().toISOString()).slice(0, 10),
      downloadedApps: [], subscriptions: [], notifications: [],
    },
    token, refreshToken,
  };
}

/** Resolve the authenticated user from the Bearer token (existing middleware pattern). */
async function authUser(request: Request, env: any): Promise<any | null> {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const payload = await verifyAccessToken(auth.slice(7), env.JWT_SECRET);
    const user: any = await env.DB.prepare('SELECT id, name, email, phone, password_hash, avatar_url, role, created_at, last_login_at FROM users WHERE id=?').bind(payload.userId).first().catch(() => null);
    return user || null;
  } catch {
    return null;
  }
}

/** Hash for the PKCE code challenge (S256). */
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64urlBytes(new Uint8Array(digest));
}
function b64urlBytes(bytes: Uint8Array): string {
  let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function redirectResponse(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'no-store' } });
}

/** Friendly callback status codes — never raw provider payloads (Phase 16). */
type CallbackStatus =
  | 'login' | 'new' | 'linked' | 'already_linked'
  | 'link_required' | 'cancelled' | 'error';

function callbackRedirect(env: any, status: CallbackStatus, params: Record<string, string> = {}): Response {
  const q = new URLSearchParams({ status, ...params });
  return redirectResponse(`${webCallbackBase(env)}/oauth/callback?${q.toString()}`);
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------

export const oauthRoutes = {
  /** GET /auth/oauth/providers — public booleans only (no client ids needed). */
  async providers(request: Request, env: any) {
    const configured: Record<string, boolean> = {};
    for (const p of OAUTH_PROVIDERS) configured[p] = providerConfigured(env, p);
    return configured;
  },

  /** GET /auth/oauth/:provider[/start]?redirect=/path[&intent=<token>][&deviceId=<id>] */
  async start(request: Request, env: any, provider: string): Promise<Response | { code: string; message: string }> {
    if (!isOAuthProvider(provider)) return { code: 'NOT_FOUND', message: 'Unknown sign-in provider.' };
    if (!providerConfigured(env, provider)) {
      return { code: 'NOT_IMPLEMENTED', message: `${provider === 'google' ? 'Google' : 'GitHub'} sign-in is not configured on this deployment.` };
    }
    const cfg = providerConfig(env, provider);
    const url = new URL(request.url);
    const redirect = safeInAppRedirect(url.searchParams.get('redirect')) || '/';
    const intentRaw = url.searchParams.get('intent');
    const deviceId = url.searchParams.get('deviceId');
    if (deviceId && !validateId(deviceId)) return { code: 'VALIDATION_ERROR', message: 'Invalid device identifier.' };

    let mode: 'login' | 'link' = 'login';
    let intentUserId: string | null = null;
    if (intentRaw) {
      const intent = await consumeOneTimeToken(env, 'intent', intentRaw);
      if (!intent || !intent.userId || intent.provider !== provider) {
        return { code: 'INVALID_TOKEN', message: 'This connect link has expired. Please try again.' };
      }
      mode = 'link';
      intentUserId = String(intent.userId);
    }

    // State (single-use, 10 min) binds the whole attempt — provider, mode,
    // redirect target, device, and (for Google) the PKCE verifier + nonce.
    const stateFields: Record<string, unknown> = { provider, mode, redirect, deviceId: deviceId || null, ...(mode === 'link' ? { userId: intentUserId } : {}) };
    if (provider === 'google') {
      stateFields.codeVerifier = b64urlBytes(crypto.getRandomValues(new Uint8Array(32)));
      stateFields.nonce = b64urlBytes(crypto.getRandomValues(new Uint8Array(16)));
    }
    const state = await issueOneTimeToken(env, 'state', stateFields);
    const redirectUri = `${apiCallbackBase(env, request)}/auth/oauth/${provider}/callback`;

    if (provider === 'google') {
      return redirectResponse(googleAuthorizeUrl({
        clientId: cfg.clientId!, redirectUri, state,
        nonce: String(stateFields.nonce),
        codeChallenge: await pkceChallenge(String(stateFields.codeVerifier)),
      }));
    }
    return redirectResponse(githubAuthorizeUrl({ clientId: cfg.clientId!, redirectUri, state }));
  },

  /** GET /auth/oauth/:provider/callback?code=…&state=… (or ?error=access_denied) */
  async callback(request: Request, env: any, provider: string): Promise<Response> {
    if (!isOAuthProvider(provider)) return callbackRedirect(env, 'error', { reason: 'unknown_provider' });
    const url = new URL(request.url);

    // User cancelled at the provider — friendly state, nothing consumed beyond the state.
    if (url.searchParams.get('error')) {
      return callbackRedirect(env, 'cancelled');
    }
    const code = url.searchParams.get('code') || '';
    const stateRaw = url.searchParams.get('state') || '';
    if (!code || !stateRaw) return callbackRedirect(env, 'error', { reason: 'invalid_callback' });

    // Single-use, short-lived state (atomic consume → replay impossible).
    const state = await consumeOneTimeToken(env, 'state', stateRaw);
    if (!state || state.provider !== provider) return callbackRedirect(env, 'error', { reason: 'invalid_state' });

    const redirectUri = `${apiCallbackBase(env, request)}/auth/oauth/${provider}/callback`;
    const safeRedirectPath = safeInAppRedirect(state.redirect) || '/';

    // ---- obtain + VALIDATE the provider identity (never trust the frontend) ----
    let subject: string, email: string | null, emailVerified: boolean, name: string | null, avatar: string | null;
    if (provider === 'google') {
      const identity = await exchangeGoogleCode(env, {
        code, redirectUri,
        codeVerifier: String(state.codeVerifier || ''),
        expectedNonce: String(state.nonce || ''),
      });
      if ('error' in identity) return callbackRedirect(env, 'error', { reason: 'provider_validation' });
      ({ sub: subject, email, emailVerified, name, picture: avatar } = identity);
    } else {
      const identity = await exchangeGithubCode(env, { code, redirectUri });
      if ('error' in identity) return callbackRedirect(env, 'error', { reason: 'provider_validation' });
      subject = identity.id;
      // GitHub: only a PRIMARY+VERIFIED email is ever used → verified iff present.
      email = identity.email;
      emailVerified = !!identity.email;
      name = identity.name;
      avatar = identity.avatarUrl;
    }

    // ---- MODE: link (authenticated connect from Account Security) ----
    if (state.mode === 'link' && state.userId) {
      const user: any = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(String(state.userId)).first().catch(() => null);
      if (!user) return callbackRedirect(env, 'error', { reason: 'account_missing' });
      const existing = await findIdentity(env, provider, subject);
      if (existing && existing.user_id === user.id) return callbackRedirect(env, 'already_linked');
      if (existing) return callbackRedirect(env, 'error', { reason: 'provider_linked_elsewhere' });
      await linkIdentity(env, { userId: user.id, provider, subject, email, emailVerified, name, avatarUrl: avatar });
      return callbackRedirect(env, 'linked');
    }

    // ---- MODE: login ----
    const identity = await findIdentity(env, provider, subject);
    if (identity) {
      // Existing link → log straight into THAT account (subject is the key).
      const user: any = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(identity.user_id).first().catch(() => null);
      if (!user) return callbackRedirect(env, 'error', { reason: 'account_missing' });
      await touchIdentityLogin(env, user.id, provider);
      await env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).bind(user.id).run().catch(() => {});
      const completion = await issueOneTimeToken(env, 'code', { userId: user.id, redirect: safeRedirectPath, status: 'login' });
      return callbackRedirect(env, 'login', { code: completion });
    }

    // New identity + a VERIFIED provider email matching an existing account:
    // NEVER auto-merge — require explicit password-authenticated linking.
    if (email && emailVerified) {
      const existingUser: any = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first().catch(() => null);
      if (existingUser) {
        const linkToken = await issueOneTimeToken(env, 'link', { provider, subject, email, emailVerified, name, avatarUrl: avatar, redirect: safeRedirectPath });
        return redirectResponse(`${webCallbackBase(env)}/oauth/link?token=${encodeURIComponent(linkToken)}`);
      }
    }

    // Fresh user (Phase 6). Respect the registration setting.
    if (await getSetting(env, 'allow_registration', '1') === '0') {
      return callbackRedirect(env, 'error', { reason: 'registration_closed' });
    }
    const userId = await createSocialUser(env, { provider, subject, email, emailVerified, name, avatarUrl: avatar });
    const completion = await issueOneTimeToken(env, 'code', { userId, redirect: safeRedirectPath, status: 'new' });
    return callbackRedirect(env, 'new', { code: completion });
  },

  /** POST /auth/oauth/complete {code} → the normal login response (session). */
  async complete(request: Request, env: any) {
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const raw = String(body?.code || '');
    if (!raw) return { code: 'VALIDATION_ERROR', message: 'code is required' };
    const deviceId = String(body?.deviceId || '');
    if (deviceId && !validateId(deviceId)) return { code: 'VALIDATION_ERROR', message: 'Invalid device identifier.' };
    const payload = await consumeOneTimeToken(env, 'code', raw);
    if (!payload?.userId) return { code: 'INVALID_TOKEN', message: 'This sign-in code is invalid or has expired.' };
    const user: any = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(String(payload.userId)).first().catch(() => null);
    if (!user) return { code: 'INVALID_TOKEN', message: 'This sign-in code is invalid or has expired.' };
    await env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).bind(user.id).run().catch(() => {});
    const data = await sessionResponse(env, request, user, { deviceId: deviceId || null });
    return { ...data, status: payload.status || 'login', redirect: safeInAppRedirect(payload.redirect) || '/' };
  },

  /** POST /auth/oauth/link-start {provider} (auth) → {url} to redirect to. */
  async linkStart(request: Request, env: any) {
    const user = await authUser(request, env);
    if (!user) return { code: 'UNAUTHORIZED', message: 'Sign in required.' };
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const provider = String(body?.provider || '');
    if (!isOAuthProvider(provider)) return { code: 'VALIDATION_ERROR', message: 'Unknown provider.' };
    if (!providerConfigured(env, provider)) return { code: 'NOT_IMPLEMENTED', message: `${provider === 'google' ? 'Google' : 'GitHub'} sign-in is not configured on this deployment.` };
    const already = (await listIdentitiesForUser(env, user.id)).some((i) => i.provider === provider);
    if (already) return { code: 'CONFLICT', message: `${provider === 'google' ? 'Google' : 'GitHub'} is already connected to your account.` };
    const intent = await issueOneTimeToken(env, 'intent', { userId: user.id, provider });
    const base = apiCallbackBase(env, request);
    return { url: `${base}/auth/oauth/${provider}/start?intent=${encodeURIComponent(intent)}` };
  },

  /**
   * POST /auth/oauth/link/confirm {token, password} — the SAFE linking flow
   * (Phase 5): the provider identity is new, but an account exists with the
   * same verified email. The user proves ownership of that account with its
   * PASSWORD; only then is the identity attached and a session issued.
   */
  async linkConfirm(request: Request, env: any) {
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const token = String(body?.token || '');
    const password = String(body?.password || '');
    const deviceId = String(body?.deviceId || '');
    if (!token || !password) return { code: 'VALIDATION_ERROR', message: 'token and password are required' };
    if (deviceId && !validateId(deviceId)) return { code: 'VALIDATION_ERROR', message: 'Invalid device identifier.' };
    const payload = await consumeOneTimeToken(env, 'link', token, { allowRetry: true });
    if (!payload) return { code: 'INVALID_TOKEN', message: 'This linking request has expired. Please start again.' };
    const user: any = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(String(payload.email || '')).first().catch(() => null);
    if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
      // Wrong password: keep the token usable so a typo does not restart OAuth.
      await restoreOneTimeToken(env, token);
      return { code: 'UNAUTHORIZED', message: 'Incorrect password for the existing account.' };
    }
    // Password proven → attach the provider identity to THIS account.
    const ok = await linkIdentity(env, {
      userId: user.id, provider: payload.provider, subject: String(payload.subject),
      email: payload.email || null, emailVerified: !!payload.emailVerified,
      name: payload.name || null, avatarUrl: payload.avatarUrl || null,
    });
    if (!ok) return { code: 'CONFLICT', message: 'This provider account is already connected to another RX Store account.' };
    await env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).bind(user.id).run().catch(() => {});
    const data = await sessionResponse(env, request, user, { deviceId: deviceId || null });
    return { ...data, status: 'linked', redirect: safeInAppRedirect(payload.redirect) || '/' };
  },

  /** POST /auth/oauth/pairing-code (auth) → one-time code for another device/shell. */
  async pairingCode(request: Request, env: any) {
    const user = await authUser(request, env);
    if (!user) return { code: 'UNAUTHORIZED', message: 'Sign in required.' };
    const raw = await issueOneTimeToken(env, 'code', { userId: user.id, redirect: '/', status: 'login' });
    return { code: raw, expiresInMinutes: 10 };
  },

  /** GET /auth/methods (auth) → connected authentication methods. */
  async methods(request: Request, env: any) {
    const user = await authUser(request, env);
    if (!user) return { code: 'UNAUTHORIZED', message: 'Sign in required.' };
    const identities = await listIdentitiesForUser(env, user.id);
    const hasPassword = !!user.password_hash && user.password_hash !== '';
    const providerRow = (p: string) => identities.find((i) => i.provider === p) || null;
    const connectedCount = identities.length + (hasPassword ? 1 : 0);
    return {
      password: { connected: hasPassword, lastUsedAt: user.last_login_at || null },
      google: methodRow(providerRow('google'), connectedCount),
      github: methodRow(providerRow('github'), connectedCount),
    };
  },

  /** POST /auth/oauth/:provider/disconnect (auth) — never the last usable method. */
  async disconnect(request: Request, env: any, provider: string) {
    if (!isOAuthProvider(provider)) return { code: 'VALIDATION_ERROR', message: 'Unknown provider.' };
    const user = await authUser(request, env);
    if (!user) return { code: 'UNAUTHORIZED', message: 'Sign in required.' };
    const hasPassword = !!user.password_hash && user.password_hash !== '';
    const identities = await listIdentitiesForUser(env, user.id);
    const hasThis = identities.some((i) => i.provider === provider);
    if (!hasThis) return { code: 'NOT_FOUND', message: 'This provider is not connected to your account.' };
    // Security rule (Phase 8): never remove the FINAL usable method.
    const remaining = identities.length - 1 + (hasPassword ? 1 : 0);
    if (remaining < 1) {
      return { code: 'FORBIDDEN', message: hasPassword
        ? 'You cannot disconnect your only sign-in method. Set a password first.'
        : 'This is your only way of signing in. Set an RX Store password first (Account → Security), then disconnect.' };
    }
    await unlinkIdentity(env, user.id, provider);
    return { success: true, disconnected: provider };
  },

  /** POST /auth/set-password {password} (auth) — for social-only accounts. */
  async setPassword(request: Request, env: any) {
    const user = await authUser(request, env);
    if (!user) return { code: 'UNAUTHORIZED', message: 'Sign in required.' };
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const password = String(body?.password || '');
    if (!validatePassword(password)) return { code: 'VALIDATION_ERROR', message: PASSWORD_REQUIREMENT };
    const hasPassword = !!user.password_hash && user.password_hash !== '';
    if (hasPassword) {
      return { code: 'CONFLICT', message: 'This account already has a password. Use "Forgot password" to change it.' };
    }
    const hash = await hashPassword(password);
    await env.DB.prepare(`UPDATE users SET password_hash=?, updated_at=datetime('now') WHERE id=?`).bind(hash, user.id).run();
    return { success: true, message: 'Password set. You can now sign in with email and password too.' };
  },
};

function methodRow(row: any, connectedCount: number) {
  return {
    connected: !!row,
    linkedAt: row?.created_at || null,
    lastUsedAt: row?.last_login_at || null,
    canDisconnect: !!row && connectedCount > 1,
  };
}
