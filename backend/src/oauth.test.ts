/**
 * OAuth secondary-authentication tests (Google + GitHub) — Phase 15 matrix.
 *
 * Drives the REAL oauthRoutes + authRoutes against a fake D1, with the real
 * provider endpoints stubbed at the fetch layer — including a REAL RSA-signed
 * Google id_token verified through the production JWKS path. Covers:
 * backward compatibility, new-user creation, identity reuse, safe linking
 * (no email auto-merge), replay/open-redirect/impersonation security, the
 * normal session machinery, and account-security rules.
 *
 * Run: node --experimental-strip-types --test backend/src/oauth.test.ts
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { oauthRoutes } from './routes/oauth.ts';
import { authRoutes } from './routes/auth.ts';
import { findLiveSession, revokeAllSessions } from './services/sessions.ts';
import { hashPassword } from './services/password.ts';

const CLIENT_ID = 'google-client-id-test';
const CLIENT_SECRET = 'google-client-secret-DO-NOT-LEAK';
const GH_CLIENT_ID = 'github-client-id-test';
const GH_CLIENT_SECRET = 'github-client-secret-DO-NOT-LEAK';
const JWT_SECRET = 'test-jwt-secret';
const WEB = 'https://web.test';

// ---------------------------------------------------------------------------
// RSA keypair for signing Google id_tokens (verified via the production path)
// ---------------------------------------------------------------------------

let privateKey: CryptoKey;
let publicJwk: any;
const KID = 'test-key-1';

before(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  privateKey = pair.privateKey;
  publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
});

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Sign a Google-shaped id_token with the test private key. */
async function signGoogleIdToken(payload: Record<string, unknown>): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${header}.${body}`)));
  return `${header}.${body}.${b64url(sig)}`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Fake D1
// ---------------------------------------------------------------------------

function fakeEnv() {
  const users = new Map<string, any>();
  const identities = new Map<string, any>();
  const tokens = new Map<string, any>();
  const sessions = new Map<string, any>();

  const DB = {
    prepare(sql: string) {
      return {
        _binds: [] as any[],
        bind(...args: any[]) { this._binds = args; return this; },
        async run() {
          const a = this._binds;
          if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) return { meta: { changes: 0 } };
          if (sql.includes('DELETE FROM oauth_tokens WHERE expires_at')) {
            let n = 0; for (const [k, t] of tokens) if (new Date(t.expires_at).getTime() <= Date.now()) { tokens.delete(k); n++; }
            return { meta: { changes: n } };
          }
          if (sql.includes('DELETE FROM oauth_tokens WHERE token_hash=?')) {
            let n = 0;
            for (const [k, t] of tokens) if (t.token_hash === a[0]) { tokens.delete(k); n++; }
            return { meta: { changes: n } };
          }
          if (sql.includes('INSERT INTO oauth_tokens')) {
            const [id, kind, token_hash, payload] = a;
            tokens.set(id, { id, kind, token_hash, payload, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), consumed_at: null });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE oauth_tokens SET consumed_at=datetime(\'now\') WHERE id=? AND consumed_at IS NULL')) {
            const t = [...tokens.values()].find((x) => x.id === a[0]);
            if (t && t.consumed_at === null) { t.consumed_at = new Date().toISOString(); return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          if (sql.includes('UPDATE oauth_tokens SET consumed_at=NULL WHERE token_hash=?')) {
            let n = 0;
            for (const t of tokens.values()) if (t.token_hash === a[0]) { t.consumed_at = null; n++; }
            return { meta: { changes: n } };
          }
          if (sql.includes('INSERT INTO auth_identities')) {
            const [id, user_id, provider, provider_subject, provider_email, provider_email_verified, display_name, avatar_url] = a;
            identities.set(id, { id, user_id, provider, provider_subject, provider_email, provider_email_verified, display_name, avatar_url, created_at: new Date().toISOString(), last_login_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('DELETE FROM auth_identities WHERE user_id=? AND provider=?')) {
            let n = 0;
            for (const [k, i] of identities) if (i.user_id === a[0] && i.provider === a[1]) { identities.delete(k); n++; }
            return { meta: { changes: n } };
          }
          if (sql.includes('UPDATE auth_identities SET last_login_at')) {
            for (const i of identities.values()) if (i.user_id === a[0] && i.provider === a[1]) i.last_login_at = new Date().toISOString();
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO users')) {
            // createSocialUser shape: (id, name, email, password_hash, avatar_url, role='user' literal, email_verified, created_at literal)
            const [id, name, email, password_hash, avatar_url, email_verified] = a;
            users.set(id, { id, name, email, phone: null, password_hash, avatar_url: avatar_url ?? null, role: 'user', email_verified: email_verified ?? 0, created_at: new Date().toISOString(), last_login_at: null, reset_token: null, reset_token_expiry: null, preferences: '{}' });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE users SET last_login_at')) {
            const u = users.get(a[0]); if (u) u.last_login_at = new Date().toISOString();
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE users SET password_hash=?, updated_at')) {
            const u = users.get(a[1]); if (u) u.password_hash = a[0];
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE users SET password_hash=?, reset_token=NULL')) {
            const u = users.get(a[1]); if (u) { u.password_hash = a[0]; u.reset_token = null; u.reset_token_expiry = null; }
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE users SET reset_token=?')) {
            const u = users.get(a[2]); if (u) { u.reset_token = a[0]; u.reset_token_expiry = a[1]; }
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO auth_sessions')) {
            const [id, user_id, token_hash, device_id, user_agent, expires_at] = a;
            sessions.set(id, { id, user_id, token_hash, device_id, user_agent, expires_at: expires_at ?? null, revoked_at: null, created_at: new Date().toISOString(), last_used_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE auth_sessions SET revoked_at=datetime(\'now\') WHERE token_hash=?')) {
            let n = 0; for (const s of sessions.values()) if (s.token_hash === a[0] && !s.revoked_at) { s.revoked_at = new Date().toISOString(); n++; }
            return { meta: { changes: n } };
          }
          if (sql.includes('UPDATE auth_sessions SET revoked_at=datetime(\'now\') WHERE user_id=?')) {
            let n = 0; for (const s of sessions.values()) if (s.user_id === a[0] && !s.revoked_at) { s.revoked_at = new Date().toISOString(); n++; }
            return { meta: { changes: n } };
          }
          if (sql.includes('UPDATE auth_sessions SET last_used_at')) return { meta: { changes: 1 } };
          return { meta: { changes: 0 } };
        },
        async first() {
          const a = this._binds;
          if (sql.includes('FROM oauth_tokens WHERE token_hash=? AND kind=?')) {
            const now = Date.now();
            for (const t of tokens.values()) {
              if (t.token_hash === a[0] && t.kind === a[1] && t.consumed_at === null && new Date(t.expires_at).getTime() > now) return { ...t };
            }
            return null;
          }
          if (sql.includes('FROM auth_identities WHERE provider=? AND provider_subject=?')) {
            for (const i of identities.values()) if (i.provider === a[0] && i.provider_subject === a[1]) return { ...i };
            return null;
          }
          if (sql.includes('FROM users WHERE email')) {
            for (const u of users.values()) if (u.email === String(a[0]).toLowerCase()) return u;
            return null;
          }
          if (sql.includes('FROM users WHERE phone')) {
            for (const u of users.values()) if (u.phone === a[0]) return u;
            return null;
          }
          if (sql.includes('FROM users WHERE id')) {
            return users.get(a[0]) || null;
          }
          if (sql.includes('FROM users WHERE reset_token')) {
            for (const u of users.values()) if (u.reset_token === a[0]) return u;
            return null;
          }
          if (sql.includes('FROM auth_sessions WHERE token_hash=?')) {
            for (const s of sessions.values()) if (s.token_hash === a[0] && !s.revoked_at) return { ...s };
            return null;
          }
          return null;
        },
        async all() {
          const a = this._binds;
          if (sql.includes('SELECT key, value FROM site_settings')) return { results: [] };
          if (sql.includes('FROM auth_identities WHERE user_id=?')) {
            return { results: [...identities.values()].filter((i) => i.user_id === a[0]) };
          }
          if (sql.includes('FROM auth_sessions WHERE user_id=?')) {
            return { results: [...sessions.values()].filter((s) => s.user_id === a[0] && !s.revoked_at) };
          }
          return { results: [] };
        },
      };
    },
  };

  return {
    DB, users, identities, tokens, sessions,
    ENVIRONMENT: 'development',
    JWT_SECRET,
    GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    GITHUB_CLIENT_ID: GH_CLIENT_ID, GITHUB_CLIENT_SECRET: GH_CLIENT_SECRET,
    OAUTH_WEB_URL: WEB,
  };
}

/** Find the fake-DB row for a RAW one-time token (tests may read/adjust it). */
async function tokenRow(env: any, raw: string): Promise<any> {
  const hash = await sha256Hex(raw);
  for (const t of env.tokens.values()) if (t.token_hash === hash) return t;
  return null;
}

// ---------------------------------------------------------------------------
// Provider fetch stubs (Google + GitHub)
// ---------------------------------------------------------------------------

function installFetchStubs(google?: { idToken: string; rejectCode?: boolean }, github?: { user?: any; emails?: any[]; rejectCode?: boolean }) {
  const original = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      if (google?.rejectCode) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      if (!google) throw new Error('unexpected google token call');
      return new Response(JSON.stringify({ access_token: 'g-access', id_token: google.idToken, token_type: 'Bearer' }), { status: 200 });
    }
    if (u.startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
      return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: KID, use: 'sig', alg: 'RS256' }] }), { status: 200 });
    }
    if (u.startsWith('https://github.com/login/oauth/access_token')) {
      if (github?.rejectCode) return new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 });
      if (!github) throw new Error('unexpected github token call');
      return new Response(JSON.stringify({ access_token: 'gh-access', token_type: 'bearer' }), { status: 200 });
    }
    if (u === 'https://api.github.com/user') {
      return new Response(JSON.stringify(github?.user ?? { id: 98765, login: 'octocat', name: 'Octo Cat', avatar_url: 'https://avatars.test/octo.png', email: null }), { status: 200 });
    }
    if (u === 'https://api.github.com/user/emails') {
      return new Response(JSON.stringify(github?.emails ?? [{ email: 'octo@example.com', primary: true, verified: true }]), { status: 200 });
    }
    return original(url, init);
  }) as any;
  return { restore: () => { globalThis.fetch = original; }, calls };
}

// ---------------------------------------------------------------------------
// Flow helpers
// ---------------------------------------------------------------------------

function getReq(path: string): Request {
  return new Request(`https://api.test${path}`, { method: 'GET', headers: { 'User-Agent': 'test-agent' } });
}
function postReq(path: string, body: any, token?: string): Request {
  return new Request(`https://api.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'test-agent', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}
function authReq(path: string, token: string, method = 'GET'): Request {
  return new Request(`https://api.test${path}`, { method, headers: { 'User-Agent': 'test-agent', Authorization: `Bearer ${token}` } });
}

/** Start the flow and return the RAW state (from the provider redirect URL). */
async function startFlow(env: any, provider: string, query = ''): Promise<{ state: string; location: URL }> {
  const res: any = await oauthRoutes.start(getReq(`/auth/oauth/${provider}${query}`), env, provider);
  assert.ok(res instanceof Response && res.status === 302, 'start must redirect');
  const location = new URL(res.headers.get('Location')!);
  const state = location.searchParams.get('state')!;
  assert.ok(state);
  return { state, location };
}

/** The newest unconsumed state row's payload (nonce etc. for id_token minting). */
function latestStatePayload(env: any): any {
  const rows = [...env.tokens.values()].filter((t) => t.kind === 'state' && !t.consumed_at);
  return rows.length ? JSON.parse(rows[rows.length - 1].payload) : null;
}

async function completeWith(env: any, code: string): Promise<any> {
  return oauthRoutes.complete(postReq('/auth/oauth/complete', { code }), env);
}

async function seedPasswordUser(env: any, email = 'existing@example.com', password = 'Passw0rd!123') {
  const hash = await hashPassword(password);
  const id = crypto.randomUUID();
  env.users.set(id, { id, name: 'Existing User', email, phone: null, password_hash: hash, avatar_url: null, role: 'user', email_verified: 1, created_at: new Date().toISOString(), last_login_at: null, reset_token: null, reset_token_expiry: null, preferences: '{}' });
  return env.users.get(id);
}

/** Full Google callback with a freshly signed id_token bound to the live state. */
async function runGoogleCallback(env: any, opts: {
  sub: string; email?: string | null; emailVerified?: boolean;
  nonceOverride?: string; audOverride?: string; badSignature?: boolean;
}) {
  const { state } = await startFlow(env, 'google');
  const payload = latestStatePayload(env);
  const now = Math.floor(Date.now() / 1000);
  let idToken = await signGoogleIdToken({
    iss: 'https://accounts.google.com',
    aud: opts.audOverride ?? CLIENT_ID,
    sub: opts.sub,
    email: opts.email ?? 'guser@example.com',
    email_verified: opts.emailVerified ?? true,
    name: 'Google User',
    picture: 'https://lh3.googleusercontent/test.png',
    exp: now + 3600, iat: now,
    nonce: opts.nonceOverride ?? payload.nonce,
  });
  if (opts.badSignature) idToken = idToken.slice(0, -3) + (idToken.endsWith('AAA') ? 'BBB' : 'AAA');
  const stubs = installFetchStubs({ idToken });
  try {
    return await oauthRoutes.callback(getReq(`/auth/oauth/google/callback?code=valid-code&state=${encodeURIComponent(state)}`), env, 'google');
  } finally {
    stubs.restore();
  }
}

/** Full GitHub callback. */
async function runGithubCallback(env: any, opts: { id: string; emails?: any[]; user?: any }) {
  const { state } = await startFlow(env, 'github');
  const stubs = installFetchStubs(undefined, {
    user: opts.user ?? { id: Number(opts.id), login: `user${opts.id}`, name: 'GH User', avatar_url: 'https://avatars.test/gh.png', email: null },
    emails: opts.emails,
  });
  try {
    return await oauthRoutes.callback(getReq(`/auth/oauth/github/callback?code=valid-code&state=${encodeURIComponent(state)}`), env, 'github');
  } finally {
    stubs.restore();
  }
}

function cbParams(res: any): URLSearchParams {
  assert.ok(res instanceof Response && res.status === 302, 'callback must redirect');
  const loc = res.headers.get('Location')!;
  assert.ok(loc.startsWith(`${WEB}/oauth/callback`), `redirects to the WEB app only (got ${loc})`);
  return new URL(loc).searchParams;
}

// ---------------------------------------------------------------------------
// Backward compatibility (cases 1–4)
// ---------------------------------------------------------------------------

test('existing password user still logs in with password', async () => {
  const env = fakeEnv();
  const u = await seedPasswordUser(env);
  const res = await authRoutes.login(postReq('/auth/login', { identifier: 'existing@example.com', password: 'Passw0rd!123' }), env);
  assert.ok(!res.code, res.message);
  assert.equal(res.user.id, u.id);
});

test('existing sessions + user data survive OAuth being introduced', async () => {
  const env = fakeEnv();
  const u = await seedPasswordUser(env);
  const login = await authRoutes.login(postReq('/auth/login', { identifier: 'existing@example.com', password: 'Passw0rd!123', deviceId: 'dev-old-1' }), env);
  assert.ok(await findLiveSession(env, login.refreshToken), 'existing session model unchanged');
  // Unrelated OAuth signup happens; the existing user's row is untouched.
  await runGoogleCallback(env, { sub: 'g-unrelated-1', email: 'unrelated@example.com' });
  const after = env.users.get(u.id)!;
  assert.equal(after.password_hash, u.password_hash, 'password hash unchanged');
  assert.equal(after.role, 'user');
  assert.equal(after.name, 'Existing User');
  assert.equal(after.email, 'existing@example.com');
  assert.ok(await findLiveSession(env, login.refreshToken), 'session still valid');
});

// ---------------------------------------------------------------------------
// New Google user (cases 5–8)
// ---------------------------------------------------------------------------

test('valid Google identity creates an RX Store account + normal session', async () => {
  const env = fakeEnv();
  const res = await runGoogleCallback(env, { sub: 'google-sub-111', email: 'guser@example.com', emailVerified: true });
  const params = cbParams(res);
  assert.equal(params.get('status'), 'new');
  const done = await completeWith(env, params.get('code')!);
  assert.ok(!done.code, done.message);
  assert.ok(done.token && done.refreshToken, 'normal access + refresh credentials');
  const user = [...env.users.values()].find((x) => x.email === 'guser@example.com')!;
  assert.ok(user);
  assert.equal(user.password_hash, '', 'no password invented for a social account');
  assert.equal(user.email_verified, 1, 'verified only because Google verified it');
  assert.equal(done.user.id, user.id);
  assert.ok(await findLiveSession(env, done.refreshToken), 'OAuth login creates auth_sessions');
});

test('second Google login resolves to the SAME account (subject is the key)', async () => {
  const env = fakeEnv();
  await runGoogleCallback(env, { sub: 'google-sub-111', email: 'guser@example.com' });
  const first = [...env.users.values()].find((x) => x.email === 'guser@example.com')!;
  const res = await runGoogleCallback(env, { sub: 'google-sub-111', email: 'renamed-different@example.com' });
  assert.equal(cbParams(res).get('status'), 'login', 'identity match, not email match');
  const done = await completeWith(env, cbParams(res).get('code')!);
  assert.equal(done.user.id, first.id, 'no duplicate account');
  assert.equal(env.identities.size, 1, 'identity stored exactly once');
});

test('Google user with an UNVERIFIED email gets a placeholder (never treated as verified)', async () => {
  const env = fakeEnv();
  const res = await runGoogleCallback(env, { sub: 'google-sub-noemail', email: 'someone@example.com', emailVerified: false });
  const done = await completeWith(env, cbParams(res).get('code')!);
  const user = [...env.users.values()].find((x) => x.id === done.user.id)!;
  assert.equal(user.email_verified, 0);
  assert.ok(user.email.endsWith('@users.noreply.rxstore.internal'));
  assert.equal(done.user.email, null, 'placeholder never surfaced as the account email');
});

// ---------------------------------------------------------------------------
// New GitHub user (cases 9–12)
// ---------------------------------------------------------------------------

test('valid GitHub identity creates an account (immutable id is the key)', async () => {
  const env = fakeEnv();
  const res = await runGithubCallback(env, { id: '98765', emails: [{ email: 'octo@example.com', primary: true, verified: true }] });
  assert.equal(cbParams(res).get('status'), 'new');
  const done = await completeWith(env, cbParams(res).get('code')!);
  assert.ok(done.token && done.refreshToken);
  const user = [...env.users.values()].find((x) => x.email === 'octo@example.com')!;
  assert.equal(user.password_hash, '');
  assert.equal(done.user.id, user.id);
  assert.ok(await findLiveSession(env, done.refreshToken));
});

test('second GitHub login resolves to the same account; username changes do not matter', async () => {
  const env = fakeEnv();
  await runGithubCallback(env, { id: '98765', emails: [{ email: 'octo@example.com', primary: true, verified: true }] });
  const first = [...env.users.values()].find((x) => x.email === 'octo@example.com')!;
  const res = await runGithubCallback(env, {
    id: '98765',
    user: { id: 98765, login: 'renamed-login', name: 'New Name' },
    emails: [{ email: 'octo@example.com', primary: true, verified: true }],
  });
  const done = await completeWith(env, cbParams(res).get('code')!);
  assert.equal(done.user.id, first.id);
  assert.equal(env.identities.size, 1);
});

test('GitHub account with NO verified email is handled safely', async () => {
  const env = fakeEnv();
  const res = await runGithubCallback(env, { id: '555', emails: [{ email: 'private@example.com', primary: true, verified: false }] });
  const done = await completeWith(env, cbParams(res).get('code')!);
  const user = [...env.users.values()].find((x) => x.id === done.user.id)!;
  assert.equal(user.email_verified, 0);
  assert.ok(user.email.endsWith('@users.noreply.rxstore.internal'));
  assert.equal(done.user.email, null);
});

// ---------------------------------------------------------------------------
// Safe linking (cases 13–18)
// ---------------------------------------------------------------------------

test('existing password user can CONNECT Google from Account Security (authenticated link)', async () => {
  const env = fakeEnv();
  const u = await seedPasswordUser(env);
  const login = await authRoutes.login(postReq('/auth/login', { identifier: 'existing@example.com', password: 'Passw0rd!123' }), env);
  const start = await oauthRoutes.linkStart(postReq('/auth/oauth/link-start', { provider: 'google' }, login.token), env);
  assert.ok(start.url, 'returns the connect URL');
  // Follow it: start?intent=… → Google → callback (mode=link).
  const started: any = await oauthRoutes.start(getReq(start.url), env, 'google');
  const rawState = new URL(started.headers.get('Location')!).searchParams.get('state')!;
  const payload = latestStatePayload(env);
  assert.equal(payload.mode, 'link');
  assert.equal(payload.userId, u.id);
  const now = Math.floor(Date.now() / 1000);
  const idToken = await signGoogleIdToken({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'google-sub-222', email: 'existing@example.com', email_verified: true, name: 'Existing User', exp: now + 3600, iat: now, nonce: payload.nonce });
  const stubs = installFetchStubs({ idToken });
  try {
    const res = await oauthRoutes.callback(getReq(`/auth/oauth/google/callback?code=valid&state=${encodeURIComponent(rawState)}`), env, 'google');
    assert.equal(cbParams(res).get('status'), 'linked');
  } finally { stubs.restore(); }
  assert.equal([...env.identities.values()][0].user_id, u.id, 'identity attached to the EXISTING account');
  assert.equal([...env.users.values()].filter((x) => x.email === 'existing@example.com').length, 1, 'no duplicate account');
});

test('same-email identity REQUIRES password-proofed linking; then login reaches the same account', async () => {
  const env = fakeEnv();
  const u = await seedPasswordUser(env);
  const res = await runGoogleCallback(env, { sub: 'google-sub-333', email: 'existing@example.com', emailVerified: true });
  const loc = new URL((res as Response).headers.get('Location')!);
  assert.equal(loc.pathname, '/oauth/link', 'NO silent merge — linking confirmation required');
  const linkToken = loc.searchParams.get('token')!;
  // Wrong password fails (and keeps the link token usable).
  const bad = await oauthRoutes.linkConfirm(postReq('/auth/oauth/link/confirm', { token: linkToken, password: 'wrong-wrong' }), env);
  assert.equal(bad.code, 'UNAUTHORIZED');
  const good = await oauthRoutes.linkConfirm(postReq('/auth/oauth/link/confirm', { token: linkToken, password: 'Passw0rd!123' }), env);
  assert.ok(!good.code, good.message);
  assert.equal(good.user.id, u.id);
  assert.ok(good.token && good.refreshToken, 'normal session issued after linking');
  // The NEXT Google login goes straight into that account.
  const again = await runGoogleCallback(env, { sub: 'google-sub-333', email: 'existing@example.com', emailVerified: true });
  assert.equal(cbParams(again).get('status'), 'login');
  const done = await completeWith(env, cbParams(again).get('code')!);
  assert.equal(done.user.id, u.id);
});

test('duplicate provider identity cannot be linked to ANOTHER account', async () => {
  const env = fakeEnv();
  await seedPasswordUser(env, 'a@example.com');
  const b = await seedPasswordUser(env, 'b@example.com');
  // google-sub-444 belongs to b (via link-confirm with b's password).
  const res = await runGoogleCallback(env, { sub: 'google-sub-444', email: 'b@example.com', emailVerified: true });
  const linkToken = new URL((res as Response).headers.get('Location')!).searchParams.get('token')!;
  await oauthRoutes.linkConfirm(postReq('/auth/oauth/link/confirm', { token: linkToken, password: 'Passw0rd!123' }), env);
  // User A (authenticated) tries to connect the SAME Google identity.
  const loginA = await authRoutes.login(postReq('/auth/login', { identifier: 'a@example.com', password: 'Passw0rd!123' }), env);
  const start = await oauthRoutes.linkStart(postReq('/auth/oauth/link-start', { provider: 'google' }, loginA.token), env);
  const started: any = await oauthRoutes.start(getReq(start.url), env, 'google');
  const rawState = new URL(started.headers.get('Location')!).searchParams.get('state')!;
  const payload = latestStatePayload(env);
  const now = Math.floor(Date.now() / 1000);
  const idToken = await signGoogleIdToken({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'google-sub-444', email: 'a@example.com', email_verified: true, name: 'A', exp: now + 3600, iat: now, nonce: payload.nonce });
  const stubs = installFetchStubs({ idToken });
  try {
    const out = await oauthRoutes.callback(getReq(`/auth/oauth/google/callback?code=valid&state=${encodeURIComponent(rawState)}`), env, 'google');
    assert.equal(cbParams(out).get('status'), 'error');
    assert.equal(cbParams(out).get('reason'), 'provider_linked_elsewhere');
  } finally { stubs.restore(); }
  const ident = [...env.identities.values()].find((i) => i.provider_subject === 'google-sub-444')!;
  assert.equal(ident.user_id, b.id, 'ownership unchanged');
});

test('same email ALONE never auto-merges (unverified provider email is ignored)', async () => {
  const env = fakeEnv();
  const u = await seedPasswordUser(env);
  const res = await runGoogleCallback(env, { sub: 'google-sub-555', email: 'existing@example.com', emailVerified: false });
  assert.equal(cbParams(res).get('status'), 'new', 'unverified email never triggers the link flow');
  const done = await completeWith(env, cbParams(res).get('code')!);
  assert.notEqual(done.user.id, u.id);
});

// ---------------------------------------------------------------------------
// Security (cases 19–27)
// ---------------------------------------------------------------------------

test('invalid OAuth state fails', async () => {
  const env = fakeEnv();
  const res = await oauthRoutes.callback(getReq(`/auth/oauth/google/callback?code=valid&state=${encodeURIComponent('o_not_a_real_state')}`), env, 'google');
  assert.equal(cbParams(res).get('reason'), 'invalid_state');
});

test('REUSED state fails (single-use, atomic)', async () => {
  const env = fakeEnv();
  const { state } = await startFlow(env, 'google');
  const payload = latestStatePayload(env);
  const now = Math.floor(Date.now() / 1000);
  const idToken = await signGoogleIdToken({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'g-replay', email: 'replay@example.com', email_verified: true, exp: now + 3600, iat: now, nonce: payload.nonce });
  const stubs = installFetchStubs({ idToken });
  try {
    const first = await oauthRoutes.callback(getReq(`/auth/oauth/google/callback?code=valid&state=${encodeURIComponent(state)}`), env, 'google');
    assert.equal(cbParams(first).get('status'), 'new');
    const second = await oauthRoutes.callback(getReq(`/auth/oauth/google/callback?code=valid&state=${encodeURIComponent(state)}`), env, 'google');
    assert.equal(cbParams(second).get('reason'), 'invalid_state', 'replay rejected');
  } finally { stubs.restore(); }
});

test('EXPIRED state fails', async () => {
  const env = fakeEnv();
  const { state } = await startFlow(env, 'github');
  const row = await tokenRow(env, state);
  assert.ok(row);
  row.expires_at = new Date(Date.now() - 60_000).toISOString();
  const res = await oauthRoutes.callback(getReq(`/auth/oauth/github/callback?code=valid&state=${encodeURIComponent(state)}`), env, 'github');
  assert.equal(cbParams(res).get('reason'), 'invalid_state');
});

test('invalid authorization code fails (provider rejects the exchange)', async () => {
  const env = fakeEnv();
  const { state } = await startFlow(env, 'github');
  const stubs = installFetchStubs(undefined, { rejectCode: true });
  try {
    const res = await oauthRoutes.callback(getReq(`/auth/oauth/github/callback?code=BAD&state=${encodeURIComponent(state)}`), env, 'github');
    assert.equal(cbParams(res).get('reason'), 'provider_validation');
  } finally { stubs.restore(); }
});

test('provider identity validation failures fail closed (signature / nonce / audience)', async () => {
  const env = fakeEnv();
  let res = await runGoogleCallback(env, { sub: 'g-bad', badSignature: true });
  assert.equal(cbParams(res).get('reason'), 'provider_validation');
  res = await runGoogleCallback(env, { sub: 'g-bad', nonceOverride: 'attacker-nonce' });
  assert.equal(cbParams(res).get('reason'), 'provider_validation');
  res = await runGoogleCallback(env, { sub: 'g-bad', audOverride: 'someone-elses-client-id' });
  assert.equal(cbParams(res).get('reason'), 'provider_validation');
  assert.equal(env.users.size, 0, 'no account created by any failed attempt');
});

test('open redirect attempts fail (only safe in-app paths are honoured)', async () => {
  const env = fakeEnv();
  // 1. START refuses to carry an external redirect.
  await startFlow(env, 'google', '?redirect=https://evil.example/phish');
  assert.equal(latestStatePayload(env).redirect, '/', 'external redirect normalised to /');
  // 2. Even a tampered completion payload cannot smuggle one through.
  const res = await runGoogleCallback(env, { sub: 'g-open', email: 'open@example.com' });
  const code = cbParams(res).get('code')!;
  const row = await tokenRow(env, code);
  row.payload = JSON.stringify({ userId: JSON.parse(row.payload).userId, redirect: 'https://evil.example/phish', status: 'login' });
  const done = await completeWith(env, code);
  assert.equal(done.redirect, '/', 'external redirect never returned to the client');
  // 3. The callback redirect only ever targets the configured web origin.
  assert.ok((res as Response).headers.get('Location')!.startsWith(`${WEB}/oauth/callback`));
});

test('OAuth client secrets never reach responses', async () => {
  const env = fakeEnv();
  const res = await runGoogleCallback(env, { sub: 'g-secret', email: 'secret@example.com' });
  const done = await completeWith(env, cbParams(res).get('code')!);
  const methods = await oauthRoutes.methods(authReq('/auth/methods', done.token), env);
  const blob = JSON.stringify({ done, methods }) + (res as Response).headers.get('Location')!;
  assert.ok(!blob.includes(CLIENT_SECRET) && !blob.includes(GH_CLIENT_SECRET), 'no secrets in any response');
});

test('the link flow cannot attach an identity without the account password (no impersonation)', async () => {
  const env = fakeEnv();
  await seedPasswordUser(env);
  const res = await runGoogleCallback(env, { sub: 'g-imp', email: 'existing@example.com', emailVerified: true });
  const linkToken = new URL((res as Response).headers.get('Location')!).searchParams.get('token')!;
  for (let i = 0; i < 3; i++) {
    const bad = await oauthRoutes.linkConfirm(postReq('/auth/oauth/link/confirm', { token: linkToken, password: `wrong-${i}` }), env);
    assert.equal(bad.code, 'UNAUTHORIZED');
  }
  assert.equal(env.identities.size, 0, 'no identity attached without the password');
});

// ---------------------------------------------------------------------------
// Session machinery (cases 28–33)
// ---------------------------------------------------------------------------

test('OAuth session: refresh, logout, logout-all and admin revocation all work', async () => {
  const env = fakeEnv();
  const res = await runGoogleCallback(env, { sub: 'g-session', email: 'sess@example.com' });
  const done = await completeWith(env, cbParams(res).get('code')!);
  const userId = done.user.id;

  // Refresh (rotation) works with the NORMAL endpoint.
  const refreshed = await authRoutes.refresh(postReq('/auth/refresh', { refreshToken: done.refreshToken }), env);
  assert.ok(!refreshed.code, refreshed.message);
  assert.ok(refreshed.token && refreshed.refreshToken);

  // A later session survives a current-device logout of the earlier one.
  const second = await authRoutes.refresh(postReq('/auth/refresh', { refreshToken: refreshed.refreshToken }), env);
  assert.ok(!second.code, second.message);
  const out = await authRoutes.logout(postReq('/auth/logout', { refreshToken: done.refreshToken }), env);
  assert.ok(out.success);
  assert.equal(await findLiveSession(env, done.refreshToken), null, 'original revoked by rotation');
  assert.ok(await findLiveSession(env, second.refreshToken!), 'other session survives');

  // Logout ALL devices.
  const all = await authRoutes.logout(postReq('/auth/logout', { refreshToken: second.refreshToken, allDevices: true }), env);
  assert.ok(all.success);
  assert.equal(await findLiveSession(env, second.refreshToken!), null);

  // The rotated-away credential is dead.
  const third = await authRoutes.refresh(postReq('/auth/refresh', { refreshToken: second.refreshToken }), env);
  assert.equal(third.code, 'INVALID_TOKEN');

  // Admin revocation on a fresh session also works.
  const again = await completeWith(env, cbParams(await runGoogleCallback(env, { sub: 'g-session', email: 'sess@example.com' })).get('code')!);
  await revokeAllSessions(env, userId);
  assert.equal(await findLiveSession(env, again.refreshToken), null);
});

test('password reset continues to work for password accounts', async () => {
  const env = fakeEnv();
  const u = await seedPasswordUser(env);
  const rawToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`rx-reset:${rawToken}`));
  const tokenHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  env.users.get(u.id)!.reset_token = tokenHash;
  env.users.get(u.id)!.reset_token_expiry = new Date(Date.now() + 30 * 60_000).toISOString();
  const res = await authRoutes.resetPassword(postReq('/auth/reset-password', { token: rawToken, password: 'NewPassw0rd!456' }), env);
  assert.ok(res.success, String(res.error));
  const login = await authRoutes.login(postReq('/auth/login', { identifier: 'existing@example.com', password: 'NewPassw0rd!456' }), env);
  assert.ok(!login.code, login.message);
});

