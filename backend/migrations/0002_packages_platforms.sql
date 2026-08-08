-- 0002: packages — allow every upload platform (linux/linux_deb/linux_appimage/macos/ios)
-- and one binary per (release, platform). Rebuilds the table; existing rows are kept.
-- Run once against production:
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0002_packages_platforms.sql
BEGIN TRANSACTION;
CREATE TABLE IF NOT EXISTS packages_new (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('android','windows','linux','linux_deb','linux_appimage','macos','flatpak','web','ios')),
  architecture TEXT DEFAULT 'x64',
  filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT,
  sha256 TEXT NOT NULL,
  version TEXT NOT NULL,
  deployment_url TEXT,
  package_type TEXT DEFAULT 'installer' CHECK (package_type IN ('installer','pwa','zip','other')),
  status TEXT DEFAULT 'stored' CHECK (status IN ('uploading','validating','stored','ready_for_review','published','failed','archived')),
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(release_id, platform)
);
INSERT OR IGNORE INTO packages_new SELECT * FROM packages;
DROP TABLE packages;
ALTER TABLE packages_new RENAME TO packages;
COMMIT;
