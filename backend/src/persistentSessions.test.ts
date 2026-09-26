/**
 * Persistent authentication sessions (auth hardening phase 23).
 *
 * Runs under Node's TypeScript stripping (no Cloudflare runtime needed). Uses
 * injected fake D1 envs to drive the REAL route handlers in routes/auth.ts and
 * routes/admin.ts plus the session service directly.
 *
 * Covers the required authentication matrix:
 *   - registration (auto signed-in, persistent session)
 *   - login by email / by phone, invalid credentials
 *   - short-lived access token expiry + silent refresh
 *   - refresh-token rotation (replay protection)
 *   - PERSISTENT sessions (no 30-day expiry; survives indefinitely)
 *   - revoked session (incl. administrative revocation)
 *   - current-device logout vs all-device logout
 *   - legacy 30-day session model → migrated to persistent on refresh
 *   - legacy-table-shape self-heal (expires_at NOT NULL → nullable)
 *   - rotation preserves device association + user-agent
 *
 * Run: node --experimental-strip-types --test backend/src/persistentSessions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken } from './services/auth.ts';
import {
  createSession, findLiveSession, revokeByToken, revokeAllSessions, listSessions,
  ensureSessionTable, sessionIsLive, hashToken, _internal,
} from './services/sessions.ts';
import { authRoutes } from './routes/auth.ts';
import { adminRoutes } from './routes/admin.ts';

const SECRET = 'test-secret-please-rotate';
const DAY = 24 * 60 * 60;

/** Mint a LEGACY JWT refresh token (pre-persistent model, 30-day life). */
async function legacyRefreshJwt(payload: any, secret: string, lifetimeSeconds: number): Promise<string> {
  return signJwt(payload, secret, lifetimeSeconds, 'refresh');
}

