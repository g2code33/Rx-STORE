-- 0005 — site_settings table (live Admin → Settings toggles).
-- Safe to run multiple times; the Worker also creates it lazily, so this
-- migration is optional and exists for documentation/parity.
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);
