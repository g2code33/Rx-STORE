/**
 * RX Store — OAuth 2.0 secondary authentication service (Google + GitHub).
 *
 * SECONDARY auth on top of the existing email/password system. Every
 * successful OAuth authentication resolves to a NORMAL RX Store user and
 * issues the NORMAL session machinery (JWT access token + opaque refresh
 * credential + persistent auth_sessions row) from services/sessions.ts —
 * there is NO separate session architecture.
 *
 * Identity rules (production gate):
 *   - The provider SUBJECT is the authoritative key (Google `sub`, GitHub
 *     immutable numeric id) — never an email, never a username.
 *   - Email NEVER auto-merges accounts: when a provider identity is new but a
 *     user with the same VERIFIED email exists, the flow hands back a
 *     short-lived LINK TOKEN and the user must authenticate the existing
 *     account (password) before the identity is attached (Phase 5).
 *   - Provider access tokens are never stored — the identity claims are
 *     extracted once and the tokens discarded.
 *
 * One-time tokens (state / completion codes / link tokens / link intents)
 * live in D1 (`oauth_tokens`), hashed, 10-minute TTL, SINGLE-USE enforced
 * atomically (`UPDATE … SET consumed_at WHERE consumed_at IS NULL`), so
 * replay races are impossible (Phase 12).
 */

export type OAuthProvider = 'google' | 'github';
export const OAUTH_PROVIDERS: OAuthProvider[] = ['google', 'github'];

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes — short-lived by design

export function isOAuthProvider(v: unknown): v is OAuthProvider {
  return v === 'google' || v === 'github';
}

/** Provider client credentials (backend-only; never sent to a frontend). */
export function providerConfig(env: any, provider: OAuthProvider): { clientId: string | null; clientSecret: string | null } {
  if (provider === 'google') {
    return { clientId: env?.GOOGLE_CLIENT_ID || null, clientSecret: env?.GOOGLE_CLIENT_SECRET || null };
  }
  return { clientId: env?.GITHUB_CLIENT_ID || null, clientSecret: env?.GITHUB_CLIENT_SECRET || null };
}

export function providerConfigured(env: any, provider: OAuthProvider): boolean {
  const c = providerConfig(env, provider);
  return !!(c.clientId && c.clientSecret);
}

// ---------------------------------------------------------------------------
// One-time tokens (hashed, single-use, atomic consume)
// ---------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(bytes: Uint8Array): string {
  let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function ensureOAuthTables(env: any): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS auth_identities (
       id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       provider TEXT NOT NULL CHECK (provider IN ('google','github')),
       provider_subject TEXT NOT NULL, provider_email TEXT, provider_email_verified INTEGER DEFAULT 0,
       display_name TEXT, avatar_url TEXT, created_at TEXT DEFAULT (datetime('now')),
       updated_at TEXT, last_login_at TEXT, UNIQUE (provider, provider_subject)
     )`
  ).run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id)').run().catch(() => {});
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS oauth_tokens (
       id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('state','code','link','intent')),
       token_hash TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
       created_at TEXT DEFAULT (datetime('now')), expires_at TEXT NOT NULL, consumed_at TEXT
     )`
  ).run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_oauth_tokens_hash ON oauth_tokens(token_hash)').run().catch(() => {});
}

/** Issue a one-time token of the given kind, bound to `payload`. Returns the RAW token (shown once). */
export async function issueOneTimeToken(env: any, kind: 'state' | 'code' | 'link' | 'intent', payload: Record<string, unknown>): Promise<string> {
  await ensureOAuthTables(env);
  // Lazily purge expired rows (keeps the table tiny without a cron).
  await env.DB.prepare(`DELETE FROM oauth_tokens WHERE expires_at < datetime('now')`).run().catch(() => {});
  const raw = `o_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
  const hash = await sha256Hex(raw);
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (id, kind, token_hash, payload, created_at, expires_at) VALUES (?,?,?,?,datetime('now'),?)`
  ).bind(`otk_${crypto.randomUUID()}`, kind, hash, JSON.stringify(payload), new Date(Date.now() + TOKEN_TTL_MS).toISOString()).run();
  return raw;
}

/**
 * Validate + ATOMICALLY CONSUME a one-time token. `opts.allowRetry` keeps the
 * token alive on failure (used by the link-confirm flow so a mistyped password
 * does not force restarting OAuth).
 */
