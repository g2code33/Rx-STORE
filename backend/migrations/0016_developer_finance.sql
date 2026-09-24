-- 0016: Developer analytics, revenue & payouts (Phase 19).
--
-- Financial + analytics layer over REAL marketplace data (downloads,
-- app_installations, reviews, Phase 18 purchases). Aggregated reporting only —
-- developers NEVER see individual customer payment information.
--
--   downloads.kind       'install' (first download by a user) | 'update' —
--                        derived server-side from prior download history
--   downloads.country    country-level geo (Cloudflare request metadata);
--                        privacy-safe: country only, never finer
--   developer_billing    per-org payout destination + minimum payout
--                        (OWNER/billing-manage only; masked for others)
--   developer_payouts    payout records: PENDING/PROCESSING/PAID/FAILED/HELD/
--                        CANCELLED, amounts, period, processor reference
--
-- ADMIN role gains billing.manage (Phase 19: "OWNER/authorized ADMIN should
-- control financial settings"); DEVELOPER/ANALYST/SUPPORT keep NO billing
-- access (enforced server-side by requirePermission).
--
-- Run once (ALTERs fail harmlessly with 'duplicate column name' if re-run):
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0016_developer_finance.sql

ALTER TABLE downloads ADD COLUMN kind TEXT DEFAULT 'install';
ALTER TABLE downloads ADD COLUMN country TEXT;

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

-- ADMIN gains billing.manage (the TS matrix in developerPermissions.ts is the
-- runtime source; this keeps the seeded DB row consistent).
INSERT OR REPLACE INTO developer_roles (role, permissions) VALUES
  ('ADMIN', '["organization.manage","team.manage","app.create","app.edit","release.create","release.edit","package.upload","release.submit","release.publish","analytics.view","reviews.manage","support.respond","billing.manage","security.view"]');
