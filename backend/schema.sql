-- Rx Store — D1 Schema (SQLite)
-- SAFE: all objects are rx-store-* only. Uses IF NOT EXISTS.
-- Run: wrangler d1 execute rx-store-db --file=backend/schema.sql
-- Does NOT affect pharmagame or code-rx databases.

-- ==================== USERS (Rx Account / SSO) ====================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  email TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','developer','admin')),
  email_verified INTEGER DEFAULT 0,
  preferences TEXT DEFAULT '{}',
  last_login_at TEXT,
  reset_token TEXT,
  reset_token_expiry TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ==================== APPLICATIONS ====================
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  long_description TEXT,
  category TEXT NOT NULL CHECK (category IN ('healthcare','education','productivity','technology','gaming','social')),
  tags TEXT DEFAULT '[]',
  developer TEXT DEFAULT 'Calcitonin Technologies',
  developer_id TEXT REFERENCES users(id),
  icon TEXT,
  color TEXT,
  gradient TEXT,
  screenshots TEXT DEFAULT '[]',
  status TEXT DEFAULT 'active' CHECK (status IN ('active','beta','coming-soon','archived')),
  deleted_at TEXT,
  current_version TEXT,
  size_mb INTEGER,
  rating REAL DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  download_count INTEGER DEFAULT 0,
  price_type TEXT DEFAULT 'free' CHECK (price_type IN ('free','paid','subscription')),
  price_amount REAL,
  platforms TEXT DEFAULT '[]',
  is_featured INTEGER DEFAULT 0,
  is_new INTEGER DEFAULT 0,
  is_trending INTEGER DEFAULT 0,
  release_date TEXT,
  last_updated TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_applications_slug ON applications(slug);
CREATE INDEX IF NOT EXISTS idx_applications_category ON applications(category);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);

-- Alias `apps` for backend compatibility (view)
CREATE VIEW IF NOT EXISTS apps AS SELECT * FROM applications;

-- ==================== VERSIONS ====================
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  version_number TEXT NOT NULL,
  platform TEXT NOT NULL,
  download_url TEXT NOT NULL,
  release_notes TEXT DEFAULT '[]',
  release_date TEXT DEFAULT (datetime('now')),
  mandatory INTEGER DEFAULT 0,
  files TEXT DEFAULT '{}',
  checksum TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(application_id, version_number, platform)
);
CREATE INDEX IF NOT EXISTS idx_versions_app ON versions(application_id);

-- Legacy table name used by updates route
CREATE TABLE IF NOT EXISTS app_versions (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  release_notes TEXT DEFAULT '[]',
  release_date TEXT DEFAULT (datetime('now')),
  mandatory INTEGER DEFAULT 0,
  files TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(app_id, version)
);

-- ==================== DOWNLOADS ====================
CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  app_id TEXT NOT NULL REFERENCES applications(id),
  device TEXT,
  platform TEXT,
  version TEXT,
  ip_address TEXT,
  user_agent TEXT,
  date TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_downloads_app ON downloads(app_id);
CREATE INDEX IF NOT EXISTS idx_downloads_user ON downloads(user_id);

