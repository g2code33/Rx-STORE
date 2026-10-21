-- d1-state-check.sql — READ ONLY. What does production actually have?
-- Run: cd backend && npx wrangler d1 execute rx-store-db --remote --file=../scripts/d1-state-check.sql

-- w: how many migrations wrangler THINKS are applied (empty table = ledger lost)
SELECT 'migrations recorded' AS item, COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='d1_migrations';
SELECT 'migrations applied' AS item, COUNT(*) AS n FROM d1_migrations;

-- GitHub integration tables (0023 creates these; the Worker also lazily creates them)
SELECT 'github tables present (of 5)' AS item, COUNT(*) AS n
  FROM sqlite_master WHERE type='table' AND name IN
  ('github_repo_connections','github_release_events','github_releases','github_release_assets','github_audit_log');

-- 0023 columns on packages
SELECT 'packages.provider/external_url/github_asset_id (of 3)' AS item, COUNT(*) AS n
  FROM pragma_table_info('packages') WHERE name IN ('provider','external_url','github_asset_id');

-- 0024 column on notifications
SELECT 'notifications.section (0 or 1)' AS item, COUNT(*) AS n
  FROM pragma_table_info('notifications') WHERE name='section';

-- 0024 admin events table
SELECT 'admin_events table (0 or 1)' AS item, COUNT(*) AS n
  FROM sqlite_master WHERE type='table' AND name='admin_events';

-- 0026 column on github_releases
SELECT 'github_releases.ignored_assets (0 or 1)' AS item, COUNT(*) AS n
  FROM pragma_table_info('github_releases') WHERE name='ignored_assets';
