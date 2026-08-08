-- 0004: applications columns that newer code writes (features / release_notes / deleted_at).
-- Code tolerates their absence, so this is optional but recommended for full fidelity.
-- Run once (D1 errors on an already-existing column for that statement only — safe to re-run):
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0004_applications_columns.sql
ALTER TABLE applications ADD COLUMN features TEXT DEFAULT '[]';
ALTER TABLE applications ADD COLUMN release_notes TEXT DEFAULT '[]';
ALTER TABLE applications ADD COLUMN deleted_at TEXT;
