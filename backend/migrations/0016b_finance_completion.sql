-- 0016b: Developer finance COMPLETION (idempotent remediation).
--
-- WHY THIS EXISTS: 0016_developer_finance.sql begins with two ALTER TABLE
-- statements (`downloads.kind`, `downloads.country`). When 0016 is re-run on
-- a database where those columns already exist, D1's ATOMIC import rejects
-- the whole file with "duplicate column name" — even when the rest (the
-- tables below) is already present or still missing. This file contains ONLY
-- the CREATE IF NOT EXISTS + seed parts, so it completes any missing piece
-- without ever colliding with existing columns.
--
-- Safe to run ANY number of times, on any state. Never destructive.
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0016b_finance_completion.sql
--
-- If `downloads.country` (or `kind`) is genuinely missing, add it separately:
--   npx wrangler d1 execute rx-store-db --remote --command "ALTER TABLE downloads ADD COLUMN kind TEXT DEFAULT 'install'"
--   npx wrangler d1 execute rx-store-db --remote --command "ALTER TABLE downloads ADD COLUMN country TEXT"
-- (each fails harmlessly with 'duplicate column name' when already present)

CREATE TABLE IF NOT EXISTS developer_billing (
  developer_id TEXT PRIMARY KEY REFERENCES developers(id) ON DELETE CASCADE,
  payout_destination TEXT,             -- masked label only (e.g. "Mobile Money ••1234")
  payout_notes TEXT,
  min_payout_minor INTEGER NOT NULL DEFAULT 10000,   -- GH₵100.00 default minimum
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS developer_payouts (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'GHS',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','PAID','FAILED','HELD','CANCELLED')),
  period_start TEXT,
  period_end TEXT,
  requested_by TEXT NOT NULL,
  processed_by TEXT,
  processor_reference TEXT,
  failure_reason TEXT,
  paid_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_developer_payouts_dev ON developer_payouts(developer_id);
CREATE INDEX IF NOT EXISTS idx_developer_payouts_status ON developer_payouts(status);

-- ADMIN gains billing.manage (kept consistent with the runtime matrix in
-- developerPermissions.ts).
INSERT OR REPLACE INTO developer_roles (role, permissions) VALUES
  ('ADMIN', '["organization.manage","team.manage","app.create","app.edit","release.create","release.edit","package.upload","release.submit","release.publish","analytics.view","reviews.manage","support.respond","billing.manage","security.view"]');
