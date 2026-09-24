-- 0017: Developer ecosystem public infrastructure (Phase 20).
--
-- Real community forum (no fake forum): categories, discussions, replies,
-- moderation states (rows never silently deleted), reporting — plus scoped,
-- revocable API tokens for programmatic developer access.
--
-- Run once (CREATEs are IF NOT EXISTS):
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0017_developer_community.sql

CREATE TABLE IF NOT EXISTS community_categories (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS community_discussions (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES community_categories(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  developer_org_id TEXT,                 -- optional org attribution
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden','removed')),
  moderation_reason TEXT,
  moderated_at TEXT,
  moderated_by TEXT,
  reply_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_community_discussions_category ON community_discussions(category_id, status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_discussions_author ON community_discussions(author_user_id);

CREATE TABLE IF NOT EXISTS community_replies (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL REFERENCES community_discussions(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  developer_org_id TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden','removed')),
  moderation_reason TEXT,
  moderated_at TEXT,
  moderated_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_community_replies_discussion ON community_replies(discussion_id, status, created_at);

CREATE TABLE IF NOT EXISTS community_reports (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('discussion','reply')),
  target_id TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('spam','harassment','irrelevant','malicious_content','other')),
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(target_type, target_id, reporter_user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_reports_status ON community_reports(status);

-- Default categories (idempotent seed).
INSERT OR IGNORE INTO community_categories (id, slug, name, description, sort_order) VALUES
  ('cc_announcements', 'announcements', 'Announcements', 'Official RX Store platform news and release notes.', 1),
  ('cc_general', 'general', 'General', 'Introduce yourself and talk about anything RX Store.', 2),
  ('cc_app_submission', 'app-submission', 'App Submission', 'Questions about the submission, review and publication process.', 3),
  ('cc_integration', 'integration', 'Integration & API', 'API, SDK, webhook and integration help.', 4),
  ('cc_showcase', 'showcase', 'Showcase', 'Show the community what you built.', 5);

-- Scoped, revocable API tokens for developers (the raw token is shown ONCE at
-- creation; only its SHA-256 hash is stored).
CREATE TABLE IF NOT EXISTS developer_api_tokens (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,      -- SHA-256 of the raw token
  token_prefix TEXT NOT NULL,           -- first 8 chars, for identification
  scopes TEXT NOT NULL DEFAULT '[]',    -- JSON array of scope strings
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_developer_api_tokens_dev ON developer_api_tokens(developer_id);
