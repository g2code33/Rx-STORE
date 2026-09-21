-- 0010: Developer App Management & Release Submission (Phase 12).
--
-- Extends the EXISTING applications/releases/packages architecture (Prompt 7
-- canonical model) so approved developers can create apps, draft releases,
-- upload packages and submit for admin review. No duplicate tables.
--
-- applications: status CHECK extended with the developer lifecycle
--   draft -> submitted -> under_review -> (changes_requested | rejected)
--   -> active (admin approval lists the app) ; suspended (admin unlists)
--   Existing values stay valid: active, beta, coming-soon, archived.
--
-- releases: status CHECK extended with the developer submission lifecycle
--   draft -> submitted -> under_review -> (changes_requested | rejected)
--   -> approved -> published (publication happens ONLY via the existing
--   admin publish flow, which additionally requires status='approved' for
--   developer-originated releases) ; withdrawn (developer withdraws).
--   New columns: build_number, feature_summary, call_to_action,
--   review_reason, reviewer_id, developer_id (the dev_xxx organization),
--   submitted_at, reviewed_at, security_status, verification_status
--   (the last two are Prompt 13 hooks — 'pending' until really verified).
--
-- packages: Prompt 13 hooks added as plain columns (no rebuild):
--   security_scan_status, signature_status, scan_at, verified_at.
--
-- PRE-FLIGHT (read before running):
--   1. Run 0009 FIRST (it adds applications.developer_org_id, which this
--      migration copies).
--   2. Deployments whose `releases` table predates the repo schema may lack
--      `deleted_at`. If the run fails with "no such column: deleted_at", run
--      (one command, harmless if it already exists):
--        npx wrangler d1 execute rx-store-db --remote --command "ALTER TABLE releases ADD COLUMN deleted_at TEXT"
--      …then re-run this file (the failed run rolled back completely).
--   3. RE-RUN WARNING: like 0008, the rebuilds copy rows but re-running after
--      values were set would reset the NEW columns to their defaults. Run
--      exactly once; verify row counts afterwards.
--
-- Run once against production:
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0010_developer_releases.sql

-- ---------------------------------------------------------------------------
-- 1) applications — extended status CHECK (rebuild; every row copied forward)
-- ---------------------------------------------------------------------------
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
  developer_org_id TEXT REFERENCES developers(id)
);

INSERT OR IGNORE INTO applications_new (
  id, slug, name, description, long_description, category, tags, developer, developer_id,
  icon, color, gradient, screenshots, status, current_version, size_mb, rating, review_count,
  download_count, price_type, price_amount, platforms, is_featured, is_new, is_trending,
  release_date, last_updated, created_at, updated_at, features, release_notes, deleted_at,
  website, android_package_id, windows_uninstall_key, windows_executable, linux_package_name,
  linux_executable, developer_org_id
)
SELECT
  id, slug, name, description, long_description, category, tags, developer, developer_id,
  icon, color, gradient, screenshots, status, current_version, size_mb, rating, review_count,
  download_count, price_type, price_amount, platforms, is_featured, is_new, is_trending,
  release_date, last_updated, created_at, updated_at, features, release_notes, deleted_at,
  website, android_package_id, windows_uninstall_key, windows_executable, linux_package_name,
  linux_executable, developer_org_id
FROM applications;

DROP TABLE applications;
ALTER TABLE applications_new RENAME TO applications;

CREATE INDEX IF NOT EXISTS idx_applications_slug ON applications(slug);
CREATE INDEX IF NOT EXISTS idx_applications_category ON applications(category);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_developer_org ON applications(developer_org_id);

-- ---------------------------------------------------------------------------
-- 2) releases — developer submission lifecycle + Prompt 13 hooks (rebuild)
-- ---------------------------------------------------------------------------
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

DROP TABLE releases;
ALTER TABLE releases_new RENAME TO releases;

CREATE INDEX IF NOT EXISTS idx_releases_application ON releases(application_id);
CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status);
CREATE INDEX IF NOT EXISTS idx_releases_developer ON releases(developer_id);
CREATE INDEX IF NOT EXISTS idx_releases_submitted ON releases(submitted_at);

-- ---------------------------------------------------------------------------
-- 3) packages — Prompt 13 verification hooks (plain column adds)
-- ---------------------------------------------------------------------------
ALTER TABLE packages ADD COLUMN security_scan_status TEXT DEFAULT 'pending';
ALTER TABLE packages ADD COLUMN signature_status TEXT DEFAULT 'pending';
ALTER TABLE packages ADD COLUMN scan_at TEXT;
ALTER TABLE packages ADD COLUMN verified_at TEXT;
