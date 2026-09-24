/**
 * RX Store — refresh-token sessions.
 *
 * A session is the durable, server-side half of a refresh token. We never store
 * the RAW token: only its SHA-256 hash. Sessions are PERSISTENT by default:
 * `expires_at` is NULL, which means the session has no expiry at all — it ends
 * ONLY when it is revoked (explicit sign-out, "sign out all devices", password
 * reset, or administrative revocation). A live session means:
 *
 *     revoked_at IS NULL  AND  (expires_at IS NULL OR expires_at > now)
 *
 * NULL is NEVER treated as expired.
 *
 * Lifecycle:
 *   create   — on login/register (persistent, one per device id when provided)
 *   verify   — hash the presented token, match an unrevoked, unexpired session
 *   rotate   — revoke the old session and issue a new one (replay defence);
 *              the replacement keeps the original device + user-agent and is
 *              again persistent
 *   revoke   — current session logout
 *   revokeAll— "sign out all devices" (does NOT touch app installations)
 *
 * Backward compatibility: sessions created under the previous 30-day model
 * (expires_at NOT NULL) remain valid until their original expiry; any refresh
 * migrates them to a persistent replacement. `ensureSessionTable` upgrades the
 * table shape in place (nullable expires_at) so no manual migration is strictly
 * required, matching the project's lazy-migration convention. Migration
 * 0018_persistent_sessions.sql performs the same upgrade for production D1.
 */

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  device_id?: string | null;
  user_agent?: string | null;
  created_at?: string;
  last_used_at?: string;
  /** NULL = persistent session (no expiry). */
  expires_at?: string | null;
  revoked_at?: string | null;
}

/** SHA-256 (hex) of a refresh token — what we actually persist. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token || '')));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The session table, current (persistent-capable) shape. */
const SESSION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS auth_sessions (
   id TEXT PRIMARY KEY,
   user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   token_hash TEXT NOT NULL,
   device_id TEXT,
   user_agent TEXT,
   created_at TEXT DEFAULT (datetime('now')),
   last_used_at TEXT,
   expires_at TEXT,
   revoked_at TEXT
 )`;

const SESSION_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_hash ON auth_sessions(token_hash)',
];

/**
 * Live-session predicate shared by SQL and JS: revoked → dead; NULL expiry →
 * persistent/live; explicit expiry → live only while in the future.
 */
export function sessionIsLive(row: { revoked_at?: string | null; expires_at?: string | null }): boolean {
  if (row?.revoked_at) return false;
  if (!row?.expires_at) return true; // NULL expires_at = persistent session
  return new Date(row.expires_at).getTime() > Date.now();
}

/** One rebuild per isolate, ever — concurrent callers await the same promise. */
let shapeMigration: Promise<void> | null = null;

/**
 * Run the rebuild statements ATOMICALLY when the runtime supports it (D1
 * `batch` wraps statements in one transaction — no mid-rebuild window), with a
 * sequential fallback for environments without batch.
 */
async function runRebuildStatements(env: any, statements: string[]): Promise<void> {
  if (typeof env.DB?.batch === 'function') {
    try {
      await env.DB.batch(statements.map((s: string) => env.DB.prepare(s)));
      return;
    } catch { /* fall through to sequential execution */ }
  }
  for (const s of statements) await env.DB.prepare(s).run();
}

/**
 * Upgrade a legacy `auth_sessions` table (expires_at TEXT NOT NULL) to the
 * persistent-session shape (expires_at nullable) in place. Live sessions are
 * migrated to persistent (expires_at NULL); already-expired/revoked rows keep
 * their original timestamps. Rename-dance because SQLite cannot ALTER a column
 * constraint. Safe to re-run; a no-op on the current shape.
 */
async function upgradeTableShape(env: any): Promise<void> {
  const master: any = await env.DB.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='auth_sessions'`
  ).first().catch(() => null);
  const sql = String(master?.sql || '');
  if (!sql || !/expires_at\s+TEXT\s+NOT\s+NULL/i.test(sql)) return; // already current shape
  await runRebuildStatements(env, [
    `DROP TABLE IF EXISTS auth_sessions_rebuild`,
    `CREATE TABLE auth_sessions_rebuild (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       token_hash TEXT NOT NULL,
       device_id TEXT,
       user_agent TEXT,
       created_at TEXT DEFAULT (datetime('now')),
       last_used_at TEXT,
       expires_at TEXT,
       revoked_at TEXT
     )`,
    `INSERT INTO auth_sessions_rebuild (id, user_id, token_hash, device_id, user_agent, created_at, last_used_at, expires_at, revoked_at)
     SELECT id, user_id, token_hash, device_id, user_agent, created_at, last_used_at,
            CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
                 THEN NULL ELSE expires_at END,
            revoked_at
     FROM auth_sessions`,
    `DROP TABLE auth_sessions`,
    `ALTER TABLE auth_sessions_rebuild RENAME TO auth_sessions`,
  ]);
  for (const idx of SESSION_INDEXES) await env.DB.prepare(idx).run().catch(() => {});
}

