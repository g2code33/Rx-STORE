-- Stable native identities let RX Store detect/open existing installations.
ALTER TABLE applications ADD COLUMN android_package_id TEXT;
ALTER TABLE applications ADD COLUMN windows_uninstall_key TEXT;
ALTER TABLE applications ADD COLUMN windows_executable TEXT;
ALTER TABLE applications ADD COLUMN linux_package_name TEXT;
ALTER TABLE applications ADD COLUMN linux_executable TEXT;
