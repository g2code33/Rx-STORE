-- 0020: Admin inbox — direct-to-admin messaging (ad bookings, contact, support).
--
-- Lets ANY visitor (signed in or not) send a message straight to the admin's
-- portal (e.g. booking the welcome-intro ad slot), and gives the admin a
-- section to read, take action on, and reply (by email, using templates)
-- without leaving the portal. Mirrors the developer_threads pattern.
--
-- Run: npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0020_admin_inbox.sql
-- Safe to re-run (IF NOT EXISTS). Never destructive.

CREATE TABLE IF NOT EXISTS admin_inbox (
  id TEXT PRIMARY KEY,                     -- inbx_<uuid>
  type TEXT NOT NULL CHECK (type IN ('ad_booking','contact','support','sponsor')),
  name TEXT NOT NULL,                      -- sender display name
  email TEXT NOT NULL,                     -- sender reply address
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,  -- when signed in
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  payload TEXT DEFAULT '{}',               -- structured extras (company, headline, dates…)
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_review','actioned','archived')),
  admin_note TEXT,                         -- admin's internal action note
  replied_at TEXT,
  reply_template TEXT,                     -- which template was used for the reply
  reply_delivery TEXT,                     -- 'sent' | 'unconfigured' | 'failed' (honest)
  notified_admin TEXT,                     -- 'sent' | 'unconfigured' | 'failed' (honest)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_inbox_status ON admin_inbox(status);
CREATE INDEX IF NOT EXISTS idx_admin_inbox_created ON admin_inbox(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_inbox_user ON admin_inbox(user_id);
