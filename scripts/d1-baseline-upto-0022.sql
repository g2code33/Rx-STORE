-- d1-baseline-upto-0022.sql — tell wrangler's migration ledger about work
-- that is ALREADY in the database.
--
-- WHY: migrations 0002–0022 were applied to production with
-- `wrangler d1 execute --file=…`, which does NOT write to wrangler's
-- `d1_migrations` table. A later `wrangler d1 migrations apply` therefore sees
-- an empty ledger and tries to re-run ALL of them — including 0002, a table
-- rebuild that starts with BEGIN TRANSACTION (rejected by the D1 API, error
-- 7500 on the Durable Object backend).
--
-- WHAT THIS DOES: creates the ledger if missing and marks 0002–0022 as applied.
-- It does NOT touch your schema. Safe to run more than once (INSERT OR IGNORE).
--
-- AFTER THIS: `wrangler d1 migrations apply rx-store-db --remote` will only
-- consider 0023 and later.
--
-- Run:
--   cd ~/Documents/Rx-STORE/backend
--   npx wrangler d1 execute rx-store-db --remote --file=../scripts/d1-baseline-upto-0022.sql

CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES
 ('0002_packages_platforms.sql'),
 ('0003_fast_ai_model.sql'),
 ('0004_applications_columns.sql'),
 ('0005_native_app_identity.sql'),
 ('0005b_site_settings.sql'),
 ('0006_devices_installations.sql'),
 ('0007_auth_sessions.sql'),
 ('0008_packages_architecture.sql'),
 ('0009_developer_platform.sql'),
 ('0010_developer_releases.sql'),
 ('0011_package_security.sql'),
 ('0012_submissions_review.sql'),
 ('0013_storefront.sql'),
 ('0014_ratings_reviews.sql'),
 ('0015_payments_entitlements.sql'),
 ('0016_developer_finance.sql'),
 ('0016b_finance_completion.sql'),
 ('0017_developer_community.sql'),
 ('0018_persistent_sessions.sql'),
 ('0019_auth_identities.sql'),
 ('0020_admin_inbox.sql'),
 ('0021_scanner_workflow.sql'),
 ('0022_manual_review.sql');
