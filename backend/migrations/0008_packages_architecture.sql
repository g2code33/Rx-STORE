-- 0008: packages — architecture-aware uniqueness + OS compatibility metadata.
--
-- WHY: the previous constraint was UNIQUE(release_id, platform) (migration 0002),
-- which prevents shipping more than ONE architecture for the same platform
-- (e.g. Windows x64 AND Windows arm64, or Android arm64-v8a AND universal).
--
-- This migration rebuilds `packages` with:
--   UNIQUE(release_id, platform, architecture)
-- plus optional compatibility metadata:
--   min_os_version  TEXT      (e.g. "10.0.19041" for Windows, "8.0" for Android)
--   min_android_sdk INTEGER   (e.g. 24)
--
-- NON-DESTRUCTIVE: every existing row is copied forward. Existing rows have no
-- architecture value, so they are normalized to 'x64' (the previous hard-coded
-- value) before the copy — this means the migration is a no-op behaviourally for
-- single-architecture releases.
--
-- D1 CAVEAT: dropping a table drops its indexes, so `idx_packages_*` are
-- recreated AFTER the rename (the old indexes no longer exist by then).
--
-- PRE-FLIGHT (deployments whose `packages` table predates this repo's schema):
-- This migration copies these columns from the OLD table: id, application_id,
-- release_id, platform, architecture, filename, storage_key, file_size,
-- mime_type, sha256, version, deployment_url, package_type, status,
-- deleted_at, created_at. Older deployments may lack `deleted_at` (and
-- possibly `created_at`), which fails the copy with
-- "no such column: deleted_at". Check your real table first:
--   npx wrangler d1 execute rx-store-db --remote --command "SELECT sql FROM sqlite_master WHERE name='packages';"
-- If a column is missing, add it BEFORE running this file (one command at a
-- time; a "duplicate column name" error just means it already exists):
--   ALTER TABLE packages ADD COLUMN deleted_at TEXT;
--   ALTER TABLE packages ADD COLUMN created_at TEXT;
-- (SQLite only allows constant defaults in ADD COLUMN; NULL is fine — both
-- columns are nullable in packages_new.)
--
-- Run EXACTLY ONCE against production:
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0008_packages_architecture.sql
--
-- RE-RUN WARNING: rows are copied forward before the old table is dropped, so
-- an accidental re-run does not lose package rows — BUT the copy cannot include
-- min_os_version / min_android_sdk (those columns do not exist in the OLD
-- packages table this migration converts from), so a re-run would reset any
-- values set after the first run to NULL. Take a backup first
-- (`npx wrangler d1 export rx-store-db --remote --output=backup.sql`), run
-- once, and verify the row count is unchanged afterwards.

-- SQLite cannot drop the old UNIQUE(release_id, platform) auto-index in place,
-- so the table is rebuilt: create new -> copy rows -> drop old -> rename.
CREATE TABLE IF NOT EXISTS packages_new (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('android','windows','linux','linux_deb','linux_appimage','flatpak','macos','web','ios','pwa')),
  architecture TEXT NOT NULL DEFAULT 'x64',
  filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT,
  sha256 TEXT NOT NULL,
  version TEXT NOT NULL,
  deployment_url TEXT,
  package_type TEXT DEFAULT 'installer' CHECK (package_type IN ('installer','pwa','zip','other')),
  min_os_version TEXT,
  min_android_sdk INTEGER,
  status TEXT DEFAULT 'stored' CHECK (status IN ('uploading','validating','stored','ready_for_review','published','failed','archived')),
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(release_id, platform, architecture)
);

-- Copy existing rows forward, normalizing a missing architecture to 'x64' so the
-- previous single-arch behaviour is preserved exactly.
INSERT OR IGNORE INTO packages_new (
  id, application_id, release_id, platform, architecture, filename, storage_key,
  file_size, mime_type, sha256, version, deployment_url, package_type, status, deleted_at, created_at
)
SELECT
  id, application_id, release_id, platform,
  COALESCE(NULLIF(TRIM(architecture), ''), 'x64'),
  filename, storage_key, file_size, mime_type, sha256, version, deployment_url,
  package_type, status, deleted_at, created_at
FROM packages;

DROP TABLE packages;
ALTER TABLE packages_new RENAME TO packages;

CREATE INDEX IF NOT EXISTS idx_packages_release ON packages(release_id);
CREATE INDEX IF NOT EXISTS idx_packages_platform ON packages(platform);
CREATE INDEX IF NOT EXISTS idx_packages_arch ON packages(architecture);