/** Mint a signed JWT of either type with an arbitrary lifetime (test-only). */
async function signJwt(payload: any, secret: string, lifetimeSeconds: number, tokenType: 'access' | 'refresh'): Promise<string> {
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...payload, iss: 'rx-store-api', aud: 'rx-store', tokenType, iat: now, jti: crypto.randomUUID(), exp: now + lifetimeSeconds });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`)));
  return `${header}.${body}.${Buffer.from(sig).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// Fake D1 that models `users` + `auth_sessions` (+ the rename-dance rebuild)
// ---------------------------------------------------------------------------

interface FakeEnvOpts { legacySessionShape?: boolean }

function fakeEnv(opts: FakeEnvOpts = {}) {
  const users = new Map<string, any>();
  const sessions = new Map<string, any>();
  let legacyShape = !!opts.legacySessionShape;

  const DB = {
    /** D1-compatible batch: sequential execution (the real one is atomic). */
    async batch(stmts: any[]) {
      const results = [];
      for (const s of stmts) results.push(await s.run());
      return results;
    },
    prepare(sql: string) {
      return {
        _binds: [] as any[],
        bind(...args: any[]) { this._binds = args; return this; },
        async run() {
          const a = this._binds;
          if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) return { meta: { changes: 0 } };
          // Rename-dance shape upgrade (legacy → nullable expires_at).
          if (sql.includes('INSERT INTO auth_sessions_rebuild')) {
            // Apply the migration's CASE: live rows → NULL (persistent), dead rows unchanged.
            for (const s of sessions.values()) {
              const live = !s.revoked_at && (!s.expires_at || new Date(s.expires_at).getTime() > Date.now());
              if (live) s.expires_at = null;
            }
            return { meta: { changes: sessions.size } };
          }
          if (sql.includes('DROP TABLE auth_sessions')) return { meta: { changes: sessions.size } };
          if (sql.includes('ALTER TABLE auth_sessions_rebuild RENAME TO auth_sessions')) {
            legacyShape = false;
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO auth_sessions')) {
            const [id, user_id, token_hash, device_id, user_agent, expires_at] = a;
            sessions.set(id, { id, user_id, token_hash, device_id, user_agent, expires_at: expires_at ?? null, revoked_at: null, created_at: new Date().toISOString(), last_used_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO users')) {
            const [id, name, email, phone, password_hash, role] = a;
            users.set(id, { id, name, email, phone: phone ?? null, password_hash, role: role || 'user', avatar_url: null, created_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE auth_sessions SET revoked_at=datetime') && sql.includes('token_hash=?')) {
            let n = 0;
            for (const s of sessions.values()) if (s.token_hash === a[0] && !s.revoked_at) { s.revoked_at = new Date().toISOString(); n++; }
            return { meta: { changes: n } };
          }
          if (sql.includes('UPDATE auth_sessions SET revoked_at=datetime') && sql.includes('user_id=?')) {
            let n = 0;
            for (const s of sessions.values()) if (s.user_id === a[0] && !s.revoked_at) { s.revoked_at = new Date().toISOString(); n++; }
            return { meta: { changes: n } };
          }
          if (sql.includes('UPDATE auth_sessions SET last_used_at')) return { meta: { changes: 1 } };
          if (sql.includes('UPDATE users SET last_login_at')) return { meta: { changes: 1 } };
          if (sql.includes('UPDATE users SET password_hash=?')) {
            const u = users.get(a[2]);
            if (u) u.password_hash = a[0];
            return { meta: { changes: u ? 1 : 0 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          const a = this._binds;
          if (sql.includes('FROM sqlite_master')) {
            return legacyShape
              ? { sql: 'CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, device_id TEXT, user_agent TEXT, created_at TEXT, last_used_at TEXT, expires_at TEXT NOT NULL, revoked_at TEXT)' }
              : { sql: 'CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, device_id TEXT, user_agent TEXT, created_at TEXT, last_used_at TEXT, expires_at TEXT, revoked_at TEXT)' };
          }
          if (sql.includes('FROM users WHERE email')) {
            const email = String(a[0]).toLowerCase();
            for (const u of users.values()) if (u.email === email) return sql.includes('SELECT id FROM') ? { id: u.id } : u;
            return null;
          }
          if (sql.includes('FROM users WHERE phone')) {
            for (const u of users.values()) if (u.phone === a[0]) return u;
            return null;
          }
          if (sql.includes('FROM users WHERE id=?') || sql.includes('FROM users WHERE id = ?')) {
            return users.get(a[0]) || null;
          }
          if (sql.includes('FROM users WHERE reset_token')) return null;
          if (sql.includes('FROM auth_sessions WHERE token_hash=?')) {
            for (const s of sessions.values()) if (s.token_hash === a[0] && !s.revoked_at) return { ...s };
            return null;
          }
          return null;
        },
        async all() {
          if (sql.includes('SELECT key, value FROM site_settings')) return { results: [] };
          if (sql.includes('FROM auth_sessions WHERE user_id=?')) {
            return { results: [...sessions.values()].filter((s) => s.user_id === this._binds[0] && !s.revoked_at) };
          }
          return { results: [] };
        },
      };
    },
  };
  return {
    DB, users, sessions,
    JWT_SECRET: SECRET,
    get legacyShape() { return legacyShape; },
  };
}

function jsonRequest(path: string, body: any, user?: any): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'rx-test-agent/1.0' };
  const req = new Request(`https://api.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (user) (req as any).user = user;
  return req;
}

/** Register a user through the REAL route, returning { env, tokens, user } . */
async function registerUser(name = 'Test User', email = 'test@example.com', phone?: string) {
  const env = fakeEnv();
  const res = await authRoutes.register(jsonRequest('/auth/register', { name, email, password: 'Passw0rd!123', phone, deviceId: 'dev-test-1' }), env);
  assert.ok(!res.code, `registration succeeded: ${res.code} ${res.message}`);
  return { env, res };
}

// ---------------------------------------------------------------------------
// Registration / login
// ---------------------------------------------------------------------------

test('registration creates the account AND a persistent session (auto signed-in)', async () => {
  const { env, res } = await registerUser('Ama Mensah', 'ama@example.com', '+233241234567');
  // Account created + authenticated session returned — no second sign-in needed.
  assert.ok(res.token, 'access token returned');
  assert.ok(res.refreshToken, 'refresh token returned');
  assert.ok(res.refreshToken.startsWith('rxr_'), 'new refresh credentials are opaque');
  assert.equal(res.user.email, 'ama@example.com');
  assert.equal(res.user.name, 'Ama Mensah');
  // The server-side session is PERSISTENT: expires_at NULL, never a 30-day TTL.
  const rows = [...env.sessions.values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].expires_at, null, 'session has no expiry — only revocation ends it');
  assert.equal(rows[0].revoked_at, null);
  assert.equal(rows[0].device_id, 'dev-test-1');
  // The access token verifies and the refresh token matches the session.
  const payload = await verifyAccessToken(res.token, SECRET);
  assert.equal(payload.userId, res.user.id);
  assert.ok(await findLiveSession(env, res.refreshToken), 'session is live for the issued refresh token');
});

test('login by email works and creates a persistent session', async () => {
  const { env } = await registerUser('Kofi Owusu', 'kofi@example.com');
  const res = await authRoutes.login(jsonRequest('/auth/login', { identifier: 'kofi@example.com', password: 'Passw0rd!123', deviceId: 'devA' }), env);
  assert.ok(!res.code, res.message);
  assert.equal(res.user.email, 'kofi@example.com');
  const rows = [...env.sessions.values()];
  assert.equal(rows.length, 2, 'register session + login session');
  assert.ok(rows.every((r) => r.expires_at === null), 'all sessions persistent');
});

test('duplicate email registration is rejected (CONFLICT, existing account untouched)', async () => {
  const { env } = await registerUser('Dup Email', 'dup@example.com');
  const before = [...env.users.values()][0];
  const dup = await authRoutes.register(jsonRequest('/auth/register', { name: 'Impostor', email: 'dup@example.com', password: 'Passw0rd!123' }), env);
  assert.equal(dup.code, 'CONFLICT');
  assert.match(dup.message, /already registered/i);
  assert.equal(env.users.size, 1, 'no second account');
  assert.equal([...env.users.values()][0].password_hash, before.password_hash, 'original untouched');
});

test('duplicate phone registration is rejected (CONFLICT)', async () => {
  const { env } = await registerUser('Dup Phone', 'dupphone@example.com', '+233201112222');
  const dup = await authRoutes.register(jsonRequest('/auth/register', {
    name: 'Other', email: 'other@example.com', password: 'Passw0rd!123', phone: '+233201112222',
  }), env);
  assert.equal(dup.code, 'CONFLICT');
  assert.match(dup.message, /Phone already registered/i);
  assert.equal(env.users.size, 1);
});

test('login by phone works', async () => {
  const { env } = await registerUser('Yaa Asantewaa', 'yaa@example.com', '+233201112222');
  const res = await authRoutes.login(jsonRequest('/auth/login', { identifier: '+233201112222', password: 'Passw0rd!123' }), env);
  assert.ok(!res.code, res.message);
  assert.equal(res.user.email, 'yaa@example.com');
});

test('invalid credentials are rejected without creating a session', async () => {
  const { env } = await registerUser('Wrong Pass', 'wrong@example.com');
  const before = env.sessions.size;
  const bad = await authRoutes.login(jsonRequest('/auth/login', { identifier: 'wrong@example.com', password: 'nope-nope' }), env);
  assert.equal(bad.code, 'UNAUTHORIZED');
  assert.equal(env.sessions.size, before, 'no session created on failure');
  const badUser = await authRoutes.login(jsonRequest('/auth/login', { identifier: 'ghost@example.com', password: 'Passw0rd!123' }), env);
  assert.equal(badUser.code, 'UNAUTHORIZED');
});

// ---------------------------------------------------------------------------
// Access-token expiry + silent refresh (rotation)
// ---------------------------------------------------------------------------

test('access tokens expire; the refresh flow replaces them without re-login', async () => {
  // A 24h access token verifies now…
  const fresh = await generateToken({ userId: 'u1', role: 'user' }, SECRET);
  assert.ok(await verifyAccessToken(fresh, SECRET));
  // …and an EXPIRED access token is rejected (crafted with a past exp).
  const expired = await signJwt({ userId: 'u1', role: 'user' }, SECRET, -60, 'access');
  await assert.rejects(() => verifyAccessToken(expired, SECRET), /EXPIRED/);
  // The fix is the REFRESH flow, not a permanent access token:
  const { env, res } = await registerUser('Expire Test', 'expire@example.com');
  const refreshed = await authRoutes.refresh(jsonRequest('/auth/refresh', { refreshToken: res.refreshToken }), env);
  assert.ok(!refreshed.code, refreshed.message);
  assert.ok(refreshed.token, 'new access token');
  assert.ok(refreshed.refreshToken, 'new (rotated) refresh token');
  assert.notEqual(refreshed.refreshToken, res.refreshToken);
  assert.ok(await verifyAccessToken(refreshed.token, SECRET));
  assert.equal(refreshed.user.email, 'expire@example.com');
});

test('refresh rotates the credential: the old refresh token is dead (replay protection)', async () => {
  const { env, res } = await registerUser('Replay Test', 'replay@example.com');
  const first = await authRoutes.refresh(jsonRequest('/auth/refresh', { refreshToken: res.refreshToken }), env);
  assert.ok(!first.code, first.message);
  // Replaying the ORIGINAL token now fails — it was revoked on rotation.
  const replay = await authRoutes.refresh(jsonRequest('/auth/refresh', { refreshToken: res.refreshToken }), env);
  assert.equal(replay.code, 'INVALID_TOKEN');
  assert.equal(await findLiveSession(env, res.refreshToken), null, 'old credential no longer maps to a live session');
  // And replaying the FIRST rotation's token after a second rotation fails too.
  const second = await authRoutes.refresh(jsonRequest('/auth/refresh', { refreshToken: first.refreshToken }), env);
  assert.ok(!second.code, second.message);
  const replay2 = await authRoutes.refresh(jsonRequest('/auth/refresh', { refreshToken: first.refreshToken }), env);
  assert.equal(replay2.code, 'INVALID_TOKEN');
});

test('rotation preserves the device association and user-agent', async () => {
  const { env, res } = await registerUser('Device Keep', 'device@example.com');
  // Rotate with a DIFFERENT user-agent header — the session's original device
  // identity must survive the rotation (it identifies the device, not the hop).
  const req = new Request('https://api.test/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'some-new-webview/9' },
    body: JSON.stringify({ refreshToken: res.refreshToken }),
  });
  const out = await authRoutes.refresh(req, env);
  assert.ok(!out.code, out.message);
  const live = await findLiveSession(env, out.refreshToken);
  assert.ok(live, 'rotated session is live');
  assert.equal(live.device_id, 'dev-test-1', 'device id preserved across rotation');
  assert.equal(live.user_agent, 'rx-test-agent/1.0', 'original session user-agent preserved');
});

// ---------------------------------------------------------------------------
// PERSISTENCE — the heart of the change
// ---------------------------------------------------------------------------

test('a persistent session has NO 30-day expiry and survives indefinitely', async () => {
  const env = fakeEnv();
  const rt = await generateRefreshToken();
  await createSession(env, { userId: 'u1', refreshToken: rt, deviceId: 'devA' });
  const row = [...env.sessions.values()][0];
  assert.equal(row.expires_at, null, 'no expiry');
  // Simulate "40 days later": NULL is never treated as expired.
  const aged = { ...row, created_at: new Date(Date.now() - 40 * DAY * 1000).toISOString(), last_used_at: new Date(Date.now() - 40 * DAY * 1000).toISOString() };
  assert.equal(sessionIsLive(aged), true, 'persistent session still live after 40 idle days');
  assert.equal(sessionIsLive({ revoked_at: new Date().toISOString(), expires_at: null }), false, 'revoked persistent session is dead');
  assert.equal(sessionIsLive({ expires_at: new Date(Date.now() + DAY * 1000).toISOString() }), true, 'bounded session live before expiry');
  assert.equal(sessionIsLive({ expires_at: new Date(Date.now() - DAY * 1000).toISOString() }), false, 'bounded session dead after expiry');
});

test('refresh works for a session that has been idle longer than the old 30-day limit', async () => {
  const { env, res } = await registerUser('Long Idle', 'idle@example.com');
  // Simulate the device returning 45 days later: the session row (persistent)
  // is untouched; only the in-memory timestamps age.
  for (const s of env.sessions.values()) {
    s.created_at = new Date(Date.now() - 45 * DAY * 1000).toISOString();
    s.last_used_at = new Date(Date.now() - 45 * DAY * 1000).toISOString();
  }
  const out = await authRoutes.refresh(jsonRequest('/auth/refresh', { refreshToken: res.refreshToken }), env);
  assert.ok(!out.code, out.message);
  assert.ok(out.token && out.refreshToken);
});

// ---------------------------------------------------------------------------
// Backward compatibility: the legacy 30-day model
// ---------------------------------------------------------------------------

test('a legacy 30-day session refreshes normally and MIGRATES to persistent', async () => {
  const { env, res } = await registerUser('Legacy User', 'legacy@example.com');
  // Replace the opaque session with a legacy-style one: JWT refresh token +
  // 30-day expires_at — exactly what a pre-migration deployment stored.
  const legacyToken = await legacyRefreshJwt({ userId: res.user.id, role: 'user' }, SECRET, 30 * DAY);
  await createSession(env, { userId: res.user.id, refreshToken: legacyToken, deviceId: 'legacy-dev', userAgent: 'legacy-app/1.0', ttlSeconds: 30 * DAY });
  const out = await authRoutes.refresh(jsonRequest('/auth/refresh', { refreshToken: legacyToken }), env);
  assert.ok(!out.code, out.message);
  // The replacement session is persistent and the legacy token is revoked.
  const live = await findLiveSession(env, out.refreshToken);
  assert.ok(live, 'replacement session live');
  assert.equal(live.expires_at, null, 'replacement session migrated to persistent (no expiry)');
  assert.equal(live.device_id, 'legacy-dev', 'device association migrated');
  assert.equal(await findLiveSession(env, legacyToken), null, 'legacy token revoked after rotation');
});

test('a genuinely expired legacy session is rejected (no resurrection)', async () => {
  const env = fakeEnv();
  const expiredToken = await legacyRefreshJwt({ userId: 'u1', role: 'user' }, SECRET, -3600); // JWT expired an hour ago
  await createSession(env, { userId: 'u1', refreshToken: expiredToken, ttlSeconds: -3600 });  // session expired too
  const out = await authRoutes.refresh(jsonRequest('/auth/refresh', { refreshToken: expiredToken }), env);
  assert.equal(out.code, 'TOKEN_EXPIRED', 'expired legacy JWT reported as expired');
});

test('a legacy session row that expired (but whose JWT has not) is still rejected', async () => {
  const env = fakeEnv();
  const stillValidJwt = await legacyRefreshJwt({ userId: 'u1', role: 'user' }, SECRET, 30 * DAY);
  await createSession(env, { userId: 'u1', refreshToken: stillValidJwt, ttlSeconds: -10 }); // session expired
  const out = await authRoutes.refresh(jsonRequest('/auth/refresh', { refreshToken: stillValidJwt }), env);
  assert.equal(out.code, 'INVALID_TOKEN', 'dead session row → no refresh even with a valid-signature JWT');
});

test('legacy table shape (expires_at NOT NULL) self-heals to nullable', async () => {
  _internal.resetShapeMigrationCache();
  const env = fakeEnv({ legacySessionShape: true });
  assert.ok(env.legacyShape, 'starts legacy');
  // Seed rows exactly as a PRE-migration deployment stored them (direct map
  // writes — createSession would trigger the shape check itself): one live
  // legacy session (30-day expiry in the future), one dead, one revoked.
  const liveRt = await generateRefreshToken();
  const deadRt = await generateRefreshToken();
  const revokedRt = await generateRefreshToken();
  const seed = async (rt: string, expires_at: string | null, revoked_at: string | null) => {
    env.sessions.set(`sess_seed_${rt.slice(4, 12)}`, {
      id: `sess_seed_${rt.slice(4, 12)}`, user_id: 'u1', token_hash: await hashToken(rt),
      device_id: 'legacy-dev', user_agent: 'legacy-app/1.0',
      created_at: new Date().toISOString(), last_used_at: null, expires_at, revoked_at,
    });
  };
  await seed(liveRt, new Date(Date.now() + 30 * DAY * 1000).toISOString(), null);
  await seed(deadRt, new Date(Date.now() - 10 * 1000).toISOString(), null);
  await seed(revokedRt, null, new Date().toISOString());
  // Trigger the self-heal (this is what the Worker does lazily on request).
  await ensureSessionTable(env);
  assert.equal(env.legacyShape, false, 'table upgraded in place');
  // The live legacy session became persistent; dead/revoked ones stay dead.
  const live = await findLiveSession(env, liveRt);
  assert.ok(live, 'live legacy session still live after the rebuild');
  assert.equal(live.expires_at, null, 'live legacy session migrated to persistent');
  assert.equal(await findLiveSession(env, deadRt), null, 'expired legacy session NOT resurrected');
  assert.equal(await findLiveSession(env, revokedRt), null, 'revoked legacy session stays revoked');
  // New sessions created afterwards are persistent.
  const rt2 = await generateRefreshToken();
  await createSession(env, { userId: 'u1', refreshToken: rt2 });
  assert.equal((await findLiveSession(env, rt2))!.expires_at, null);
});

test('shape self-heal falls back to sequential statements when batch is unavailable/failing', async () => {
  _internal.resetShapeMigrationCache();
  const env = fakeEnv({ legacySessionShape: true });
  // Simulate a runtime where batch() rejects (e.g. DDL-in-batch unsupported).
  (env.DB as any).batch = async () => { throw new Error('batch unsupported'); };
  await ensureSessionTable(env);
  assert.equal(env.legacyShape, false, 'sequential fallback completed the rebuild');
});

// ---------------------------------------------------------------------------
// Logout semantics
// ---------------------------------------------------------------------------

test('sign out (current device) revokes ONLY that session — other devices stay signed in', async () => {
  const { env, res } = await registerUser('Multi Device', 'multi@example.com');
  // A second device signs in.
  const laptop = await authRoutes.login(jsonRequest('/auth/login', { identifier: 'multi@example.com', password: 'Passw0rd!123', deviceId: 'devLaptop' }), env);
  assert.ok(!laptop.code, laptop.message);
  // Device A signs out…
  const out = await authRoutes.logout(jsonRequest('/auth/logout', { refreshToken: res.refreshToken }), env);
  assert.ok(out.success);
  assert.equal(out.revoked, 1, 'exactly one session revoked');
  // …Device B is untouched.
  const stillLive = await findLiveSession(env, laptop.refreshToken);
  assert.ok(stillLive, 'laptop session survives the phone signing out');
  assert.equal(stillLive.device_id, 'devLaptop');
  assert.equal(await findLiveSession(env, res.refreshToken), null, 'phone session is gone');
});

test('sign out all devices revokes every session for the account (others unaffected)', async () => {
  const { env, res } = await registerUser('All Devices', 'all@example.com');
  const second = await authRoutes.login(jsonRequest('/auth/login', { identifier: 'all@example.com', password: 'Passw0rd!123', deviceId: 'dev2' }), env);
  const other = await registerUser('Other Person', 'other@example.com');
  const otherLogin = await authRoutes.login(jsonRequest('/auth/login', { identifier: 'other@example.com', password: 'Passw0rd!123', deviceId: 'devOther' }), other.env);
  assert.ok(!otherLogin.code, otherLogin.message);
  const out = await authRoutes.logout(jsonRequest('/auth/logout', { refreshToken: res.refreshToken, allDevices: true }, { userId: res.user.id }), env);
  assert.ok(out.success);
  assert.ok((out.revoked as number) >= 2, `revoked ${out.revoked} sessions`);
  assert.equal(await findLiveSession(env, second.refreshToken), null, 'second device signed out');
  assert.ok(await findLiveSession(other.env, otherLogin.refreshToken), 'a different account is unaffected');
});

test('"sign out all devices" works even when the access token has EXPIRED (no middleware identity)', async () => {
  const { env, res } = await registerUser('Expired All', 'expired-all@example.com');
  const second = await authRoutes.login(jsonRequest('/auth/login', { identifier: 'expired-all@example.com', password: 'Passw0rd!123', deviceId: 'dev2' }), env);
  // NO request.user (access token expired) — the refresh credential must still
  // identify the account so ALL sessions are revoked.
  const out = await authRoutes.logout(jsonRequest('/auth/logout', { refreshToken: res.refreshToken, allDevices: true }), env);
  assert.ok(out.success);
  assert.ok((out.revoked as number) >= 2, `revoked ${out.revoked} sessions, not just the current one`);
  assert.equal(await findLiveSession(env, second.refreshToken), null, 'other device signed out too');
});

test('server-side revocation ends the session (refresh is rejected afterwards)', async () => {
  const { env, res } = await registerUser('Revoked', 'revoked@example.com');
  // Administrative revocation path: revokeAllSessions (what admin uses).
  await revokeAllSessions(env, res.user.id);
  const out = await authRoutes.refresh(jsonRequest('/auth/refresh', { refreshToken: res.refreshToken }), env);
  assert.equal(out.code, 'INVALID_TOKEN');
});

test('administrative session revocation via the admin route signs out every device', async () => {
  const { env, res } = await registerUser('Admin Target', 'target@example.com');
  const phone = await authRoutes.login(jsonRequest('/auth/login', { identifier: 'target@example.com', password: 'Passw0rd!123', deviceId: 'phone' }), env);
  assert.ok(!phone.code, phone.message);
  const req = new Request(`https://api.test/admin/users/${res.user.id}/revoke-sessions`, { method: 'POST' });
  const out = await adminRoutes.revokeUserSessions(req, env);
  assert.ok(out.success, String(out.error));
  assert.ok((out.revoked as number) >= 2);
  assert.equal(await findLiveSession(env, phone.refreshToken), null, 'every device signed out');
  // The account and its installations are untouched — only sessions ended.
  assert.ok(env.users.has(res.user.id), 'account still exists');
});

test('admin password reset revokes all sessions too (security policy)', async () => {
  const { env, res } = await registerUser('Reset Target', 'reset@example.com');
  const req = new Request(`https://api.test/admin/users/${res.user.id}/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'NewPassw0rd!' }),
  });
  const out = await adminRoutes.resetUserPassword(req, env);
  assert.ok(out.success, String(out.error));
  assert.ok((out.revokedSessions as number) >= 1, 'sessions revoked on password reset');
  const after = await authRoutes.refresh(jsonRequest('/auth/refresh', { refreshToken: res.refreshToken }), env);
  assert.equal(after.code, 'INVALID_TOKEN', 'old credential dead after reset');
});

// ---------------------------------------------------------------------------
// Multi-session bookkeeping
// ---------------------------------------------------------------------------

test('an account can hold many concurrent persistent sessions (one per device)', async () => {
  const { env } = await registerUser('Many Devices', 'many@example.com');
  const rts: string[] = [];
  for (let i = 0; i < 4; i++) {
    const rt = await generateRefreshToken();
    await createSession(env, { userId: [...env.users.values()][0].id, refreshToken: rt, deviceId: `dev-${i}` });
    rts.push(rt);
  }
  const listed = await listSessions(env, [...env.users.values()][0].id);
  assert.equal(listed.length, 5, 'register + 4 device sessions');
  for (const rt of rts) assert.ok(await findLiveSession(env, rt));
  // Refreshing ONE device rotates only its own session.
  const refreshed = await authRoutes.refresh(jsonRequest('/auth/refresh', { refreshToken: rts[0] }), env);
  assert.ok(!refreshed.code, refreshed.message);
  for (const rt of rts.slice(1)) assert.ok(await findLiveSession(env, rt), 'other devices unaffected by one device refreshing');
});

test('no refresh token stored in the database — only SHA-256 hashes (opaque model)', async () => {
  const { env, res } = await registerUser('Hash Only', 'hash@example.com');
  for (const s of env.sessions.values()) {
    assert.ok(!s.token_hash.includes(res.refreshToken.slice(4)), 'raw token never persisted');
    assert.match(s.token_hash, /^[0-9a-f]{64}$/, 'SHA-256 hex hash');
  }
});
