-- 0007: refresh-token sessions (rotation / expiry / revocation).
--
-- We never store RAW refresh tokens — only their SHA-256 hash. The token itself
-- carries a `jti` (JWT id) so it can be looked up, rotated, and revoked.
--
-- Run once against production D1:
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0007_auth_sessions.sql
-- Safe to re-run (IF NOT EXISTS). The Worker also creates this lazily.

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,                -- sess_<uuid>
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,           -- SHA-256 of the refresh token (never raw)
  device_id TEXT,                     -- stable client device id when provided
  user_agent TEXT,                    -- coarse client hint (truncated)
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_hash ON auth_sessions(token_hash);
