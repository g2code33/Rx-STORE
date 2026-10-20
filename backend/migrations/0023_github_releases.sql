-- 0023 — GitHub Releases integration (free apps) + Admin Approval Center.
--
-- CHANNEL POLICY (enforced in code, mirrored here for clarity):
--   * FREE applications may connect ONE GitHub repository. GitHub Releases on
--     that repository are DETECTED automatically and land in a pending-approval
--     queue. Nothing is published without an explicit admin approval.
--   * PAID applications can never connect (server-side check on connect, on
--     publish and on download).
--   * RX Store does NOT copy GitHub installer binaries into R2: packages rows
--     created from GitHub assets use provider='github' + external_url, and
--     storage_key is the EMPTY STRING (SQLite cannot drop the legacy NOT NULL
--     constraint without a table rebuild; empty string is the deliberate,
--     documented representation of "no RX Store storage object". Every
--     storage_key consumer is provider-guarded — see services/releases.ts and
--     the download endpoint).
--
-- Re-running this migration on an already-migrated database is safe except for
-- the ALTER TABLE ADD COLUMN statements, which fail with "duplicate column
-- name" — that error is the harmless already-applied signal (same as 0021/0022).

-- packages: provider awareness. 'rxstore' (uploaded artifact, storage_key
-- required) vs 'github' (external release asset, external_url required).
ALTER TABLE packages ADD COLUMN provider TEXT NOT NULL DEFAULT 'rxstore';
ALTER TABLE packages ADD COLUMN external_url TEXT;
ALTER TABLE packages ADD COLUMN github_asset_id TEXT;

-- One repository binding per app, one app per repository (1:1, explicit).
CREATE TABLE IF NOT EXISTS github_repo_connections (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,            -- GitHub's immutable numeric repo id (as text)
  repository_owner TEXT NOT NULL,         -- display owner (mutable on GitHub)
  repository_name TEXT NOT NULL,          -- display name (mutable on GitHub)
  repository_full_name TEXT NOT NULL,     -- owner/name at connect time
  installation_id TEXT NOT NULL,          -- GitHub App installation (immutable binding anchor)
  channel TEXT NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable','beta','alpha')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disconnected','revoked','error')),
  connected_by TEXT,                      -- user id of the developer who connected
  last_event_at TEXT,
  last_event TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  latest_detected_version TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(application_id),
  UNIQUE(repository_id)
);
CREATE INDEX IF NOT EXISTS idx_gh_conn_repo ON github_repo_connections(repository_id);

-- Webhook delivery log + idempotency. UNIQUE(delivery_id, event): a redelivered
-- webhook hits the constraint and is recognised as already processed.
CREATE TABLE IF NOT EXISTS github_release_events (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,              -- X-GitHub-Delivery GUID
  event TEXT NOT NULL,                    -- X-GitHub-Event (e.g. 'release')
  action TEXT,
  repository_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('received','processing','processed','ignored','failed')),
  detail TEXT,
  error TEXT,
  received_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_events_delivery ON github_release_events(delivery_id, event);

-- Detected GitHub releases (the approval state machine).
-- detected -> verifying -> pending_approval -> published
-- failure/decision states: verification_failed | blocked | rejected | withdrawn
CREATE TABLE IF NOT EXISTS github_releases (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  github_release_id TEXT NOT NULL,        -- GitHub's numeric release id (immutable per release)
  tag_name TEXT NOT NULL,
  version TEXT NOT NULL,                  -- semver parsed from the tag (validated)
  release_name TEXT,
  target_commitish TEXT,
  is_prerelease INTEGER NOT NULL DEFAULT 0,
  release_notes TEXT,
  github_published_at TEXT,
  status TEXT NOT NULL DEFAULT 'detected'
    CHECK (status IN ('detected','verifying','pending_approval','verification_failed','blocked','rejected','withdrawn','published')),
  block_reason TEXT,                      -- human reason for blocked / verification_failed
  detected_at TEXT DEFAULT (datetime('now')),
  verified_at TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  decision_reason TEXT,                   -- rejection reason / approval note
  published_by TEXT,
  published_at TEXT,
  prior_version TEXT,                     -- applications.current_version before publish
  UNIQUE(github_release_id),
  UNIQUE(application_id, version)
);
CREATE INDEX IF NOT EXISTS idx_gh_rel_status ON github_releases(status);
CREATE INDEX IF NOT EXISTS idx_gh_rel_app ON github_releases(application_id);

-- Verified external assets for a detected release. size/sha256 are computed
-- from the ACTUAL downloaded bytes — never from declared values.
CREATE TABLE IF NOT EXISTS github_release_assets (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES github_releases(id) ON DELETE CASCADE,
  github_asset_id TEXT NOT NULL,
  name TEXT NOT NULL,                     -- asset filename
  platform TEXT NOT NULL,                 -- mapped RX Store platform
  architecture TEXT NOT NULL,             -- mapped architecture
  size_bytes INTEGER,                     -- actual, from streamed bytes
  sha256 TEXT,                            -- actual, from streamed bytes
  declared_sha256 TEXT,                   -- from the release manifest, if any (compared, never trusted)
  download_url TEXT,                      -- validated GitHub asset URL
  state TEXT NOT NULL DEFAULT 'detected'
    CHECK (state IN ('detected','verified','mismatch','missing','unmapped','failed')),
  scanner_status TEXT,                    -- CLEAN | DETECTED | UNAVAILABLE | ... (honest)
  scanner_detail TEXT,
  scanned_at TEXT,
  error TEXT,
  verified_at TEXT,
  UNIQUE(release_id, platform, architecture)
);
CREATE INDEX IF NOT EXISTS idx_gh_asset_release ON github_release_assets(release_id);

-- Who did what, when, to which release/connection — every admin decision.
CREATE TABLE IF NOT EXISTS github_audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,                   -- connect | disconnect | publish | reject | withdraw | retry | sync | override
  actor_id TEXT NOT NULL,
  actor_label TEXT,
  application_id TEXT,
  release_id TEXT,
  repository_id TEXT,
  reason TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gh_audit_time ON github_audit_log(created_at DESC);