export async function consumeOneTimeToken(env: any, kind: 'state' | 'code' | 'link' | 'intent', raw: string, opts?: { allowRetry?: boolean }): Promise<Record<string, any> | null> {
  await ensureOAuthTables(env);
  const hash = await sha256Hex(String(raw || ''));
  const row: any = await env.DB.prepare(
    `SELECT * FROM oauth_tokens WHERE token_hash=? AND kind=? AND consumed_at IS NULL AND expires_at > datetime('now')`
  ).bind(hash, kind).first().catch(() => null);
  if (!row) return null;
  // Atomic single-use: the UPDATE only succeeds for the first consumer.
  const res: any = await env.DB.prepare(
    `UPDATE oauth_tokens SET consumed_at=datetime('now') WHERE id=? AND consumed_at IS NULL`
  ).bind(row.id).run();
  const consumed = (res?.meta?.changes || 0) > 0;
  if (!consumed) return null;
  if (opts?.allowRetry) {
    // The caller handles validation; on failure it must call restoreOneTimeToken.
  }
  let payload: Record<string, any> = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
  return payload;
}

/** Restore a just-consumed token (link-confirm retry semantics). */
export async function restoreOneTimeToken(env: any, raw: string): Promise<void> {
  const hash = await sha256Hex(String(raw || ''));
  await env.DB.prepare(`UPDATE oauth_tokens SET consumed_at=NULL WHERE token_hash=?`).bind(hash).run().catch(() => {});
}

// ---------------------------------------------------------------------------
// Redirect helpers — exact origins, no open redirects
// ---------------------------------------------------------------------------

/**
 * The RX Store WEB origin the OAuth flow redirects back to. Configuration
 * only (env), NEVER client-supplied. Default: the production Pages domain.
 * Local dev: set OAUTH_WEB_URL (e.g. http://localhost:5173) in .dev.vars.
 */
export function webCallbackBase(env: any): string {
  return String(env?.OAUTH_WEB_URL || env?.RX_STORE_WEB_URL || 'https://rx-store-web.pages.dev').replace(/\/+$/, '');
}

/** The API origin used to build the provider redirect_uri (must EXACTLY match the console registration). */
export function apiCallbackBase(env: any, request: Request): string {
  if (env?.OAUTH_API_BASE) return String(env.OAUTH_API_BASE).replace(/\/+$/, '');
  return new URL(request.url).origin;
}

/**
 * A safe in-app redirect target (the ONLY thing a client may ask to return to
 * after sign-in). Must be a relative path — never a URL, never //, never /\.
 */
export function safeInAppRedirect(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 200) return null;
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return null;
  return v;
}

// ---------------------------------------------------------------------------
// Google OIDC: authorization URL, PKCE, code exchange, id_token verification
// ---------------------------------------------------------------------------

export interface GoogleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export function googleAuthorizeUrl(input: {
  clientId: string; redirectUri: string; state: string; nonce: string; codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: input.state,
    nonce: input.nonce,
    // PKCE (S256): the confidential client additionally binds the code to this attempt.
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'online',   // we do not need refresh tokens — identity only
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Exchange the authorization code + verify the returned id_token (full OIDC validation). */
export async function exchangeGoogleCode(env: any, input: {
  code: string; redirectUri: string; codeVerifier: string; expectedNonce: string;
}): Promise<GoogleIdentity | { error: string }> {
  const { clientId, clientSecret } = providerConfig(env, 'google');
  if (!clientId || !clientSecret) return { error: 'google_not_configured' };
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: input.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const tokenJson: any = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || !tokenJson?.id_token) return { error: `token_exchange_${tokenRes.status}` };

    // FULL id_token validation — signature (JWKS, RS256) + issuer + audience
    // + expiry + nonce. Never trust the token's self-description alone.
    const claims = await verifyGoogleIdToken(env, tokenJson.id_token, clientId, input.expectedNonce);
    if ('error' in claims) return claims;
    return {
      sub: String(claims.sub || ''),
      email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null,
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === 'string' ? claims.name.slice(0, 120) : null,
      picture: typeof claims.picture === 'string' ? claims.picture.slice(0, 500) : null,
    };
  } catch {
    return { error: 'network' };
  }
}

// --- minimal JWT verification (RS256 via Google's JWKS) ---------------------

let jwksCache: { at: number; keys: any[] } | null = null;

