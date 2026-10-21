-- 0024 — Admin awareness events + sectioned user notifications.
--
-- GOAL: everything that happens in RX Store raises a countable, per-section
-- notification for the people who need to act on it:
--   * admins  -> admin_events (one row per event, tagged with the ADMIN
--     SIDEBAR SECTION it belongs to: applications, releases, users, inbox,
--     payments, community, reviews, developers, github, security, ...)
--   * users / developers -> notifications.section (the PROFILE / DEVELOPER
--     CENTER section it belongs to: releases, messages, payments, reviews...)
--
-- Badges are "unread counts per section"; opening the section marks its rows
-- read, so the number disappears after viewing.
--
-- Re-running this migration is safe except the ALTER (duplicate column name =
-- already applied, the standard harmless signal in this repo).

CREATE TABLE IF NOT EXISTS admin_events (
  id TEXT PRIMARY KEY,
  section TEXT NOT NULL,             -- admin sidebar section id that owns the badge
  type TEXT NOT NULL DEFAULT 'info', -- info | action_required | warning | success | error
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  link TEXT,                         -- in-app destination (/admin?section=... or deeper)
  meta TEXT,                         -- JSON details (ids only, never secrets)
  actor_user_id TEXT,
  read_at TEXT,
  read_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_events_section ON admin_events(section, read_at);
CREATE INDEX IF NOT EXISTS idx_admin_events_unread ON admin_events(read_at);
CREATE INDEX IF NOT EXISTS idx_admin_events_created ON admin_events(created_at DESC);

-- Section tag for the per-user notification feed (profile + developer center).
ALTER TABLE notifications ADD COLUMN section TEXT;
CREATE INDEX IF NOT EXISTS idx_notifications_user_section ON notifications(user_id, section, read);
