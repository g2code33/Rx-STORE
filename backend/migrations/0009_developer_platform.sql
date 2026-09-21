-- 0009: Developer Platform foundation (Phase 11).
--
-- Architecture: RX Store Account -> Developer Application -> Developer
-- Organization/Profile -> Team + Roles -> Developer Center. ADDITIVE only:
-- existing users/auth/notifications/audit_logs are reused, never duplicated.
--
-- Tables:
--   developer_applications  one per user; the "Become a Developer" workflow
--   developers              the approved developer identity (dev_xxxxxxxx)
--   developer_profiles      PUBLIC organization profile (private data stays
--                           in developer_applications and is never exposed)
--   developer_members       team membership + role assignment (server-enforced)
--   developer_roles         role -> permission matrix (seeded below)
--   developer_invitations   hashed, expiring team invitations
--   developer_audit_logs    org-scoped audit trail (admin-side events also go
--                           to the existing audit_logs table)
--   developer_threads       developer <-> admin communication threads
--   developer_thread_messages  thread messages with per-party read state
--
-- Plus: applications.developer_org_id connects EXISTING apps to an
-- organization (backfilled on approval) so "My Apps" is real data.
--
-- Run once against production (CREATE TABLE IF NOT EXISTS is re-run safe):
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0009_developer_platform.sql
-- NOTE: the final ALTER TABLE fails with "duplicate column name" if already
-- applied — that is the only non-idempotent statement and is harmless.

CREATE TABLE IF NOT EXISTS developer_applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  -- NOT_APPLIED is the effective status reported by the API when NO row exists.
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('NOT_APPLIED','DRAFT','SUBMITTED','UNDER_REVIEW','CHANGES_REQUESTED','APPROVED','SUSPENDED','REJECTED')),
  publisher_name TEXT,
  developer_type TEXT CHECK (developer_type IN ('individual','organization')),
  contact_email TEXT,
  support_email TEXT,
  website TEXT,
  country TEXT,
  description TEXT,
  category TEXT,
  accepted_terms INTEGER NOT NULL DEFAULT 0,
  terms_accepted_at TEXT,
  submitted_at TEXT,
  reviewed_at TEXT,
  review_reason TEXT,          -- required for REJECTED / CHANGES_REQUESTED / SUSPENDED
  reviewed_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_developer_applications_status ON developer_applications(status);
CREATE INDEX IF NOT EXISTS idx_developer_applications_user ON developer_applications(user_id);

CREATE TABLE IF NOT EXISTS developers (
  id TEXT PRIMARY KEY,                                   -- dev_xxxxxxxxx
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,  -- founding owner account
  application_id TEXT REFERENCES developer_applications(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  suspended_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),             -- "developer since"
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_developers_user ON developers(user_id);

CREATE TABLE IF NOT EXISTS developer_profiles (
  developer_id TEXT PRIMARY KEY REFERENCES developers(id) ON DELETE CASCADE,
  publisher_name TEXT NOT NULL,
  logo TEXT,
  description TEXT,
  website TEXT,
  support_url TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS developer_members (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'DEVELOPER' CHECK (role IN ('OWNER','ADMIN','DEVELOPER','RELEASE_MANAGER','ANALYST','SUPPORT')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(developer_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_developer_members_user ON developer_members(user_id);
CREATE INDEX IF NOT EXISTS idx_developer_members_dev ON developer_members(developer_id);

-- Server-side permission matrix. The API resolves permissions from the
-- member's role here — a client-supplied role is NEVER trusted.
CREATE TABLE IF NOT EXISTS developer_roles (
  role TEXT PRIMARY KEY,
  permissions TEXT NOT NULL DEFAULT '[]'
);
INSERT OR IGNORE INTO developer_roles (role, permissions) VALUES
  ('OWNER',          '["organization.manage","team.manage","app.create","app.edit","release.create","release.edit","package.upload","release.submit","release.publish","analytics.view","reviews.manage","support.respond","billing.manage","security.view"]'),
  ('ADMIN',          '["organization.manage","team.manage","app.create","app.edit","release.create","release.edit","package.upload","release.submit","release.publish","analytics.view","reviews.manage","support.respond","security.view"]'),
  ('DEVELOPER',      '["app.create","app.edit","release.create","release.edit","package.upload","analytics.view"]'),
  ('RELEASE_MANAGER','["app.edit","release.create","release.edit","package.upload","release.submit","release.publish","analytics.view"]'),
  ('ANALYST',        '["analytics.view","reviews.manage"]'),
  ('SUPPORT',        '["reviews.manage","support.respond"]');

CREATE TABLE IF NOT EXISTS developer_invitations (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  -- OWNER can only be granted by the approval flow, never by invitation.
  role TEXT NOT NULL DEFAULT 'DEVELOPER' CHECK (role IN ('ADMIN','DEVELOPER','RELEASE_MANAGER','ANALYST','SUPPORT')),
  token_hash TEXT NOT NULL,     -- SHA-256 of the invitation token (raw token never stored)
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','CANCELLED','EXPIRED')),
  invited_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_developer_invitations_dev ON developer_invitations(developer_id);
CREATE INDEX IF NOT EXISTS idx_developer_invitations_email ON developer_invitations(email);

CREATE TABLE IF NOT EXISTS developer_audit_logs (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_developer_audit_logs_dev ON developer_audit_logs(developer_id);

CREATE TABLE IF NOT EXISTS developer_threads (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  related_application_id TEXT,
  related_app_id TEXT,
  related_release_id TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','AWAITING_DEVELOPER','AWAITING_ADMIN','RESOLVED','CLOSED')),
  action_required INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_developer_threads_dev ON developer_threads(developer_id);

CREATE TABLE IF NOT EXISTS developer_thread_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES developer_threads(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL,
  sender_context TEXT NOT NULL DEFAULT 'DEVELOPER' CHECK (sender_context IN ('DEVELOPER','ADMIN')),
  body TEXT NOT NULL,
  attachments TEXT,               -- JSON metadata only (no file blobs)
  read_by_developer_at TEXT,
  read_by_admin_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_developer_thread_messages_thread ON developer_thread_messages(thread_id);

-- Connect EXISTING applications to a developer organization (additive column;
-- backfilled by the admin approval flow, read by the Developer Center).
ALTER TABLE applications ADD COLUMN developer_org_id TEXT REFERENCES developers(id);
CREATE INDEX IF NOT EXISTS idx_applications_developer_org ON applications(developer_org_id);