async function googleJwks(env: any): Promise<any[]> {
  if (jwksCache && Date.now() - jwksCache.at < 60 * 60 * 1000) return jwksCache.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(15000) });
  const j: any = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(j?.keys)) throw new Error('jwks_unavailable');
  jwksCache = { at: Date.now(), keys: j.keys };
  return j.keys;
}

function decodeJwtPart(part: string): any {
  try {
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)));
  } catch {
    return null;
  }
}

async function verifyGoogleIdToken(env: any, idToken: string, expectedAud: string, expectedNonce: string): Promise<any | { error: string }> {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return { error: 'malformed_id_token' };
  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  if (!header || !payload) return { error: 'malformed_id_token' };
  if (header.alg !== 'RS256') return { error: 'bad_alg' };

  // Signature against Google's published keys.
  let keys: any[];
  try { keys = await googleJwks(env); } catch { return { error: 'jwks_unavailable' }; }
  const jwk = keys.find((k) => k.kid === header.kid && k.use === 'sig' && k.alg === 'RS256');
  if (!jwk) return { error: 'unknown_signing_key' };
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes as unknown as BufferSource, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return { error: 'bad_signature' };
  } catch {
    return { error: 'signature_verification_failed' };
  }

  // Claims: issuer, audience, expiry, nonce.
  const iss = String(payload.iss || '');
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') return { error: 'bad_issuer' };
  if (payload.aud !== expectedAud) return { error: 'bad_audience' };
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { error: 'expired_token' };
  if (typeof payload.iat !== 'number' || payload.iat > now + 300) return { error: 'bad_iat' };
  if (String(payload.nonce || '') !== String(expectedNonce)) return { error: 'bad_nonce' };
  if (!payload.sub || typeof payload.sub !== 'string') return { error: 'missing_sub' };
  return payload;
}

// ---------------------------------------------------------------------------
// GitHub OAuth: authorization URL, code exchange, identity + verified email
// ---------------------------------------------------------------------------

export interface GitHubIdentity {
  id: string;            // immutable numeric user id — the identity key
  login: string | null;  // informational only
  email: string | null;  // PRIMARY + VERIFIED email only (may be absent)
  name: string | null;
  avatarUrl: string | null;
}

export function githubAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: 'read:user user:email',
    state: input.state,
    // Note: classic GitHub OAuth apps do not document PKCE; the confidential
    // client (server-side secret exchange) + single-use state carries the CSRF
    // and code-injection defence here.
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeGithubCode(env: any, input: { code: string; redirectUri: string }): Promise<GitHubIdentity | { error: string }> {
  const { clientId, clientSecret } = providerConfig(env, 'github');
  if (!clientId || !clientSecret) return { error: 'github_not_configured' };
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: input.code, redirect_uri: input.redirectUri }),
      signal: AbortSignal.timeout(15000),
    });
    const tokenJson: any = await tokenRes.json().catch(() => null);
    const accessToken = tokenJson?.access_token;
    if (!tokenRes.ok || !accessToken) return { error: `token_exchange_${tokenRes.status}` };
    // The provider access token is used for these two calls ONLY, then discarded.

    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rx-store-auth' },
      signal: AbortSignal.timeout(15000),
    });
    const user: any = await userRes.json().catch(() => null);
    if (!userRes.ok || user?.id == null) return { error: 'identity_unavailable' };

    // Emails: only a PRIMARY + VERIFIED email may be used for linking decisions.
    let verifiedEmail: string | null = null;
    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rx-store-auth' },
      signal: AbortSignal.timeout(15000),
    });
    if (emailsRes.ok) {
      const emails: any = await emailsRes.json().catch(() => null);
      if (Array.isArray(emails)) {
        const primaryVerified = emails.find((e: any) => e?.primary === true && e?.verified === true && typeof e.email === 'string');
        if (primaryVerified) verifiedEmail = String(primaryVerified.email).toLowerCase();
      }
    }

    return {
      id: String(user.id), // immutable — GitHub usernames can change, ids cannot
      login: typeof user.login === 'string' ? user.login : null,
      email: verifiedEmail,
      name: typeof user.name === 'string' && user.name ? user.name.slice(0, 120) : (typeof user.login === 'string' ? user.login : null),
      avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url.slice(0, 500) : null,
    };
  } catch {
    return { error: 'network' };
  }
}

// ---------------------------------------------------------------------------
// Identity storage
// ---------------------------------------------------------------------------

