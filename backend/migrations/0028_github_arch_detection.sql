-- 0028 — Architecture inferred from the BINARY (not just the filename).
--
-- Linux installers frequently ship without an architecture marker
-- (electron-builder: RX-Store-1.7.6.deb / RX-Store-1.7.6.AppImage). Those were
-- previously dropped as unmapped, so a release with an APK + EXE silently lost
-- its Linux packages. The mapping now defaults to x64 and flags the assumption
-- here; verification reads the real machine type from the bytes (ELF
-- e_machine / deb control 'Architecture:' / PE machine) and corrects it.
--
-- Re-running is safe: duplicate column name = already applied.

ALTER TABLE github_release_assets ADD COLUMN arch_assumed INTEGER DEFAULT 0;
ALTER TABLE packages ADD COLUMN arch_assumed INTEGER DEFAULT 0;
