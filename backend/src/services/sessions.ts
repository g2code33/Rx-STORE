/**
 * RX Store — refresh-token sessions.
 *
 * A session is the durable, server-side half of a refresh token. We never store
 * the RAW token: only its SHA-256 hash. The token itself carries a `jti` so it
 * can be looked up, rotated, and revoked.
 *
 * Lifecycle:
 *   create   — on login/register (one session per device id when provided)
 *   verify   — hash the presented token, match an unexpired, unrevoked session
 *   rotate   — revoke the old session and issue a new one (replay defence)
 *   revoke   — current session logout
 *   revokeAll— "sign out all devices" (does NOT touch app installations)
 *
 * The table is created lazily (idempotent) so no manual migration is required,
 * matching the project's existing convention.
 */

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  device_id?: string | null;
  user_agent?: string | null;
  created_at?: string;
  last_used_at?: string;
  expires_at?: string;
  revoked_at?: string | null;
}

/** SHA-256 (hex) of a refresh token — what we actually persist. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token || '')));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function ensureSessionTable(env: any): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS auth_sessions (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       token_hash TEXT NOT NULL,
       device_id TEXT,
       user_agent TEXT,
       created_at TEXT DEFAULT (datetime('now')),
       last_used_at TEXT,
       expires_at TEXT NOT NULL,
       revoked_at TEXT
     )`
  ).run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)').run().catch(() => {});
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_hash ON auth_sessions(token_hash)').run().catch(() => {});
}

/**
 * Create a session for a freshly-issued refresh token. Returns the session id.
 * `ttlSeconds` defaults to 30 days to match the refresh token lifetime.
 */
export async function createSession(env: any, input: {
  userId: string;
  refreshToken: string;
  deviceId?: string;
  userAgent?: string;
  ttlSeconds?: number;
}): Promise<string> {
  await ensureSessionTable(env);
  const id = `sess_${crypto.randomUUID()}`;
  const tokenHash = await hashToken(input.refreshToken);
  const ttl = input.ttlSeconds ?? 30 * 24 * 60 * 60;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO auth_sessions (id, user_id, token_hash, device_id, user_agent, created_at, last_used_at, expires_at)
     VALUES (?,?,?,?,?,datetime('now'),datetime('now'),?)`
  ).bind(id, input.userId, tokenHash, input.deviceId || null, String(input.userAgent || '').slice(0, 300) || null, expiresAt).run();
  return id;
}

/** Look up a live (unrevoked, unexpired) session for a presented refresh token. */
export async function findLiveSession(env: any, refreshToken: string): Promise<SessionRow | null> {
  await ensureSessionTable(env);
  const tokenHash = await hashToken(refreshToken);
  const row: any = await env.DB.prepare(
    `SELECT * FROM auth_sessions WHERE token_hash=? AND revoked_at IS NULL`
  ).bind(tokenHash).first().catch(() => null);
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  return row as SessionRow;
}

/** Revoke a single session by id (idempotent). */
export async function revokeSession(env: any, sessionId: string): Promise<boolean> {
  await ensureSessionTable(env);
  const res: any = await env.DB.prepare(
    `UPDATE auth_sessions SET revoked_at=datetime('now') WHERE id=? AND revoked_at IS NULL`
  ).bind(sessionId).run().catch(() => ({ meta: { changes: 0 } }));
  return (res?.meta?.changes || 0) > 0;
}

/** Revoke the session matching a presented refresh token (logout). */
export async function revokeByToken(env: any, refreshToken: string): Promise<boolean> {
  await ensureSessionTable(env);
  const tokenHash = await hashToken(refreshToken);
  const res: any = await env.DB.prepare(
    `UPDATE auth_sessions SET revoked_at=datetime('now') WHERE token_hash=? AND revoked_at IS NULL`
  ).bind(tokenHash).run().catch(() => ({ meta: { changes: 0 } }));
  return (res?.meta?.changes || 0) > 0;
}

/** Revoke every session for a user ("sign out all devices"). */
export async function revokeAllSessions(env: any, userId: string): Promise<number> {
  await ensureSessionTable(env);
  const res: any = await env.DB.prepare(
    `UPDATE auth_sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL`
  ).bind(userId).run().catch(() => ({ meta: { changes: 0 } }));
  return res?.meta?.changes || 0;
}

/** Mark a session as used (rotation is handled by revoke + create). */
export async function touchSession(env: any, sessionId: string): Promise<void> {
  await env.DB.prepare(`UPDATE auth_sessions SET last_used_at=datetime('now') WHERE id=?`).bind(sessionId).run().catch(() => {});
}

/** List a user's active sessions (for a "your devices/sessions" view). */
export async function listSessions(env: any, userId: string): Promise<SessionRow[]> {
  await ensureSessionTable(env);
  const rows: any = await env.DB.prepare(
    `SELECT id, user_id, device_id, user_agent, created_at, last_used_at, expires_at
     FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY last_used_at DESC`
  ).bind(userId).all().catch(() => ({ results: [] }));
  return rows.results || [];
}
