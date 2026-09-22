-- 0010 (v2 — FK-SAFE REBUILD): Developer release lifecycle (Phase 12).
--
-- WHY v2 EXISTS: the original 0010 rebuilt `applications` and `releases` with
-- CREATE-new -> copy -> DROP-old -> RENAME. On databases with legacy child
-- tables that reference applications/releases WITHOUT ON DELETE CASCADE
-- (downloads, reviews, subscriptions, app_versions, ...), the DROP performs
-- an implicit DELETE of the parent and D1 raises
-- "FOREIGN KEY constraint failed" — the whole import rolls back (this is
-- exactly what happened on production). PRAGMA foreign_keys=OFF is a no-op
-- inside D1's atomic import, and PRAGMA defer_foreign_keys fails at commit
-- (both verified locally against SQLite).
--
-- THE FIX — rename dance (never drops a referenced table):
--   1. create *_new, copy rows
--   2. ALTER TABLE <old> RENAME TO <old>_shadow   (children's REFERENCES are
--      rewritten to the shadow name — SQLite does this automatically — so
--      nothing dangles and no implicit delete ever runs)
--   3. ALTER TABLE *_new RENAME TO <live name>
--   4. tables whose full DDL is known (packages, developer_submissions,
--      developer_submission_events, package_security_results,
--      package_security_overrides, storefront_featured) are rebuilt the same
--      way to point at the live parents again; their _v0 leftovers are then
--      dropped (nothing references them anymore).
--   5. LEGACY child tables with unknown DDL keep pointing at
--      applications_shadow / releases_shadow. The shadows are kept forever
--      and kept IN SYNC by triggers on the live tables, so FK enforcement
--      for those children stays fully functional (new apps/releases appear
--      in the shadows automatically).
--
-- REQUIRED PRIOR STATE (exactly production's state when this was written):
--   0009 applied (developer_org_id exists), 0011/0012/0013 applied
--   (packages has quarantine_key/security_state/overall_security;
--    applications has privacy_url/support_url/video_url;
--    developer_threads.related_submission_id exists), and this migration has
--   never succeeded before. A re-run after success fails loudly at the first
--   rename ("there is already another table named applications_shadow") and
--   rolls back atomically — that is intentional.
--
-- Run once against production:
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0010_developer_releases.sql
--
-- AFTER SUCCESS, verify integrity:
--   npx wrangler d1 execute rx-store-db --remote --command "PRAGMA foreign_key_check"
--   (must return no rows)
--
-- FUTURE CLEANUP (optional, needs each legacy table's exact DDL): rebuild the
-- legacy children to reference the live tables, then drop the shadows and the
-- six *_shadow_sync triggers.

-- ===========================================================================
-- PHASE A — applications (status CHECK extended with the developer lifecycle)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS applications_new (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  long_description TEXT,
  category TEXT NOT NULL CHECK (category IN ('healthcare','education','productivity','technology','gaming','social')),
  tags TEXT DEFAULT '[]',
  developer TEXT DEFAULT 'Calcitonin Technologies',
  developer_id TEXT REFERENCES users(id),
  icon TEXT,
  color TEXT,
  gradient TEXT,
  screenshots TEXT DEFAULT '[]',
  status TEXT DEFAULT 'active' CHECK (status IN ('active','beta','coming-soon','archived','draft','submitted','under_review','changes_requested','suspended')),
  current_version TEXT,
  size_mb INTEGER,
  rating REAL DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  download_count INTEGER DEFAULT 0,
  price_type TEXT DEFAULT 'free' CHECK (price_type IN ('free','paid','subscription')),
  price_amount REAL,
  platforms TEXT DEFAULT '[]',
  is_featured INTEGER DEFAULT 0,
  is_new INTEGER DEFAULT 0,
  is_trending INTEGER DEFAULT 0,
  release_date TEXT,
  last_updated TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  features TEXT DEFAULT '[]',
  release_notes TEXT DEFAULT '[]',
  deleted_at TEXT,
  website TEXT,
  android_package_id TEXT,
  windows_uninstall_key TEXT,
  windows_executable TEXT,
  linux_package_name TEXT,
  linux_executable TEXT,
  developer_org_id TEXT REFERENCES developers(id),
  privacy_url TEXT,
  support_url TEXT,
  video_url TEXT
);

INSERT OR IGNORE INTO applications_new (
  id, slug, name, description, long_description, category, tags, developer, developer_id,
  icon, color, gradient, screenshots, status, current_version, size_mb, rating, review_count,
  download_count, price_type, price_amount, platforms, is_featured, is_new, is_trending,
  release_date, last_updated, created_at, updated_at, features, release_notes, deleted_at,
  website, android_package_id, windows_uninstall_key, windows_executable, linux_package_name,
  linux_executable, developer_org_id, privacy_url, support_url, video_url
)
SELECT
  id, slug, name, description, long_description, category, tags, developer, developer_id,
  icon, color, gradient, screenshots, status, current_version, size_mb, rating, review_count,
  download_count, price_type, price_amount, platforms, is_featured, is_new, is_trending,
  release_date, last_updated, created_at, updated_at, features, release_notes, deleted_at,
  website, android_package_id, windows_uninstall_key, windows_executable, linux_package_name,
  linux_executable, developer_org_id, privacy_url, support_url, video_url
FROM applications;

-- Children (releases, packages, developer_submissions, storefront_featured and
-- every legacy table referencing applications) now reference applications_shadow.
ALTER TABLE applications RENAME TO applications_shadow;
ALTER TABLE applications_new RENAME TO applications;

-- ===========================================================================
-- PHASE B — releases (developer submission lifecycle + security hooks)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS releases_new (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  build_number TEXT,
  release_notes TEXT DEFAULT '[]',
  feature_summary TEXT,
  call_to_action TEXT,
  release_type TEXT DEFAULT 'patch' CHECK (release_type IN ('major','minor','patch')),
  channel TEXT DEFAULT 'stable' CHECK (channel IN ('stable','beta','alpha')),
  minimum_supported_version TEXT,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','processing','ready_for_review','submitted','under_review','changes_requested','approved','rejected','published','withdrawn','disabled','rolled_back','archived')),
  developer_id TEXT REFERENCES developers(id),
  reviewer_id TEXT,
  review_reason TEXT,
  security_status TEXT DEFAULT 'pending' CHECK (security_status IN ('pending','processing','passed','failed','needs_review')),
  verification_status TEXT DEFAULT 'pending' CHECK (verification_status IN ('pending','processing','passed','failed','needs_review')),
  deleted_at TEXT,
  published_at TEXT,
  submitted_at TEXT,
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(application_id, version)
);

INSERT OR IGNORE INTO releases_new (
  id, application_id, version, release_notes, release_type, channel, minimum_supported_version,
  status, deleted_at, published_at, created_at, updated_at
)
SELECT
  id, application_id, version, release_notes, release_type, channel, minimum_supported_version,
  status, deleted_at, published_at, created_at, updated_at
FROM releases;

-- packages + developer_submissions now reference releases_shadow.
ALTER TABLE releases RENAME TO releases_shadow;
ALTER TABLE releases_new RENAME TO releases;

-- ===========================================================================
-- PHASE C — packages (repoint to the live parents; absorbs the 0010-tail
-- security columns directly, so no ALTERs are needed)
-- ===========================================================================

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
  quarantine_key TEXT,
  security_state TEXT DEFAULT 'QUARANTINED' CHECK (security_state IN ('QUARANTINED','STRUCTURE_CHECK','INTEGRITY_CHECK','DUPLICATE_CHECK','MALWARE_SCAN','SIGNATURE_CHECK','CERTIFICATE_CHECK','DEPENDENCY_SECURITY_CHECK','NATIVE_IDENTITY_CHECK','SECURITY_REVIEW_COMPLETE','SECURITY_OVERRIDE','PUBLISHED')),
  overall_security TEXT DEFAULT 'PENDING' CHECK (overall_security IN ('PENDING','PASSED','FAILED','NEEDS_REVIEW')),
  security_scan_status TEXT DEFAULT 'pending',
  signature_status TEXT DEFAULT 'pending',
  scan_at TEXT,
  verified_at TEXT,
  UNIQUE(release_id, platform, architecture)
);

-- Copies every column that exists in the current (0008+0011) packages table.
INSERT OR IGNORE INTO packages_new (
  id, application_id, release_id, platform, architecture, filename, storage_key, file_size,
  mime_type, sha256, version, deployment_url, package_type, min_os_version, min_android_sdk,
  status, deleted_at, created_at, quarantine_key, security_state, overall_security
)
SELECT
  id, application_id, release_id, platform, architecture, filename, storage_key, file_size,
  mime_type, sha256, version, deployment_url, package_type, min_os_version, min_android_sdk,
  status, deleted_at, created_at, quarantine_key, security_state, overall_security
FROM packages;

-- package_security_results / package_security_overrides now reference packages_v0.
ALTER TABLE packages RENAME TO packages_v0;
ALTER TABLE packages_new RENAME TO packages;

-- ===========================================================================
-- PHASE D — rebuild the remaining known-schema children against the live
-- parents, then drop their unreferenced _v0 leftovers.
-- ===========================================================================

-- storefront_featured (0013 DDL, references applications)
CREATE TABLE IF NOT EXISTS storefront_featured_new (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  placement TEXT NOT NULL DEFAULT 'home_featured' CHECK (placement IN ('home_featured','games_featured','apps_featured')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  banner_url TEXT,
  promo_text TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO storefront_featured_new (id, app_id, placement, sort_order, starts_at, ends_at, banner_url, promo_text, enabled, created_at, updated_at)
SELECT id, app_id, placement, sort_order, starts_at, ends_at, banner_url, promo_text, enabled, created_at, updated_at FROM storefront_featured;
ALTER TABLE storefront_featured RENAME TO storefront_featured_v0;
ALTER TABLE storefront_featured_new RENAME TO storefront_featured;
DROP TABLE storefront_featured_v0;

-- developer_submissions (0012 DDL, references developers + applications + releases)
CREATE TABLE IF NOT EXISTS developer_submissions_new (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL UNIQUE REFERENCES releases(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','SECURITY_REVIEW','ADMIN_REVIEW','REVIEW_SUSPENDED','CHANGES_REQUESTED','APPROVED','REJECTED','WITHDRAWN','PUBLISHED')),
  reviewer_id TEXT,
  review_notes TEXT,
  action_items TEXT DEFAULT '[]',
  decision TEXT,
  submitted_at TEXT,
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO developer_submissions_new (id, developer_id, app_id, release_id, status, reviewer_id, review_notes, action_items, decision, submitted_at, reviewed_at, created_at, updated_at)
SELECT id, developer_id, app_id, release_id, status, reviewer_id, review_notes, action_items, decision, submitted_at, reviewed_at, created_at, updated_at FROM developer_submissions;
-- developer_submission_events follows the rename (references developer_submissions)
ALTER TABLE developer_submissions RENAME TO developer_submissions_v0;
ALTER TABLE developer_submissions_new RENAME TO developer_submissions;

-- developer_submission_events (0012 DDL, references developer_submissions)
CREATE TABLE IF NOT EXISTS developer_submission_events_new (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES developer_submissions(id) ON DELETE CASCADE,
  actor_user_id TEXT,
  actor_role TEXT,
  event TEXT NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO developer_submission_events_new (id, submission_id, actor_user_id, actor_role, event, notes, created_at)
SELECT id, submission_id, actor_user_id, actor_role, event, notes, created_at FROM developer_submission_events;
ALTER TABLE developer_submission_events RENAME TO developer_submission_events_v0;
ALTER TABLE developer_submission_events_new RENAME TO developer_submission_events;
DROP TABLE developer_submission_events_v0;
DROP TABLE developer_submissions_v0;

-- package_security_results (0011 DDL, references packages)
CREATE TABLE IF NOT EXISTS package_security_results_new (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  release_id TEXT,
  app_id TEXT,
  developer_id TEXT,
  check_type TEXT NOT NULL CHECK (check_type IN ('structure','integrity','duplicate','malware','signature','certificate','dependency','native_identity')),
  status TEXT NOT NULL,
  classification TEXT,
  provider TEXT,
  provider_version TEXT,
  result TEXT,
  details TEXT,
  fingerprint TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO package_security_results_new (id, package_id, release_id, app_id, developer_id, check_type, status, classification, provider, provider_version, result, details, fingerprint, error, started_at, completed_at, created_at)
SELECT id, package_id, release_id, app_id, developer_id, check_type, status, classification, provider, provider_version, result, details, fingerprint, error, started_at, completed_at, created_at FROM package_security_results;
ALTER TABLE package_security_results RENAME TO package_security_results_v0;
ALTER TABLE package_security_results_new RENAME TO package_security_results;
DROP TABLE package_security_results_v0;

-- package_security_overrides (0011 DDL, references packages)
CREATE TABLE IF NOT EXISTS package_security_overrides_new (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  admin_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  prior_state TEXT,
  prior_overall TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO package_security_overrides_new (id, package_id, admin_user_id, reason, prior_state, prior_overall, created_at)
SELECT id, package_id, admin_user_id, reason, prior_state, prior_overall, created_at FROM package_security_overrides;
ALTER TABLE package_security_overrides RENAME TO package_security_overrides_v0;
ALTER TABLE package_security_overrides_new RENAME TO package_security_overrides;
DROP TABLE package_security_overrides_v0;

-- packages_v0 is now unreferenced (psr/pso were rebuilt above) — safe to drop.
DROP TABLE packages_v0;

-- ===========================================================================
-- PHASE E — keep the shadows in sync for legacy child tables (downloads,
-- reviews, subscriptions, app_versions, and any pre-repo table referencing
-- applications/releases). The triggers mirror the referenced key columns so
-- FK checks for those children keep working for rows created after this
-- migration. NOT NULL columns are included; UNIQUE conflicts are ignored.
-- ===========================================================================

CREATE TRIGGER IF NOT EXISTS applications_shadow_sync_insert
AFTER INSERT ON applications
BEGIN
  INSERT OR IGNORE INTO applications_shadow (id, slug, name, description, category)
  VALUES (NEW.id, NEW.slug, NEW.name, NEW.description, NEW.category);
END;

CREATE TRIGGER IF NOT EXISTS applications_shadow_sync_delete
AFTER DELETE ON applications
BEGIN
  DELETE FROM applications_shadow WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS applications_shadow_sync_update
AFTER UPDATE OF id ON applications
BEGIN
  UPDATE applications_shadow SET id = NEW.id WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS releases_shadow_sync_insert
AFTER INSERT ON releases
BEGIN
  INSERT OR IGNORE INTO releases_shadow (id, application_id, version)
  VALUES (NEW.id, NEW.application_id, NEW.version);
END;

CREATE TRIGGER IF NOT EXISTS releases_shadow_sync_delete
AFTER DELETE ON releases
BEGIN
  DELETE FROM releases_shadow WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS releases_shadow_sync_update
AFTER UPDATE OF id ON releases
BEGIN
  UPDATE releases_shadow SET id = NEW.id WHERE id = OLD.id;
END;

-- ===========================================================================
-- PHASE F — indexes. The legacy index names travelled with the shadows, so
-- free the canonical names first, then (re)create everything on the live
-- tables (including the indexes that 0011/0012 had created on tables that
-- were renamed and dropped above).
-- ===========================================================================

DROP INDEX IF EXISTS idx_applications_slug;
DROP INDEX IF EXISTS idx_applications_category;
DROP INDEX IF EXISTS idx_applications_status;
DROP INDEX IF EXISTS idx_applications_developer_org;
DROP INDEX IF EXISTS idx_releases_app;
DROP INDEX IF EXISTS idx_releases_status;
DROP INDEX IF EXISTS idx_releases_version;

CREATE INDEX IF NOT EXISTS idx_applications_slug ON applications(slug);
CREATE INDEX IF NOT EXISTS idx_applications_category ON applications(category);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_developer_org ON applications(developer_org_id);
CREATE INDEX IF NOT EXISTS idx_releases_application ON releases(application_id);
CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status);
CREATE INDEX IF NOT EXISTS idx_releases_developer ON releases(developer_id);
CREATE INDEX IF NOT EXISTS idx_releases_submitted ON releases(submitted_at);
CREATE INDEX IF NOT EXISTS idx_packages_storage_key ON packages(storage_key);
CREATE INDEX IF NOT EXISTS idx_psr_package ON package_security_results(package_id);
CREATE INDEX IF NOT EXISTS idx_psr_check ON package_security_results(package_id, check_type);
CREATE INDEX IF NOT EXISTS idx_psr_created ON package_security_results(created_at);
CREATE INDEX IF NOT EXISTS idx_pso_package ON package_security_overrides(package_id);
CREATE INDEX IF NOT EXISTS idx_dev_submissions_developer ON developer_submissions(developer_id);
CREATE INDEX IF NOT EXISTS idx_dev_submissions_app ON developer_submissions(app_id);
CREATE INDEX IF NOT EXISTS idx_dev_submissions_status ON developer_submissions(status);
CREATE INDEX IF NOT EXISTS idx_dev_submissions_reviewer ON developer_submissions(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_dev_submission_events_sub ON developer_submission_events(submission_id);
