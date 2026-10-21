-- 0027 — PRIVATE GitHub repositories.
--
-- RX Store now connects private repositories too:
--   * github_repo_connections.repository_private  (1 = private)
--   * github_release_assets.is_private            (1 = private asset)
--   * packages.external_private                   (1 = served through the
--     RX Store asset proxy, because a private asset has no public URL)
--
-- Nothing is copied into RX Store storage: private assets are verified by
-- streaming them through the Worker with a short-lived installation token, and
-- users download them through GET /v1/github-assets/:packageId (published
-- releases only, free apps only).
--
-- Re-running is safe: duplicate column name = already applied.

ALTER TABLE github_repo_connections ADD COLUMN repository_private INTEGER;
ALTER TABLE github_release_assets ADD COLUMN is_private INTEGER DEFAULT 0;
ALTER TABLE packages ADD COLUMN external_private INTEGER DEFAULT 0;
