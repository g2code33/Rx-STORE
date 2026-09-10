/**
 * Backend security tests (Prompt 6).
 *
 * Runs under Node's TypeScript stripping (no Cloudflare runtime needed). Pure
 * logic + injected fake D1/KV envs cover: password hashing + migration,
 * JWT validation/expiry/type confusion, refresh rotation/revocation, logout,
 * password reset, CORS allowlist, rate limiting (sliding window), validation,
 * standardized errors, and device/installation ownership scoping.
 *
 * Run: node --experimental-strip-types --test backend/src/security.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, verifyPassword, needsRehash, isLegacyHash, isCurrentHash, legacySha256, timingSafeEqualStr } from './services/password.ts';
import { generateToken, generateRefreshToken, verifyToken, verifyAccessToken, verifyRefreshToken } from './services/auth.ts';
import { createSession, findLiveSession, revokeByToken, revokeAllSessions, hashToken, listSessions } from './services/sessions.ts';
import { isOriginAllowed, corsHeaders, parseAllowedOrigins } from './middleware/cors.ts';
import { evaluateWindow, ruleForPath, rateLimitIdentity } from './middleware/rateLimiter.ts';
import { apiErrorBody, statusForCode, redact, requestIdFor, generateRequestId } from './services/errors.ts';
import { validateEmail, validatePassword, validateId, validatePlatform, validateArchitecture, validateVersion, validateSha256, validateDevicePlatform, validateDeviceType, unexpectedFields } from './utils/validation.ts';
import { devicesRoutes } from './routes/devices.ts';

const SECRET = 'test-secret-please-rotate';

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------
test('hashPassword produces a versioned PBKDF2 hash (never plaintext)', async () => {
  const h = await hashPassword('correct horse battery staple');
  assert.ok(isCurrentHash(h), 'uses the current format');
  assert.ok(!isLegacyHash(h));
  assert.ok(!h.includes('correct horse'), 'never contains the plaintext');
  assert.ok(h.startsWith('pbkdf2$sha256$'));
});

test('verifyPassword accepts the correct password and rejects the wrong one', async () => {
  const h = await hashPassword('S3cure-pass!');
  assert.equal(await verifyPassword('S3cure-pass!', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('', h), false);
});

test('two hashes of the same password differ (per-user salt)', async () => {
  const a = await hashPassword('same-password-123');
  const b = await hashPassword('same-password-123');
  assert.notEqual(a, b);
});

test('legacy static-salt SHA-256 hashes still verify (no lockout) and trigger rehash', async () => {
  const legacy = await legacySha256('LegacyPass1!');
  assert.ok(isLegacyHash(legacy), 'detected as legacy');
  assert.equal(await verifyPassword('LegacyPass1!', legacy), true, 'legacy users can still sign in');
  assert.equal(await verifyPassword('nope', legacy), false);
  assert.equal(needsRehash(legacy), true, 'legacy hash is upgraded on next login');
});

test('current-cost hash does not need rehash', async () => {
  const h = await hashPassword('AnotherPass1!');
  assert.equal(needsRehash(h), false);
});

test('timingSafeEqualStr compares correctly', () => {
  assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
});

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------
test('access token verifies and carries iss/aud/type', async () => {
  const t = await generateToken({ userId: 'u1', role: 'user' }, SECRET);
  const p = await verifyToken(t, SECRET);
  assert.equal(p.userId, 'u1');
  assert.equal(p.iss, 'rx-store-api');
  assert.equal(p.aud, 'rx-store');
  assert.equal(p.tokenType, 'access');
});

test('a refresh token cannot be used as an access token (type confusion)', async () => {
  const r = await generateRefreshToken({ userId: 'u1' }, SECRET);
  await assert.rejects(() => verifyAccessToken(r, SECRET), /WRONG_TYPE/);
  // ...but it verifies as a refresh token.
  const p = await verifyRefreshToken(r, SECRET);
  assert.equal(p.tokenType, 'refresh');
});

test('tokens signed with a different secret are rejected', async () => {
  const t = await generateToken({ userId: 'u1' }, SECRET);
  await assert.rejects(() => verifyToken(t, 'other-secret'), /INVALID_SIGNATURE/);
});

test('malformed tokens are rejected', async () => {
  await assert.rejects(() => verifyToken('not-a-jwt', SECRET), /MALFORMED/);
  await assert.rejects(() => verifyToken('a.b', SECRET), /MALFORMED/);
});

test('alg:none (or any non-HS256 alg) is rejected', async () => {
  // Hand-craft a token with alg=none.
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ userId: 'attacker', exp: Math.floor(Date.now()/1000)+3600 })}.`;
  await assert.rejects(() => verifyToken(forged, SECRET), /BAD_ALG|MALFORMED/);
});

test('expired tokens are rejected', async () => {
  // Sign directly with an expiry in the past by using a tiny TTL trick: craft a
  // valid-signature token via generateToken then assert normal path, and verify
  // expiry rejection using a token whose exp has passed.
  const past = Math.floor(Date.now() / 1000) - 10;
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ userId: 'u1', iss: 'rx-store-api', aud: 'rx-store', tokenType: 'access', exp: past })).toString('base64url');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`)));
  const token = `${header}.${body}.${Buffer.from(sig).toString('base64url')}`;
  await assert.rejects(() => verifyToken(token, SECRET), /EXPIRED/);
});

// ---------------------------------------------------------------------------
// Sessions: refresh rotation, expiry, revocation, logout
// ---------------------------------------------------------------------------
function fakeEnv() {
  const sessions = new Map<string, any>();
  let seq = 0;
  const DB = {
    prepare(sql: string) {
      return {
        _binds: [] as any[],
        bind(...args: any[]) { this._binds = args; return this; },
        async run() {
          const a = this._binds;
          if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX') || sql.includes('CREATE UNIQUE INDEX')) return { meta: { changes: 0 } };
          if (sql.includes('INSERT INTO auth_sessions')) {
            const [id, user_id, token_hash, device_id, user_agent, expires_at] = a;
            sessions.set(id, { id, user_id, token_hash, device_id, user_agent, expires_at, revoked_at: null, created_at: new Date().toISOString(), last_used_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE auth_sessions SET revoked_at=datetime') && sql.includes('token_hash=?')) {
            let n = 0; for (const s of sessions.values()) if (s.token_hash === a[0] && !s.revoked_at) { s.revoked_at = new Date().toISOString(); n++; }
            seq += n; return { meta: { changes: n } };
          }
          if (sql.includes('UPDATE auth_sessions SET revoked_at=datetime') && sql.includes('user_id=?')) {
            let n = 0; for (const s of sessions.values()) if (s.user_id === a[0] && !s.revoked_at) { s.revoked_at = new Date().toISOString(); n++; }
            seq += n; return { meta: { changes: n } };
          }
          if (sql.includes('UPDATE auth_sessions SET last_used_at')) return { meta: { changes: 1 } };
          return { meta: { changes: 0 } };
        },
        async first() {
          const a = this._binds;
          if (sql.includes('WHERE token_hash=? AND revoked_at IS NULL')) {
            for (const s of sessions.values()) if (s.token_hash === a[0] && !s.revoked_at) return s;
          }
          return null;
        },
        async all() {
          const a = this._binds;
          if (sql.includes('FROM auth_sessions WHERE user_id=?')) {
            return { results: [...sessions.values()].filter((s) => s.user_id === a[0] && !s.revoked_at) };
          }
          return { results: [] };
        },
      };
    },
  };
  return { DB, _sessions: sessions };
}

test('refresh token lifecycle: create -> live -> rotate(revoke) -> replay fails', async () => {
  const env = fakeEnv();
  const refresh = await generateRefreshToken({ userId: 'u1' }, SECRET);
  const sid = await createSession(env, { userId: 'u1', refreshToken: refresh, deviceId: 'devA' });
  assert.ok(sid.startsWith('sess_'));

  const live = await findLiveSession(env, refresh);
  assert.ok(live, 'session is live after creation');
  assert.equal(live!.device_id, 'devA');
  assert.ok(live!.token_hash && !live!.token_hash.includes('.'), 'only a hash is stored, never the raw JWT');

  // Rotation revokes the presented token.
  assert.equal(await revokeByToken(env, refresh), true);
  assert.equal(await findLiveSession(env, refresh), null, 'rotated token no longer live (replay defence)');
  assert.equal(await revokeByToken(env, refresh), false, 'revoking twice is a no-op');
});

test('sessions store a SHA-256 hash, never the raw refresh token', async () => {
  const env = fakeEnv();
  const refresh = await generateRefreshToken({ userId: 'u1' }, SECRET);
  await createSession(env, { userId: 'u1', refreshToken: refresh });
  const expectedHash = await hashToken(refresh);
  const rows = [...env._sessions.values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, expectedHash);
  assert.ok(!rows[0].token_hash.includes(refresh.slice(0, 20)), 'raw token is not persisted');
});

test('expired sessions are not live', async () => {
  const env = fakeEnv();
  const refresh = await generateRefreshToken({ userId: 'u1' }, SECRET);
  await createSession(env, { userId: 'u1', refreshToken: refresh, ttlSeconds: -10 });
  assert.equal(await findLiveSession(env, refresh), null);
});

test('revokeAllSessions signs out every device', async () => {
  const env = fakeEnv();
  const r1 = await generateRefreshToken({ userId: 'u1' }, SECRET);
  const r2 = await generateRefreshToken({ userId: 'u1' }, SECRET);
  const r3 = await generateRefreshToken({ userId: 'u2' }, SECRET);
  await createSession(env, { userId: 'u1', refreshToken: r1 });
  await createSession(env, { userId: 'u1', refreshToken: r2 });
  await createSession(env, { userId: 'u2', refreshToken: r3 });
  const n = await revokeAllSessions(env, 'u1');
  assert.equal(n, 2, 'only u1 sessions revoked');
  assert.equal(await findLiveSession(env, r1), null);
  assert.equal(await findLiveSession(env, r2), null);
  assert.ok(await findLiveSession(env, r3), 'another user is unaffected');
});

test('listSessions only returns a user\'s own live sessions', async () => {
  const env = fakeEnv();
  await createSession(env, { userId: 'u1', refreshToken: await generateRefreshToken({ userId: 'u1' }, SECRET) });
  await createSession(env, { userId: 'u2', refreshToken: await generateRefreshToken({ userId: 'u2' }, SECRET) });
  const mine = await listSessions(env, 'u1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].user_id, 'u1');
});

// ---------------------------------------------------------------------------
// CORS allowlist
// ---------------------------------------------------------------------------
test('CORS: exact first-party origins allowed, look-alikes rejected', () => {
  const cfg = { environment: 'production' };
  assert.equal(isOriginAllowed('https://rxstore.com', cfg), true);
  assert.equal(isOriginAllowed('https://www.rxstore.com', cfg), true);
  assert.equal(isOriginAllowed('app://rxstore', cfg), true);
  assert.equal(isOriginAllowed('https://localhost', cfg), true);
  // The previous suffix/includes checks would have allowed all of these:
  assert.equal(isOriginAllowed('https://evilrxstore.com', cfg), false);
  assert.equal(isOriginAllowed('https://rxstore.com.attacker.io', cfg), false);
  assert.equal(isOriginAllowed('https://attacker.pages.dev', cfg), false);
  assert.equal(isOriginAllowed('https://localhost.evil.com', cfg), false);
});

test('CORS: localhost dev origins only outside production', () => {
  assert.equal(isOriginAllowed('http://localhost:5173', { environment: 'development' }), true);
  assert.equal(isOriginAllowed('http://127.0.0.1:8787', { environment: 'development' }), true);
  assert.equal(isOriginAllowed('http://localhost:5173', { environment: 'production' }), false);
});

test('CORS: configured allowlist origins are honored exactly', () => {
  const cfg = { environment: 'production', allowedOrigins: ['https://store.example.com'] };
  assert.equal(isOriginAllowed('https://store.example.com', cfg), true);
  assert.equal(isOriginAllowed('https://evil.example.com', cfg), false);
  assert.deepEqual(parseAllowedOrigins(' https://a.com , https://b.com '), ['https://a.com', 'https://b.com']);
});

test('CORS: disallowed origin is never reflected and credentials are not granted', () => {
  const headers = corsHeaders('https://evil.com', { environment: 'production' }) as Record<string, string>;
  assert.equal(headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(headers['Access-Control-Allow-Credentials'], undefined);
  const ok = corsHeaders('https://rxstore.com', { environment: 'production' }) as Record<string, string>;
  assert.equal(ok['Access-Control-Allow-Origin'], 'https://rxstore.com');
});

// ---------------------------------------------------------------------------
// Rate limiting (sliding window)
// ---------------------------------------------------------------------------
test('sliding window allows up to the limit then blocks, and recovers after the window', () => {
  const rule = { limit: 3, windowSeconds: 60 };
  const now = 1_000_000;
  let hits: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = evaluateWindow(hits, now + i, rule);
    assert.equal(r.allowed, true, `request ${i + 1} allowed`);
    hits = [...r.hits, now + i];
  }
  const blocked = evaluateWindow(hits, now + 10, rule);
  assert.equal(blocked.allowed, false, '4th request blocked');
  // After the window slides past the earliest hits, requests are allowed again.
  const afterWindow = evaluateWindow(hits, now + 61_000, rule);
  assert.equal(afterWindow.allowed, true);
});

test('auth routes have stricter limits than browsing', () => {
  assert.ok(ruleForPath('/auth/login').limit <= 10);
  assert.ok(ruleForPath('/auth/register').limit <= 5);
  assert.ok(ruleForPath('/auth/refresh').limit <= 60);
  assert.ok(ruleForPath('/apps').limit >= 100, 'browsing stays usable');
  assert.ok(ruleForPath('/payments').limit <= 20);
});

test('rate limit identity prefers the authenticated user over IP', () => {
  const req = new Request('https://api.rxstore.com/auth/login');
  assert.equal(rateLimitIdentity(req), 'ip:unknown');
  const authed = new Request('https://api.rxstore.com/apps');
  (authed as any).user = { userId: 'u1' };
  assert.equal(rateLimitIdentity(authed), 'u:u1');
});

// ---------------------------------------------------------------------------
// Standardized errors
// ---------------------------------------------------------------------------
test('error bodies are standardized and carry a requestId', () => {
  const body = apiErrorBody('AUTH_REQUIRED', 'Authentication required', 'req_123');
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'AUTH_REQUIRED');
  assert.equal(body.error.message, 'Authentication required');
  assert.equal(body.error.requestId, 'req_123');
});

test('status codes map correctly', () => {
  assert.equal(statusForCode('AUTH_REQUIRED'), 401);
  assert.equal(statusForCode('FORBIDDEN'), 403);
  assert.equal(statusForCode('VALIDATION_ERROR'), 400);
  assert.equal(statusForCode('NOT_FOUND'), 404);
  assert.equal(statusForCode('RATE_LIMITED'), 429);
  assert.equal(statusForCode('PAYMENTS_NOT_ENABLED'), 501);
  assert.equal(statusForCode('INTERNAL'), 500);
});

test('request ids are generated/propagated and validated', () => {
  assert.ok(generateRequestId().startsWith('req_'));
  const req = new Request('https://api.rxstore.com/health', { headers: { 'X-Request-Id': 'abc-123' } });
  assert.equal(requestIdFor(req), 'abc-123');
  const bad = new Request('https://api.rxstore.com/health', { headers: { 'X-Request-Id': 'bad id with spaces' } });
  assert.notEqual(requestIdFor(bad), 'bad id with spaces');
});

test('redact strips secrets and tokens from log strings', () => {
  const s = redact('Authorization: Bearer eyJhbGciOi.abc.def password: hunter2 apiKey: sk-live-1234567890');
  assert.ok(!s.includes('eyJhbGciOi.abc.def'));
  assert.ok(!s.includes('hunter2'));
  assert.ok(!s.includes('sk-live-1234567890'));
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
test('email validation', () => {
  assert.equal(validateEmail('a@b.co'), true);
  assert.equal(validateEmail('not-an-email'), false);
  assert.equal(validateEmail('a@b'), false);
  assert.equal(validateEmail(''), false);
});

test('password policy rejects weak/short/oversized passwords', () => {
  assert.equal(validatePassword('short1'), false);
  assert.equal(validatePassword('abcdefgh'), false); // 8 chars, letters only
  assert.equal(validatePassword('GoodPass1'), true);
  assert.equal(validatePassword('this-is-a-long-passphrase'), true); // 12+ passphrase allowed
  assert.equal(validatePassword('x'.repeat(300)), false);
});

test('id / platform / architecture / version / checksum validation', () => {
  assert.equal(validateId('dev_abc-123.4:5'), true);
  assert.equal(validateId('bad id!'), false);
  assert.equal(validatePlatform('linux_deb'), true);
  assert.equal(validatePlatform('windows'), true);
  assert.equal(validatePlatform('not-a-platform'), false);
  assert.equal(validateArchitecture('x64'), true);
  assert.equal(validateArchitecture('sparc'), false);
  assert.equal(validateVersion('1.2.3'), true);
  assert.equal(validateVersion('1.3.0-beta.1+build'), true);
  assert.equal(validateVersion('v1'), false);
  assert.equal(validateSha256('a'.repeat(64)), true);
  assert.equal(validateSha256('xyz'), false);
});

test('device platform/type validation', () => {
  assert.equal(validateDevicePlatform('android'), true);
  assert.equal(validateDevicePlatform('symbian'), false);
  assert.equal(validateDeviceType('phone'), true);
  assert.equal(validateDeviceType('server'), false);
});

test('unexpected fields are detected (mass-assignment guard)', () => {
  assert.deepEqual(unexpectedFields({ name: 'a', role: 'admin' }, ['name', 'email']), ['role']);
  assert.deepEqual(unexpectedFields({ name: 'a' }, ['name', 'email']), []);
});

// ---------------------------------------------------------------------------
// Authorization: device + installation ownership
// ---------------------------------------------------------------------------
function deviceEnv() {
  const devices: any[] = [];
  const installs: any[] = [];
  const DB = {
    prepare(sql: string) {
      const self: any = {
        _b: [] as any[],
        bind(...a: any[]) { self._b = a; return self; },
        async run() {
          const a = self._b;
          if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX') || sql.includes('CREATE UNIQUE INDEX')) return { meta: { changes: 0 } };
          if (sql.includes('INSERT INTO devices')) {
            const [id, user_id, device_id] = a;
            const existing = devices.find((d) => d.user_id === user_id && d.device_id === device_id);
            if (existing) return { meta: { changes: 1 } };
            devices.push({ id, user_id, device_id, status: 'active', device_name: a[3], platform: a[4], device_type: a[5], last_seen_at: new Date().toISOString(), created_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE devices SET last_seen_at')) {
            const [ , , user_id, device_id] = a; let n = 0;
            for (const d of devices) if (d.user_id === user_id && d.device_id === device_id && d.status === 'active') { d.last_seen_at = new Date().toISOString(); n++; }
            return { meta: { changes: n } };
          }
          if (sql.includes("UPDATE devices SET status='revoked'")) {
            const [user_id, device_id] = a; let n = 0;
            for (const d of devices) if (d.user_id === user_id && d.device_id === device_id) { d.status = 'revoked'; n++; }
            return { meta: { changes: n } };
          }
          if (sql.includes('INSERT INTO app_installations')) {
            const [, user_id, device_id, application_id] = a;
            const ex = installs.find((i) => i.device_id === device_id && i.application_id === application_id);
            if (ex) { ex.status = a[6]; return { meta: { changes: 1 } }; }
            installs.push({ id: a[0], user_id, device_id, application_id, status: a[6], installed_version: a[5], updated_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          const a = self._b;
          if (sql.includes('FROM devices WHERE user_id=? AND device_id=?')) return devices.find((d) => d.user_id === a[0] && d.device_id === a[1]) || null;
          if (sql.includes('SELECT id FROM applications WHERE slug=?')) return a[0] === 'cgpa-pilot' ? { id: 'app_cgpa' } : null;
          if (sql.includes('FROM app_installations i JOIN applications a')) return installs.find((i) => i.device_id === a[0] && i.application_id === a[1] && i.user_id === a[2]) || null;
          return null;
        },
        async all() {
          const a = self._b;
          if (sql.includes('FROM devices WHERE user_id=?')) return { results: devices.filter((d) => d.user_id === a[0]) };
          if (sql.includes('FROM app_installations i')) return { results: installs.filter((i) => i.user_id === a[0]) };
          return { results: [] };
        },
      };
      return self;
    },
  };
  return { DB, _devices: devices, _installs: installs };
}

const req = (body: any, userId: string | null, url = 'https://api.rxstore.com/devices/register') => {
  const r = new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  if (userId) (r as any).user = { userId };
  return r;
};

test('device registration requires authentication', async () => {
  const env = deviceEnv();
  const out: any = await devicesRoutes.register(req({ deviceId: 'd1' }, null), env);
  assert.equal(out.code, 'UNAUTHORIZED');
});

test('device registration is idempotent per (user, device) — no duplicates', async () => {
  const env = deviceEnv();
  await devicesRoutes.register(req({ deviceId: 'd1', deviceName: 'Phone' }, 'u1'), env);
  await devicesRoutes.register(req({ deviceId: 'd1', deviceName: 'Phone' }, 'u1'), env);
  assert.equal(env._devices.length, 1, 'same user+device upserts a single row');
});

test('the same physical device under two accounts gets separate rows (isolation)', async () => {
  const env = deviceEnv();
  await devicesRoutes.register(req({ deviceId: 'shared-device' }, 'u1'), env);
  await devicesRoutes.register(req({ deviceId: 'shared-device' }, 'u2'), env);
  assert.equal(env._devices.length, 2);
  assert.equal(env._devices.filter((d) => d.user_id === 'u1').length, 1);
  assert.equal(env._devices.filter((d) => d.user_id === 'u2').length, 1);
});

test('device list is user-scoped and flags the current device', async () => {
  const env = deviceEnv();
  await devicesRoutes.register(req({ deviceId: 'd1', platform: 'android' }, 'u1'), env);
  await devicesRoutes.register(req({ deviceId: 'd2', platform: 'windows' }, 'u1'), env);
  await devicesRoutes.register(req({ deviceId: 'd9' }, 'u2'), env);
  const listReq = new Request('https://api.rxstore.com/devices?currentDeviceId=d2');
  (listReq as any).user = { userId: 'u1' };
  const out: any = await devicesRoutes.listDevices(listReq, env);
  assert.equal(out.devices.length, 2, 'only u1 devices');
  const current = out.devices.find((d: any) => d.deviceId === 'd2');
  assert.equal(current.isCurrentDevice, true);
  assert.equal(out.devices.find((d: any) => d.deviceId === 'd1').isCurrentDevice, false);
});

test('one user cannot revoke another user\'s device', async () => {
  const env = deviceEnv();
  await devicesRoutes.register(req({ deviceId: 'victim' }, 'u1'), env);
  const r = new Request('https://api.rxstore.com/devices/victim/revoke', { method: 'POST' });
  (r as any).user = { userId: 'u2' }; // attacker
  const out: any = await devicesRoutes.revokeDevice(r, env);
  assert.equal(out.code, 'NOT_FOUND', 'attacker cannot see/target another user\'s device');
  assert.equal(env._devices[0].status, 'active', 'victim device untouched');
});

test('installation reporting is scoped to the registered device and blocks revoked devices', async () => {
  const env = deviceEnv();
  await devicesRoutes.register(req({ deviceId: 'd1' }, 'u1'), env);
  const rep = (body: any) => req(body, 'u1', 'https://api.rxstore.com/devices/installations');

  const ok: any = await devicesRoutes.reportInstallation(rep({ deviceId: 'd1', appSlug: 'cgpa-pilot', installed: true, installedVersion: '1.0.25', status: 'installed' }), env);
  assert.ok(ok.installation, 'installation recorded');

  // Unknown device for this user is rejected.
  const unknown: any = await devicesRoutes.reportInstallation(rep({ deviceId: 'ghost', appSlug: 'cgpa-pilot', installed: true }), env);
  assert.equal(unknown.code, 'NOT_FOUND');

  // Revoke then attempt to sync -> forbidden.
  const rv = new Request('https://api.rxstore.com/devices/d1/revoke', { method: 'POST' });
  (rv as any).user = { userId: 'u1' };
  await devicesRoutes.revokeDevice(rv, env);
  const blocked: any = await devicesRoutes.reportInstallation(rep({ deviceId: 'd1', appSlug: 'cgpa-pilot', installed: true }), env);
  assert.equal(blocked.code, 'FORBIDDEN', 'revoked device cannot continue synchronizing');
});

test('installation records are user-isolated and idempotent', async () => {
  const env = deviceEnv();
  await devicesRoutes.register(req({ deviceId: 'd1' }, 'u1'), env);
  await devicesRoutes.register(req({ deviceId: 'd2' }, 'u2'), env);
  await devicesRoutes.reportInstallation(req({ deviceId: 'd1', appSlug: 'cgpa-pilot', installed: true }, 'u1', 'https://api.rxstore.com/devices/installations'), env);
  await devicesRoutes.reportInstallation(req({ deviceId: 'd2', appSlug: 'cgpa-pilot', installed: true }, 'u2', 'https://api.rxstore.com/devices/installations'), env);
  // Re-reporting the same device+app does not duplicate.
  await devicesRoutes.reportInstallation(req({ deviceId: 'd1', appSlug: 'cgpa-pilot', installed: true }, 'u1', 'https://api.rxstore.com/devices/installations'), env);
  assert.equal(env._installs.filter((i) => i.user_id === 'u1').length, 1);

  const listReq = new Request('https://api.rxstore.com/devices/installations');
  (listReq as any).user = { userId: 'u1' };
  const out: any = await devicesRoutes.listInstallations(listReq, env);
  assert.equal(out.installations.length, 1, 'no cross-user leakage');
});

test('installation reporting rejects a malformed deviceId/appSlug', async () => {
  const env = deviceEnv();
  const out: any = await devicesRoutes.reportInstallation(req({ deviceId: '', appSlug: '' }, 'u1', 'https://api.rxstore.com/devices/installations'), env);
  assert.equal(out.code, 'VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// Payments must fail closed in production (no free paid access)
// ---------------------------------------------------------------------------
test('payments are refused in production (PAYMENTS_NOT_ENABLED, never grants access)', async () => {
  const { paymentsRoutes } = await import('./routes/payments.ts');
  const env = {
    ENVIRONMENT: 'production',
    DB: { prepare() { throw new Error('DB must not be touched when payments are disabled'); } },
  };
  const req = new Request('https://api.rxstore.com/payments/subscribe', { method: 'POST', body: JSON.stringify({ appId: 'app1', plan: 'pro', paymentMethod: 'paystack' }) });
  (req as any).user = { userId: 'u1' };
  const out: any = await paymentsRoutes.subscribe(req, env);
  assert.equal(out.code, 'PAYMENTS_NOT_ENABLED');
  assert.equal(out.subscription, undefined, 'no subscription is created');
});

test('simulated (non-production) payments are explicitly marked as test only', async () => {
  const { paymentsRoutes } = await import('./routes/payments.ts');
  const writes: any[] = [];
  const env = {
    ENVIRONMENT: 'development',
    DB: {
      prepare(sql: string) {
        return {
          _b: [] as any[],
          bind(...a: any[]) { this._b = a; return this; },
          async first() { return { id: 'app1', name: 'CGPA Pilot', price_amount: 500 }; },
          async run() { writes.push({ sql: sql.slice(0, 40), binds: this._b }); return { meta: { changes: 1 } }; },
          async all() { return { results: [] }; },
        };
      },
    },
  };
  const req = new Request('https://api.rxstore.com/payments/subscribe', { method: 'POST', body: JSON.stringify({ appId: 'app1', plan: 'pro', paymentMethod: 'paystack' }) });
  (req as any).user = { userId: 'u1' };
  const out: any = await paymentsRoutes.subscribe(req, env);
  assert.equal(out.simulated, true);
  assert.equal(out.warning.includes('DEV/TEST ONLY'), true);
  assert.ok(writes.some((w) => w.binds.includes('test')), 'subscription status is marked test, never active');
});