export async function ensureSessionTable(env: any): Promise<void> {
  await env.DB.prepare(SESSION_TABLE_SQL).run().catch(() => {});
  for (const idx of SESSION_INDEXES) await env.DB.prepare(idx).run().catch(() => {});
  // Self-heal the legacy shape once per isolate. Failure is non-fatal: the
  // numbered migration (0018) performs the same upgrade out of band.
  if (!shapeMigration) {
    shapeMigration = upgradeTableShape(env).catch(() => {});
  }
  await shapeMigration;
}

/**
 * Create a session for a freshly-issued refresh token. Returns the session id.
 * PERSISTENT by default (expires_at NULL — the session lives until revoked).
 * `ttlSeconds` is still honoured when explicitly supplied (legacy tests /
 * bounded sessions) but is no longer the normal path.
 */
export async function createSession(env: any, input: {
  userId: string;
  refreshToken: string;
  deviceId?: string;
  userAgent?: string;
  ttlSeconds?: number | null;
}): Promise<string> {
  await ensureSessionTable(env);
  const id = `sess_${crypto.randomUUID()}`;
  const tokenHash = await hashToken(input.refreshToken);
  const expiresAt = input.ttlSeconds != null
    ? new Date(Date.now() + input.ttlSeconds * 1000).toISOString()
    : null; // persistent: no expiry, only revocation ends it
  await env.DB.prepare(
    `INSERT INTO auth_sessions (id, user_id, token_hash, device_id, user_agent, created_at, last_used_at, expires_at)
     VALUES (?,?,?,?,?,datetime('now'),datetime('now'),?)`
  ).bind(id, input.userId, tokenHash, input.deviceId || null, String(input.userAgent || '').slice(0, 300) || null, expiresAt).run();
  return id;
}

/**
 * Look up the live (unrevoked, unexpired — or persistent) session for a
 * presented refresh token. Works for BOTH current opaque tokens and legacy
 * JWT refresh tokens, because both are matched by their SHA-256 hash.
 */
export async function findLiveSession(env: any, refreshToken: string): Promise<SessionRow | null> {
  await ensureSessionTable(env);
  const tokenHash = await hashToken(refreshToken);
  const row: any = await env.DB.prepare(
    `SELECT * FROM auth_sessions WHERE token_hash=? AND revoked_at IS NULL`
  ).bind(tokenHash).first().catch(() => null);
  if (!row) return null;
  if (!sessionIsLive(row)) return null;
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

/** @internal test-only: forget the per-isolate shape-migration guard so a new
 *  fake environment can exercise the legacy→persistent upgrade again. */
export const _internal = {
  resetShapeMigrationCache(): void {
    shapeMigration = null;
  },
};
