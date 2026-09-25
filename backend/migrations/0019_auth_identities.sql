-- 0019: OAuth secondary authentication (Google + GitHub).
--
-- Two NEW tables only — `users` and every existing row/session/device/installation
-- remain UNTOUCHED (fully backward compatible).
--
-- auth_identities: the provider-identity relationship.
--   * The PROVIDER SUBJECT is the authoritative identity key (Google `sub`,
--     GitHub immutable numeric user id) — NEVER the email, NEVER the username.
--   * UNIQUE (provider, provider_subject): one provider identity = one account.
--   * An account may have many identities (Google + GitHub + password).
--   * Provider access tokens are deliberately NOT stored (no product need).
--
-- oauth_tokens: short-lived, single-use, hashed one-time tokens for the OAuth
--   state / completion codes / linking tokens / linking intents. Single-use is
--   enforced ATOMICALLY (UPDATE ... WHERE consumed_at IS NULL + changes>0), so
--   state replay and code replay cannot race. Rows are lazily purged.
--
-- Run against production D1 (documented in docs/DATABASE.md):
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0019_auth_identities.sql
-- Safe to re-run (IF NOT EXISTS). Never destructive.

CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY,                     -- ident_<uuid>
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','github')),
  provider_subject TEXT NOT NULL,          -- Google `sub` / GitHub immutable user id
  provider_email TEXT,                     -- informational snapshot (NOT the identity key)
  provider_email_verified INTEGER DEFAULT 0,
  display_name TEXT,
  avatar_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT,
  last_login_at TEXT,
  UNIQUE (provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_identities_provider_subject ON auth_identities(provider, provider_subject);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,                     -- otk_<uuid>
  kind TEXT NOT NULL CHECK (kind IN ('state','code','link','intent')),
  token_hash TEXT NOT NULL,                -- SHA-256 of the raw token (never the raw token)
  payload TEXT NOT NULL DEFAULT '{}',      -- JSON, bound to this attempt
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,                -- short-lived (10 minutes)
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_hash ON oauth_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens(expires_at);
