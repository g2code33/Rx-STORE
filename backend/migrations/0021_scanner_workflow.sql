-- 0021: Streaming security pipeline — scanner workflow metadata + scan cache.
--
-- Backs the production fix for large-package publication:
--   * package_security_results gains scanner workflow columns (analysis id,
--     timestamps, normalized verdict + summary). Raw provider payloads are
--     deliberately NOT stored. Every (re)scan still creates a NEW row —
--     history is never destroyed.
--   * scanner_cache: one row per exact byte-hash (SHA-256) so the same
--     package is not re-uploaded to VirusTotal unnecessarily. Rows carry a
--     freshness policy (VT_SCAN_MAX_AGE_HOURS, default 720h/30d) — stale
--     rows are ignored and rescanned. A 'SCANNING' row resumes polling an
--     in-flight analysis instead of re-uploading.
--
-- Additive only — no destructive change, existing rows untouched.
--
-- Run: npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0021_scanner_workflow.sql
-- Safe to re-run (IF NOT EXISTS + best-effort ALTERs).

ALTER TABLE package_security_results ADD COLUMN scanner_analysis_id TEXT;
ALTER TABLE package_security_results ADD COLUMN scanner_started_at TEXT;
ALTER TABLE package_security_results ADD COLUMN scanner_completed_at TEXT;
ALTER TABLE package_security_results ADD COLUMN scanner_last_checked_at TEXT;
ALTER TABLE package_security_results ADD COLUMN scanner_verdict TEXT;
ALTER TABLE package_security_results ADD COLUMN scanner_raw_summary TEXT;

CREATE TABLE IF NOT EXISTS scanner_cache (
  sha256 TEXT PRIMARY KEY,                  -- exact byte identity (never filename/platform)
  provider TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('CLEAN','DETECTED','SCANNING')),
  analysis_id TEXT,
  malicious INTEGER DEFAULT 0,
  suspicious INTEGER DEFAULT 0,
  harmless INTEGER DEFAULT 0,
  undetected INTEGER DEFAULT 0,
  scanned_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scanner_cache_scanned ON scanner_cache(scanned_at);