export interface ProviderIdentityRow {
  id: string; user_id: string; provider: string; provider_subject: string;
  provider_email: string | null; provider_email_verified: number;
  display_name: string | null; avatar_url: string | null;
  created_at?: string; updated_at?: string | null; last_login_at?: string | null;
}

export async function findIdentity(env: any, provider: OAuthProvider, subject: string): Promise<ProviderIdentityRow | null> {
  await ensureOAuthTables(env);
  const row: any = await env.DB.prepare(
    `SELECT * FROM auth_identities WHERE provider=? AND provider_subject=?`
  ).bind(provider, String(subject)).first().catch(() => null);
  return row || null;
}

export async function listIdentitiesForUser(env: any, userId: string): Promise<ProviderIdentityRow[]> {
  await ensureOAuthTables(env);
  const rows: any = await env.DB.prepare(
    `SELECT * FROM auth_identities WHERE user_id=? ORDER BY created_at ASC`
  ).bind(userId).all().catch(() => ({ results: [] }));
  return rows.results || [];
}

/** Attach a provider identity to an account. Returns false when already linked to ANY account. */
export async function linkIdentity(env: any, input: {
  userId: string; provider: OAuthProvider; subject: string;
  email: string | null; emailVerified: boolean; name: string | null; avatarUrl: string | null;
}): Promise<boolean> {
  await ensureOAuthTables(env);
  const existing = await findIdentity(env, input.provider, input.subject);
  if (existing) return existing.user_id === input.userId;
  await env.DB.prepare(
    `INSERT INTO auth_identities (id, user_id, provider, provider_subject, provider_email, provider_email_verified, display_name, avatar_url, created_at, last_login_at)
     VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
  ).bind(
    `ident_${crypto.randomUUID()}`, input.userId, input.provider, String(input.subject),
    input.email, input.emailVerified ? 1 : 0, input.name, input.avatarUrl,
  ).run();
  return true;
}

export async function unlinkIdentity(env: any, userId: string, provider: OAuthProvider): Promise<boolean> {
  await ensureOAuthTables(env);
  const res: any = await env.DB.prepare(
    `DELETE FROM auth_identities WHERE user_id=? AND provider=?`
  ).bind(userId, provider).run().catch(() => ({ meta: { changes: 0 } }));
  return (res?.meta?.changes || 0) > 0;
}

export async function touchIdentityLogin(env: any, userId: string, provider: OAuthProvider): Promise<void> {
  await env.DB.prepare(
    `UPDATE auth_identities SET last_login_at=datetime('now') WHERE user_id=? AND provider=?`
  ).bind(userId, provider).run().catch(() => {});
}

// ---------------------------------------------------------------------------
// Account provisioning for fresh social users
// ---------------------------------------------------------------------------

/**
 * A users.email is required (UNIQUE NOT NULL) and must be deliverable-looking.
 * Social accounts WITHOUT a verified provider email get a clearly
 * non-deliverable, unique placeholder (never a real mailbox) with
 * email_verified=0; the user can add/verify a real address later.
 */
export function placeholderEmail(provider: OAuthProvider, subject: string): string {
  return `${provider}-${subject}@users.noreply.rxstore.internal`;
}

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && email.endsWith('@users.noreply.rxstore.internal');
}

/** Create a fresh social-auth user (NO password — the sentinel '' is used). */
export async function createSocialUser(env: any, input: {
  provider: OAuthProvider; subject: string; email: string | null; emailVerified: boolean;
  name: string | null; avatarUrl: string | null;
}): Promise<string> {
  await ensureOAuthTables(env);
  const id = crypto.randomUUID();
  // Only a PROVIDER-VERIFIED email may become the account email; anything
  // else gets a non-deliverable placeholder (email_verified stays 0).
  const email = (input.email && input.emailVerified && !isPlaceholderEmail(input.email))
    ? input.email.toLowerCase()
    : placeholderEmail(input.provider, input.subject);
  const name = (input.name || `RX Store user`).slice(0, 120);
  await env.DB.prepare(
    `INSERT INTO users (id, name, email, password_hash, avatar_url, role, email_verified, created_at)
     VALUES (?,?,?,?,?,'user',?,datetime('now'))`
  ).bind(id, name, email, '', input.avatarUrl, input.emailVerified ? 1 : 0).run();
  await linkIdentity(env, {
    userId: id, provider: input.provider, subject: input.subject,
    email: input.email, emailVerified: input.emailVerified, name: input.name, avatarUrl: input.avatarUrl,
  });
  return id;
}
