-- 0012: Admin Review & Developer Communication (Phase 14).
--
-- First-class submission records linking developer/org/app/release/packages
-- through the review lifecycle, append-only review history, reviewer
-- assignment, and private thread attachments.
--
-- Lifecycle (submission.status):
--   DRAFT -> SUBMITTED -> SECURITY_REVIEW -> ADMIN_REVIEW ->
--   (CHANGES_REQUESTED -> resubmit -> SECURITY_REVIEW/ADMIN_REVIEW) ->
--   APPROVED | REJECTED | WITHDRAWN -> PUBLISHED
--   REVIEW_SUSPENDED is an operational state (Suspend Review) that returns to
--   ADMIN_REVIEW on resume.
--
-- Tables:
--   developer_submissions        one per release review lifecycle (UNIQUE release)
--   developer_submission_events  append-only history (never destroyed)
--   developer_thread_attachments private, access-controlled message attachments
--   developer_threads.related_submission_id  link threads to submissions
--
-- Run once (the ALTER fails harmlessly with 'duplicate column name' if re-run):
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0012_submissions_review.sql

CREATE TABLE IF NOT EXISTS developer_submissions (
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
CREATE INDEX IF NOT EXISTS idx_dev_submissions_developer ON developer_submissions(developer_id);
CREATE INDEX IF NOT EXISTS idx_dev_submissions_app ON developer_submissions(app_id);
CREATE INDEX IF NOT EXISTS idx_dev_submissions_status ON developer_submissions(status);
CREATE INDEX IF NOT EXISTS idx_dev_submissions_reviewer ON developer_submissions(reviewer_id);

CREATE TABLE IF NOT EXISTS developer_submission_events (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES developer_submissions(id) ON DELETE CASCADE,
  actor_user_id TEXT,
  actor_role TEXT,
  event TEXT NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dev_submission_events_sub ON developer_submission_events(submission_id);

CREATE TABLE IF NOT EXISTS developer_thread_attachments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES developer_threads(id) ON DELETE CASCADE,
  message_id TEXT,
  uploader_user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  scan_status TEXT DEFAULT 'PENDING' CHECK (scan_status IN ('PENDING','CLEAN','DETECTED','FAILED','UNAVAILABLE')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_thread_attachments_thread ON developer_thread_attachments(thread_id);

ALTER TABLE developer_threads ADD COLUMN related_submission_id TEXT;
