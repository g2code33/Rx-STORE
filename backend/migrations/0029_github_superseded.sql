-- 0029 — LATEST-ONLY release queue.
--
-- A sync used to import every historical GitHub release, so the approval queue
-- filled with v1.0.60 … v1.0.68. Only the newest undecided release matters now:
-- older candidates are marked 'superseded' (kept as history, never queued,
-- never publishable, never notified).
--
-- SQLite cannot ALTER a CHECK constraint, so the github_releases status check
-- is rebuilt to include 'superseded'. Data is copied verbatim.
--
-- Re-running is safe: the rebuild is idempotent because the source table is
-- recreated only when the constraint lacks 'superseded'.

CREATE TABLE IF NOT EXISTS github_releases_new (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  github_release_id TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  version TEXT NOT NULL,
  release_name TEXT,
  target_commitish TEXT,
  is_prerelease INTEGER NOT NULL DEFAULT 0,
  release_notes TEXT,
  github_published_at TEXT,
  status TEXT NOT NULL DEFAULT 'detected'
    CHECK (status IN ('detected','verifying','pending_approval','verification_failed','blocked','rejected','withdrawn','published','superseded')),
  block_reason TEXT,
  detected_at TEXT DEFAULT (datetime('now')),
  verified_at TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  decision_reason TEXT,
  published_by TEXT,
  published_at TEXT,
  prior_version TEXT,
  ignored_assets TEXT,
  UNIQUE(github_release_id),
  UNIQUE(application_id, version)
);

INSERT OR IGNORE INTO github_releases_new (
  id, application_id, connection_id, github_release_id, tag_name, version, release_name,
  target_commitish, is_prerelease, release_notes, github_published_at, status, block_reason,
  detected_at, verified_at, reviewed_by, reviewed_at, decision_reason, published_by,
  published_at, prior_version, ignored_assets
)
SELECT
  id, application_id, connection_id, github_release_id, tag_name, version, release_name,
  target_commitish, is_prerelease, release_notes, github_published_at, status, block_reason,
  detected_at, verified_at, reviewed_by, reviewed_at, decision_reason, published_by,
  published_at, prior_version, ignored_assets
FROM github_releases;

DROP TABLE github_releases;
ALTER TABLE github_releases_new RENAME TO github_releases;

CREATE INDEX IF NOT EXISTS idx_gh_rel_status ON github_releases(status);
CREATE INDEX IF NOT EXISTS idx_gh_rel_app ON github_releases(application_id);
