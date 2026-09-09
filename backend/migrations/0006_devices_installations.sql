-- 0006: account-aware device + installation registry.
--
-- Adds a persistent device table and a per (device, application) installation
-- record so RX Store can track actual installation state per account/device,
-- independent of the `downloads` ledger (which is only a download log).
--
-- DESIGN NOTES
--   - `devices.id` is an INTERNAL row id; `devices.device_id` is the stable
--     client-generated identifier that survives restart/login/logout.
--   - UNIQUE(user_id, device_id): the SAME physical install registered under
--     two different accounts gets its OWN row, so account state is isolated on
--     shared computers. A device never becomes a duplicate on every start.
--   - `app_installations.device_id` references `devices.id` (the internal row).
--
-- Run once against production D1:
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0006_devices_installations.sql
-- Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,           -- stable client per-install id
  device_name TEXT,
  platform TEXT,                     -- 'windows' | 'linux' | 'android' | 'web'
  device_type TEXT,                  -- 'phone' | 'tablet' | 'desktop' | 'pwa'
  os_version TEXT,
  rx_store_version TEXT,
  app_version TEXT,
  last_seen_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  revoked_at TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','revoked')),
  UNIQUE(user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_device_id ON devices(device_id);

-- One current installation record per (device, application). Cloud state is
-- LAST-KNOWN info for *other* devices; the local device's native detection is
-- authoritative. Updated idempotently (never duplicated on re-detection).
CREATE TABLE IF NOT EXISTS app_installations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  platform TEXT,
  installed_version TEXT,
  status TEXT DEFAULT 'not_installed' CHECK (status IN
    ('not_installed','installed','update_available','installing','updating',
     'uninstalling','install_failed','update_failed','uninstall_failed','unknown')),
  detection_source TEXT,
  last_detected_at TEXT,
  installed_at TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(device_id, application_id)
);
CREATE INDEX IF NOT EXISTS idx_app_installations_user ON app_installations(user_id);
CREATE INDEX IF NOT EXISTS idx_app_installations_device ON app_installations(device_id);
CREATE INDEX IF NOT EXISTS idx_app_installations_app ON app_installations(application_id);
