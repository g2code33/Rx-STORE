-- 0022: Manual Security Review system (controlled fallback for indeterminate
-- automated results: UNAVAILABLE / SCANNING / UNKNOWN / NEEDS_REVIEW).
--
--   package_manual_reviews — one record per review. Created PENDING
--     automatically when the automated pipeline cannot produce a definitive
--     verdict; an authorized admin then APPROVES or REJECTS with mandatory
--     notes. SHA-256 BINDING IS MANDATORY: an approval authorizes exactly the
--     reviewed bytes — any replacement/re-upload invalidates it (the gate
--     compares hashes; stale rows are also marked invalidated_at).
--     DETECTED malware can NEVER be approved through this flow.
--
--   package_security_overrides — the legacy escape hatch gains the same
--     byte-binding: new overrides record the package SHA-256 and are
--     invalidated when the bytes change (fixes the silent "replacement rides
--     an old override" hole). Existing rows (sha256 NULL) stay valid for
--     backward compatibility.
--
-- Additive only; every automated check, status and audit trail is preserved.
--
-- Run: npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0022_manual_review.sql
-- Safe to re-run (IF NOT EXISTS; the ALTERs fail harmlessly when repeated).

CREATE TABLE IF NOT EXISTS package_manual_reviews (
  id TEXT PRIMARY KEY,                     -- mrev_<...>
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  release_id TEXT,
  sha256 TEXT NOT NULL,                    -- EXACT bytes under review (binding)
  platform TEXT NOT NULL,
  automated_integrity TEXT,                -- latest integrity result at creation
  automated_malware TEXT,                  -- latest malware result at creation
  automated_overall TEXT,                  -- overall security state at creation
  reason TEXT NOT NULL,                    -- why automated verification could not conclude
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  admin_user_id TEXT,                      -- decision maker (APPROVED/REJECTED)
  admin_notes TEXT,                        -- mandatory decision notes (min 10 chars)
  audit_event_id TEXT,                     -- immutable audit event for the decision
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT,
  invalidated_at TEXT                      -- set when the package bytes changed
);
CREATE INDEX IF NOT EXISTS idx_mrev_package ON package_manual_reviews(package_id);
CREATE INDEX IF NOT EXISTS idx_mrev_status ON package_manual_reviews(status);
CREATE INDEX IF NOT EXISTS idx_mrev_sha ON package_manual_reviews(sha256);

ALTER TABLE package_security_overrides ADD COLUMN sha256 TEXT;
ALTER TABLE package_security_overrides ADD COLUMN invalidated_at TEXT;
