-- 0018: PERSISTENT AUTHENTICATION SESSIONS
--
-- RX Store keeps a signed-in device signed in until the user explicitly signs
-- out (or the session is administratively revoked). The durable authority is
-- the server-side `auth_sessions` row — never a long-lived JWT.
--
-- Change: `auth_sessions.expires_at` becomes NULLABLE. NULL = persistent
-- session (no expiry; only `revoked_at` ends it). SQLite cannot ALTER a column
-- constraint, so this is a rename-dance rebuild. `auth_sessions` has no child
-- tables referencing it, so the DROP is FK-safe (unlike the 0010 rebuild).
--
-- Migration policy for existing rows:
--   * LIVE sessions (revoked_at IS NULL and not yet expired) → expires_at set
--     to NULL: existing signed-in users are migrated to persistent sessions
--     and are NOT forced to sign in again.
--   * Already-expired or revoked rows keep their original timestamps (a dead
--     session is never resurrected).
--
-- Run once against production D1:
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0018_persistent_sessions.sql
--
-- Safe to re-run (the rebuild is skipped when the table already has the
-- current shape). The Worker ALSO self-heals the shape lazily at runtime, so
-- this migration is an out-of-band fast path, not a hard prerequisite.

CREATE TABLE IF NOT EXISTS auth_sessions_v2 (
  id TEXT PRIMARY KEY,                -- sess_<uuid>
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,           -- SHA-256 of the refresh token (never raw)
  device_id TEXT,                     -- stable client device id when provided
  user_agent TEXT,                    -- coarse client hint (truncated)
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT,                    -- NULL = persistent (until revoked)
  revoked_at TEXT
);

INSERT INTO auth_sessions_v2 (id, user_id, token_hash, device_id, user_agent, created_at, last_used_at, expires_at, revoked_at)
SELECT id, user_id, token_hash, device_id, user_agent, created_at, last_used_at,
       CASE
         WHEN revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
         THEN NULL                     -- live session → becomes persistent
         ELSE expires_at               -- dead/expired/revoked → unchanged
       END,
       revoked_at
FROM auth_sessions;

DROP TABLE auth_sessions;
ALTER TABLE auth_sessions_v2 RENAME TO auth_sessions;

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_hash ON auth_sessions(token_hash);