test('social-only accounts get a truthful password-login message', async () => {
  const env = fakeEnv();
  const res = await runGoogleCallback(env, { sub: 'g-socialonly', email: 'socialonly@example.com' });
  await completeWith(env, cbParams(res).get('code')!);
  const login = await authRoutes.login(postReq('/auth/login', { identifier: 'socialonly@example.com', password: 'whatever-123' }), env);
  assert.equal(login.code, 'UNAUTHORIZED');
  assert.match(login.message, /Google or GitHub/);
});

// ---------------------------------------------------------------------------
// Account security area (cases 34–39)
// ---------------------------------------------------------------------------

test('methods list shows connected providers; connect/disconnect rules enforced', async () => {
  const env = fakeEnv();
  // Social-only Google account.
  const res = await runGoogleCallback(env, { sub: 'g-sec', email: 'sec@example.com' });
  const done = await completeWith(env, cbParams(res).get('code')!);
  const userId = done.user.id;

  const methods = await oauthRoutes.methods(authReq('/auth/methods', done.token), env);
  assert.equal(methods.password.connected, false);
  assert.equal(methods.google.connected, true);
  assert.equal(methods.github.connected, false);

  // Case 37: cannot disconnect the FINAL usable method.
  const fail = await oauthRoutes.disconnect(authReq('/auth/oauth/google/disconnect', done.token, 'POST'), env, 'google');
  assert.equal(fail.code, 'FORBIDDEN');

  // Set a password (social-only account) → Google may now be disconnected.
  const setPw = await oauthRoutes.setPassword(postReq('/auth/set-password', { password: 'FreshPassw0rd!' }, done.token), env);
  assert.ok(setPw.success, String(setPw.message));
  const m2 = await oauthRoutes.methods(authReq('/auth/methods', done.token), env);
  assert.equal(m2.password.connected, true);
  assert.equal(m2.google.canDisconnect, true);

  // Connect GitHub, then disconnect BOTH providers (password remains).
  const ghStart = await oauthRoutes.linkStart(postReq('/auth/oauth/link-start', { provider: 'github' }, done.token), env);
  const ghStarted: any = await oauthRoutes.start(getReq(ghStart.url), env, 'github');
  const ghState = new URL(ghStarted.headers.get('Location')!).searchParams.get('state')!;
  const stubs = installFetchStubs(undefined, { user: { id: 777, login: 'gh-sec', name: 'GH Sec' }, emails: [{ email: 'ghsec@example.com', primary: true, verified: true }] });
  try {
    const out = await oauthRoutes.callback(getReq(`/auth/oauth/github/callback?code=valid&state=${encodeURIComponent(ghState)}`), env, 'github');
    assert.equal(cbParams(out).get('status'), 'linked');
  } finally { stubs.restore(); }

  const d1 = await oauthRoutes.disconnect(authReq('/auth/oauth/google/disconnect', done.token, 'POST'), env, 'google');
  assert.ok(d1.success, JSON.stringify(d1));
  const d2 = await oauthRoutes.disconnect(authReq('/auth/oauth/github/disconnect', done.token, 'POST'), env, 'github');
  assert.ok(d2.success, JSON.stringify(d2));
  // Password login now works for this account.
  const login = await authRoutes.login(postReq('/auth/login', { identifier: 'sec@example.com', password: 'FreshPassw0rd!' }), env);
  assert.ok(!login.code, login.message);
  assert.equal(login.user.id, userId);
});

