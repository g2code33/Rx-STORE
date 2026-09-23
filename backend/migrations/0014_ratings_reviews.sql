-- 0014: Ratings & Reviews production system (Phase 17).
--
-- Extends the EXISTING reviews table (UNIQUE(app_id, user_id) already enforces
-- one active review per user per app — resubmission becomes an edit) with:
--   title, app_version, platform, verified_install (factual install/download
--   marker), moderation state (status/reason/by/at), and developer responses
--   (body + responder + timestamp, clearly attributable).
-- The existing `comment` column IS the review body (documented; no duplicate
-- column).
--
-- New table: review_reports — user reports with a fixed reason vocabulary,
-- one open report per (review, reporter); admin moderation resolves them.
--
-- Moderation NEVER deletes rows: hidden/removed are statuses, and every
-- action is recorded in audit_logs (moderation_reason preserved).
--
-- Run once (ALTERs fail harmlessly with 'duplicate column name' if re-run):
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0014_ratings_reviews.sql

ALTER TABLE reviews ADD COLUMN title TEXT;
ALTER TABLE reviews ADD COLUMN app_version TEXT;
ALTER TABLE reviews ADD COLUMN platform TEXT;
ALTER TABLE reviews ADD COLUMN verified_install INTEGER DEFAULT 0;
ALTER TABLE reviews ADD COLUMN status TEXT DEFAULT 'visible';
ALTER TABLE reviews ADD COLUMN moderation_reason TEXT;
ALTER TABLE reviews ADD COLUMN moderated_at TEXT;
ALTER TABLE reviews ADD COLUMN moderated_by TEXT;
ALTER TABLE reviews ADD COLUMN developer_response TEXT;
ALTER TABLE reviews ADD COLUMN developer_responded_at TEXT;
ALTER TABLE reviews ADD COLUMN developer_responder_id TEXT;

CREATE INDEX IF NOT EXISTS idx_reviews_app_status ON reviews(app_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);

CREATE TABLE IF NOT EXISTS review_reports (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reporter_user_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('spam','harassment','irrelevant','fraudulent','malicious_content','other')),
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(review_id, reporter_user_id)
);
CREATE INDEX IF NOT EXISTS idx_review_reports_review ON review_reports(review_id);
CREATE INDEX IF NOT EXISTS idx_review_reports_status ON review_reports(status);
