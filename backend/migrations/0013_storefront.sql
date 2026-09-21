-- 0013: Storefront & Discovery (Phase 15).
--
-- Admin-configurable featured content (ordering + date windows + banners) and
-- the app-detail metadata the storefront now surfaces. No fake data: sections
-- are computed from REAL marketplace signals (downloads, ratings, dates,
-- categories, admin curation).
--
-- Tables:
--   storefront_featured  admin-curated placements (home hero/featured/games)
--                        with sort_order, start/end dates, banner + promo text
-- Columns on applications (nullable adds — safe):
--   privacy_url, support_url, video_url
--
-- Hero/section configuration lives in the EXISTING site_settings table
-- (storefront.hero.* keys) so admins manage it without source edits.
--
-- Run once (ALTERs fail harmlessly with 'duplicate column name' if re-run):
--   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0013_storefront.sql

CREATE TABLE IF NOT EXISTS storefront_featured (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  placement TEXT NOT NULL DEFAULT 'home_featured' CHECK (placement IN ('home_featured','games_featured','apps_featured')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  banner_url TEXT,
  promo_text TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_storefront_featured_placement ON storefront_featured(placement, enabled, sort_order);
CREATE INDEX IF NOT EXISTS idx_storefront_featured_app ON storefront_featured(app_id);

ALTER TABLE applications ADD COLUMN privacy_url TEXT;
ALTER TABLE applications ADD COLUMN support_url TEXT;
ALTER TABLE applications ADD COLUMN video_url TEXT;
