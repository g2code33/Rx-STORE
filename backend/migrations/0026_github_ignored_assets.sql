-- 0026 — Record which GitHub release assets were deliberately skipped.
--
-- Asset mapping now ignores build noise (elevate.exe, *.blockmap, latest*.yml,
-- checksum/signature sidecars, debug APKs…) and, when several candidates claim
-- the same platform/architecture, it prefers the real installer instead of
-- blocking the whole release. What was skipped is stored here (JSON) so the
-- admin sees the complete picture in GitHub Releases & Approvals.
--
-- Re-running is safe: duplicate column name = already applied (standard signal).

ALTER TABLE github_releases ADD COLUMN ignored_assets TEXT;
