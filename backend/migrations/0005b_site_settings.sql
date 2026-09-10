-- 0005b — site_settings table (live Admin → Settings toggles).
--
-- MIGRATION NUMBERING NOTE: this file was originally named
-- `0005_site_settings.sql`, which COLLIDED with `0005_native_app_identity.sql`.
-- It has been renamed to `0005b_...` to remove the duplicate number without
-- changing execution order (it still sorts after 0005_native_app_identity).
-- The rename is safe: the file is idempotent and re-naming does not re-run it
-- for anyone who already applied the old filename.
-- Safe to run multiple times; the Worker also creates it lazily, so this
-- migration is optional and exists for documentation/parity.
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);