test('set-password refuses to overwrite an existing password (use the reset flow)', async () => {
  const env = fakeEnv();
  const u = await seedPasswordUser(env);
  const login = await authRoutes.login(postReq('/auth/login', { identifier: 'existing@example.com', password: 'Passw0rd!123' }), env);
  const res = await oauthRoutes.setPassword(postReq('/auth/set-password', { password: 'AnotherPass1!' }, login.token), env);
  assert.equal(res.code, 'CONFLICT');
  assert.equal(env.users.get(u.id)!.password_hash, u.password_hash, 'hash untouched');
});

test('providers endpoint reports configuration WITHOUT leaking ids/secrets', async () => {
  const env = fakeEnv();
  const out = await oauthRoutes.providers(getReq('/auth/oauth/providers'), env);
  assert.deepEqual(out, { google: true, github: true });
  assert.ok(!JSON.stringify(out).includes(CLIENT_ID) && !JSON.stringify(out).includes(CLIENT_SECRET));
});

test('cancelled provider authorization returns a friendly state (nothing consumed)', async () => {
  const env = fakeEnv();
  const { state } = await startFlow(env, 'google');
  const res = await oauthRoutes.callback(getReq(`/auth/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`), env, 'google');
  assert.equal(cbParams(res).get('status'), 'cancelled');
});
