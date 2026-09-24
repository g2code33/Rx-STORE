-- 0015: Production marketplace payments, entitlements & ownership (Phase 18).
--
-- Canonical commercial model (the legacy payments/subscriptions tables stay
-- for history; the new tables are authoritative):
--
--   purchases          one per payment attempt (provider reference UNIQUE)
--                      status: pending | complete | failed | refunded
--   entitlements       what a user owns (UNIQUE(user_id, app_id))
--                      status: PENDING | ACTIVE | REFUNDED | REVOKED | EXPIRED
--   webhook_events     provider webhook idempotency ledger (UNIQUE(provider, event_key))
--                      replay/duplicate protection for webhook processing
--   download_grants    short-lived download authorization (token stored as
--                      SHA-256; expires; never a permanent private URL)
--
-- Run once (CREATEs are IF NOT EXISTS):
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0015_payments_entitlements.sql

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,            -- minor units (pesewas/cents), never floats
  currency TEXT NOT NULL DEFAULT 'GHS',
  provider TEXT NOT NULL,             -- 'paystack' | 'dev-sim'
  provider_reference TEXT UNIQUE,     -- our reference sent to the provider
  provider_transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','failed','refunded')),
  failure_reason TEXT,
  refunded_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_app ON purchases(app_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);

CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  purchase_id TEXT REFERENCES purchases(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  provider_transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','REFUNDED','REVOKED','EXPIRED')),
  activated_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT,
  refunded_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, app_id)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_user ON entitlements(user_id);
CREATE INDEX IF NOT EXISTS idx_entitlements_app ON entitlements(app_id);
CREATE INDEX IF NOT EXISTS idx_entitlements_status ON entitlements(status);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,            -- provider event id, or type+reference fallback
  event_type TEXT,
  payload TEXT,                       -- sanitized: never contains card data
  status TEXT NOT NULL DEFAULT 'processed' CHECK (status IN ('received','processed','ignored','failed')),
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(provider, event_key)
);

CREATE TABLE IF NOT EXISTS download_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  package_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,    -- SHA-256 of the issued token
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_download_grants_user ON download_grants(user_id);