-- ==================== SUBSCRIPTIONS ====================
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,
  app_id TEXT REFERENCES applications(id),
  status TEXT DEFAULT 'active' CHECK (status IN ('active','cancelled','expired','past_due')),
  expiry TEXT,
  start_date TEXT,
  end_date TEXT,
  amount REAL,
  currency TEXT DEFAULT 'USD',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- ==================== SUPPORTING TABLES ====================
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  helpful_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(app_id, user_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  subscription_id TEXT REFERENCES subscriptions(id),
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'USD',
  provider TEXT NOT NULL CHECK (provider IN ('paystack','mobile_money','hubtel','stripe')),
  provider_transaction_id TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','refunded')),
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('update','download','message','system','payment')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT DEFAULT '{}',
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details TEXT DEFAULT '{}',
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  app_id TEXT NOT NULL REFERENCES applications(id),
  license_key TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('personal','enterprise','trial')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
  max_devices INTEGER DEFAULT 1,
  activated_devices INTEGER DEFAULT 0,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ==================== AI SETTINGS (multi-provider, admin-controllable) ====================
CREATE TABLE IF NOT EXISTS ai_settings (
  id TEXT PRIMARY KEY,
  provider TEXT,
  model TEXT,
  api_key TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO ai_settings (id, provider, model) VALUES ('default','nvidia','meta/llama-3.1-70b-instruct');

-- ==================== RELEASE MANAGEMENT (Production) ====================
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  release_notes TEXT DEFAULT '[]',
  release_type TEXT DEFAULT 'patch' CHECK (release_type IN ('major','minor','patch')),
  channel TEXT DEFAULT 'stable' CHECK (channel IN ('stable','beta','alpha')),
  minimum_supported_version TEXT,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','processing','ready_for_review','published','disabled','rolled_back','archived')),
  deleted_at TEXT,
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(application_id, version)
);
CREATE INDEX IF NOT EXISTS idx_releases_app ON releases(application_id);
CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status);
CREATE INDEX IF NOT EXISTS idx_releases_version ON releases(version);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('android','windows','linux_deb','linux_appimage','flatpak','web')),
  architecture TEXT DEFAULT 'x64',
  filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT,
  sha256 TEXT NOT NULL,
  version TEXT NOT NULL,
  deployment_url TEXT,
  package_type TEXT DEFAULT 'installer' CHECK (package_type IN ('installer','pwa','zip','other')),
  status TEXT DEFAULT 'stored' CHECK (status IN ('uploading','validating','stored','ready_for_review','published','failed','archived')),
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_packages_release ON packages(release_id);
CREATE INDEX IF NOT EXISTS idx_packages_platform ON packages(platform);

CREATE TABLE IF NOT EXISTS upload_jobs (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  release_id TEXT REFERENCES releases(id),
  platform TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_size INTEGER,
  status TEXT DEFAULT 'uploading' CHECK (status IN ('uploading','validating','processing','stored','ready_for_review','published','failed')),
  sha256 TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS download_statistics (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  release_id TEXT REFERENCES releases(id),
  package_id TEXT REFERENCES packages(id),
  platform TEXT,
  architecture TEXT,
  channel TEXT,
  user_id TEXT REFERENCES users(id),
  anonymous_id TEXT,
  status TEXT DEFAULT 'success',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dlstats_app ON download_statistics(application_id);
CREATE INDEX IF NOT EXISTS idx_dlstats_release ON download_statistics(release_id);

-- ==================== SEED (idempotent) ====================
INSERT OR IGNORE INTO applications (id, slug, name, description, category, developer, icon, status, current_version, rating, download_count, price_type, platforms, is_featured) VALUES
('clinical-rx','clinical-rx','Clinical Rx','Advanced clinical decision support','healthcare','Calcitonin Technologies','/v1.png','active','3.2.1',4.8,156000,'subscription','["web","windows","linux","android","ios"]',1),
('pharmagame','pharmagame','PharmaGAME','Gamified pharmaceutical education','gaming','Calcitonin Technologies','🎮','active','2.4.0',4.9,98000,'free','["web","android","windows"]',1),
('code-rx-society','code-rx-society','Code Rx Society','Healthcare developer platform','technology','Calcitonin Technologies','💻','active','1.8.3',4.7,42000,'free','["web","windows","linux"]',1),
('tawomo','tawomo','TAWOMO','Healthcare workforce management','productivity','Calcitonin Technologies','👥','active','1.2.0',4.5,18000,'subscription','["web","android"]',0),
('curelink','curelink','CureLink','Patient-caregiver communication','healthcare','Calcitonin Technologies','🔗','active','2.1.0',4.6,56000,'subscription','["web","android","ios"]',0);
