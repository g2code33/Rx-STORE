-- 0011: Package Security & Verification pipeline (Phase 13).
--
-- Adds the persistent security model on top of the EXISTING packages table
-- (no rebuilds, no data loss):
--   packages.quarantine_key   storage key while quarantined (private)
--   packages.security_state   pipeline position (state machine, see below)
--   packages.overall_security PASSED | FAILED | NEEDS_REVIEW | PENDING
--
-- New tables:
--   package_security_results   one row per (package, check, run) — the audit
--                              history of every automated check
--   package_security_overrides explicit admin overrides (reason required)
--
-- Pipeline state machine (a package can never skip stages):
--   QUARANTINED -> STRUCTURE_CHECK -> INTEGRITY_CHECK -> DUPLICATE_CHECK ->
--   MALWARE_SCAN -> SIGNATURE_CHECK -> CERTIFICATE_CHECK ->
--   DEPENDENCY_SECURITY_CHECK -> NATIVE_IDENTITY_CHECK ->
--   SECURITY_REVIEW_COMPLETE -> PUBLISHED
--   (SECURITY_OVERRIDE is the only bypass, admin-only, reason REQUIRED.)
--
-- Serving-layer privacy: uploads now land under quarantine/ and the /r2/
-- Worker route serves apps/* and quarantine/* objects ONLY when the owning
-- package row is published. Unpublished binaries are not reachable by URL.
--
-- Run once (ALTERs fail with 'duplicate column name' if already applied —
-- that is the only non-idempotent part and is harmless):
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0011_package_security.sql

ALTER TABLE packages ADD COLUMN quarantine_key TEXT;
ALTER TABLE packages ADD COLUMN security_state TEXT DEFAULT 'QUARANTINED'
  CHECK (security_state IN ('QUARANTINED','STRUCTURE_CHECK','INTEGRITY_CHECK','DUPLICATE_CHECK','MALWARE_SCAN','SIGNATURE_CHECK','CERTIFICATE_CHECK','DEPENDENCY_SECURITY_CHECK','NATIVE_IDENTITY_CHECK','SECURITY_REVIEW_COMPLETE','SECURITY_OVERRIDE','PUBLISHED'));
ALTER TABLE packages ADD COLUMN overall_security TEXT DEFAULT 'PENDING'
  CHECK (overall_security IN ('PENDING','PASSED','FAILED','NEEDS_REVIEW'));

-- Serving-layer gate lookup (is this storage key a PUBLISHED package?)
CREATE INDEX IF NOT EXISTS idx_packages_storage_key ON packages(storage_key);

CREATE TABLE IF NOT EXISTS package_security_results (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  release_id TEXT,
  app_id TEXT,
  developer_id TEXT,
  check_type TEXT NOT NULL CHECK (check_type IN ('structure','integrity','duplicate','malware','signature','certificate','dependency','native_identity')),
  status TEXT NOT NULL,
  classification TEXT,                -- e.g. EXACT_DUPLICATE / REPLACEMENT_CONFLICT / NEW_PACKAGE
  provider TEXT,
  provider_version TEXT,
  result TEXT,                        -- machine-readable short result
  details TEXT,                       -- safe, non-sensitive explanation
  fingerprint TEXT,                   -- certificate / signature fingerprint when applicable
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_psr_package ON package_security_results(package_id);
CREATE INDEX IF NOT EXISTS idx_psr_check ON package_security_results(package_id, check_type);
CREATE INDEX IF NOT EXISTS idx_psr_created ON package_security_results(created_at);

CREATE TABLE IF NOT EXISTS package_security_overrides (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  admin_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,               -- REQUIRED, enforced server-side (min 10 chars)
  prior_state TEXT,
  prior_overall TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pso_package ON package_security_overrides(package_id);
