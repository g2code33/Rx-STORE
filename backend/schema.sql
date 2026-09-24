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
  -- 1 = user has an active advertisement running (admin flag)
  advertiser INTEGER DEFAULT 0,
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
  -- The app's own website — opened by the ↗ button on the app detail page
  website TEXT,
  android_package_id TEXT,
  windows_uninstall_key TEXT,
  windows_executable TEXT,
  linux_package_name TEXT,
  linux_executable TEXT,
  icon TEXT,
  color TEXT,
  gradient TEXT,
  screenshots TEXT DEFAULT '[]',
  features TEXT DEFAULT '[]',
  release_notes TEXT DEFAULT '[]',
  status TEXT DEFAULT 'active' CHECK (status IN ('active','beta','coming-soon','archived','draft','submitted','under_review','changes_requested','suspended')),
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
  created_at TEXT DEFAULT (datetime('now')),
  -- Phase 19: 'install' (first download by a user) | 'update' (subsequent),
  -- derived server-side; country-level geo (privacy-safe aggregation only).
  kind TEXT DEFAULT 'install',
  country TEXT
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
  -- Phase 17: title/body metadata, factual evidence marker, moderation
  -- state (rows are NEVER deleted — hidden/removed are statuses), developer
  -- responses (attributable).
  title TEXT,
  app_version TEXT,
  platform TEXT,
  verified_install INTEGER DEFAULT 0,
  status TEXT DEFAULT 'visible',
  moderation_reason TEXT,
  moderated_at TEXT,
  moderated_by TEXT,
  developer_response TEXT,
  developer_responded_at TEXT,
  developer_responder_id TEXT,
  UNIQUE(app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_app_status ON reviews(app_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);
CREATE TABLE IF NOT EXISTS review_reports (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reporter_user_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('spam','harassment','irrelevant','fraudulent','malicious_content','other')),
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(review_id, reporter_user_id)
);
CREATE INDEX IF NOT EXISTS idx_review_reports_review ON review_reports(review_id);
CREATE INDEX IF NOT EXISTS idx_review_reports_status ON review_reports(status);

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
INSERT OR IGNORE INTO ai_settings (id, provider, model) VALUES ('default','nvidia','meta/llama-3.1-8b-instruct');

-- ==================== RELEASE MANAGEMENT (Production) ====================
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  build_number TEXT,
  release_notes TEXT DEFAULT '[]',
  feature_summary TEXT,
  call_to_action TEXT,
  release_type TEXT DEFAULT 'patch' CHECK (release_type IN ('major','minor','patch')),
  channel TEXT DEFAULT 'stable' CHECK (channel IN ('stable','beta','alpha')),
  minimum_supported_version TEXT,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','processing','ready_for_review','submitted','under_review','changes_requested','approved','rejected','published','withdrawn','disabled','rolled_back','archived')),
  developer_id TEXT REFERENCES developers(id),
  reviewer_id TEXT,
  review_reason TEXT,
  security_status TEXT DEFAULT 'pending' CHECK (security_status IN ('pending','processing','passed','failed','needs_review')),
  verification_status TEXT DEFAULT 'pending' CHECK (verification_status IN ('pending','processing','passed','failed','needs_review')),
  deleted_at TEXT,
  published_at TEXT,
  submitted_at TEXT,
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(application_id, version)
);
CREATE INDEX IF NOT EXISTS idx_releases_app ON releases(application_id);
CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status);
CREATE INDEX IF NOT EXISTS idx_releases_version ON releases(version);
CREATE INDEX IF NOT EXISTS idx_releases_developer ON releases(developer_id);
CREATE INDEX IF NOT EXISTS idx_releases_submitted ON releases(submitted_at);
CREATE INDEX IF NOT EXISTS idx_releases_app ON releases(application_id);
CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status);
CREATE INDEX IF NOT EXISTS idx_releases_version ON releases(version);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('android','windows','linux','linux_deb','linux_appimage','flatpak','macos','web','ios','pwa')),
  architecture TEXT NOT NULL DEFAULT 'x64',
  filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT,
  sha256 TEXT NOT NULL,
  version TEXT NOT NULL,
  deployment_url TEXT,
  package_type TEXT DEFAULT 'installer' CHECK (package_type IN ('installer','pwa','zip','other')),
  -- Optional OS compatibility metadata (informational; an app without it is not blocked)
  min_os_version TEXT,
  min_android_sdk INTEGER,
  -- Prompt 13 hooks: real verification pipeline fills these (never the client).
  security_scan_status TEXT DEFAULT 'pending',
  signature_status TEXT DEFAULT 'pending',
  scan_at TEXT,
  verified_at TEXT,
  -- Phase 13: quarantine + the security state machine + overall verdict.
  quarantine_key TEXT,
  security_state TEXT DEFAULT 'QUARANTINED' CHECK (security_state IN ('QUARANTINED','STRUCTURE_CHECK','INTEGRITY_CHECK','DUPLICATE_CHECK','MALWARE_SCAN','SIGNATURE_CHECK','CERTIFICATE_CHECK','DEPENDENCY_SECURITY_CHECK','NATIVE_IDENTITY_CHECK','SECURITY_REVIEW_COMPLETE','SECURITY_OVERRIDE','PUBLISHED')),
  overall_security TEXT DEFAULT 'PENDING' CHECK (overall_security IN ('PENDING','PASSED','FAILED','NEEDS_REVIEW')),
  status TEXT DEFAULT 'stored' CHECK (status IN ('uploading','validating','stored','ready_for_review','published','failed','archived')),
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  -- One artifact per (release, platform, architecture): supports Windows x64 AND
  -- Windows arm64, Android universal AND per-ABI builds, etc.
  UNIQUE(release_id, platform, architecture)
);
CREATE INDEX IF NOT EXISTS idx_packages_release ON packages(release_id);
CREATE INDEX IF NOT EXISTS idx_packages_platform ON packages(platform);
CREATE INDEX IF NOT EXISTS idx_packages_arch ON packages(architecture);

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
('clinical-rx','clinical-rx','Clinical Rx','Advanced clinical decision support','healthcare','Calcitonin Technologies','🏥','active','3.2.1',4.8,156000,'subscription','["web","windows","linux","android","ios"]',1),
('pharmagame','pharmagame','PharmaGAME','Gamified pharmaceutical education','gaming','Calcitonin Technologies','🎮','active','2.4.0',4.9,98000,'free','["web","android","windows"]',1),
('code-rx-society','code-rx-society','Code Rx Society','Healthcare developer platform','technology','Calcitonin Technologies','💻','active','1.8.3',4.7,42000,'free','["web","windows","linux"]',1),
('tawomo','tawomo','TAWOMO','Healthcare workforce management','productivity','Calcitonin Technologies','👥','active','1.2.0',4.5,18000,'subscription','["web","android"]',0),
('curelink','curelink','CureLink','Patient-caregiver communication','healthcare','Calcitonin Technologies','🔗','active','2.1.0',4.6,56000,'subscription','["web","android","ios"]',0);

-- ==================== SITE SETTINGS ====================
-- Live admin toggles (Admin → Settings). Also created lazily by the Worker,
-- so running this schema (or migration 0005) is optional.
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ==================== DEVICES / INSTALLATIONS (account-aware) ====================
-- A physical/logical RX Store install. `id` is an internal row id;
-- `device_id` is the stable client per-install id that survives restarts/logins.
-- UNIQUE(user_id, device_id) isolates the SAME physical install per account
-- (shared computers), and never creates duplicates on every start.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT,
  platform TEXT,                -- 'windows' | 'linux' | 'android' | 'web'
  device_type TEXT,             -- 'phone' | 'tablet' | 'desktop' | 'pwa'
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
-- LAST-KNOWN info for *other* devices; local native detection is authoritative.
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

-- ==================== AUTH SESSIONS (refresh token rotation) ====================
-- Only the SHA-256 HASH of a refresh token is stored (never the raw token).
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  device_id TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_hash ON auth_sessions(token_hash);

-- Phase 13: package security results + admin overrides.
CREATE INDEX IF NOT EXISTS idx_packages_storage_key ON packages(storage_key);
CREATE TABLE IF NOT EXISTS package_security_results (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  release_id TEXT,
  app_id TEXT,
  developer_id TEXT,
  check_type TEXT NOT NULL CHECK (check_type IN ('structure','integrity','duplicate','malware','signature','certificate','dependency','native_identity')),
  status TEXT NOT NULL,
  classification TEXT,
  provider TEXT,
  provider_version TEXT,
  result TEXT,
  details TEXT,
  fingerprint TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_psr_package ON package_security_results(package_id);
CREATE INDEX IF NOT EXISTS idx_psr_check ON package_security_results(package_id, check_type);
CREATE TABLE IF NOT EXISTS package_security_overrides (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  admin_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  prior_state TEXT,
  prior_overall TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pso_package ON package_security_overrides(package_id);

-- Phase 14: submission review lifecycle + events + private thread attachments.
CREATE TABLE IF NOT EXISTS developer_submissions (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL UNIQUE REFERENCES releases(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','SECURITY_REVIEW','ADMIN_REVIEW','REVIEW_SUSPENDED','CHANGES_REQUESTED','APPROVED','REJECTED','WITHDRAWN','PUBLISHED')),
  reviewer_id TEXT,
  review_notes TEXT,
  action_items TEXT DEFAULT '[]',
  decision TEXT,
  submitted_at TEXT,
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dev_submissions_developer ON developer_submissions(developer_id);
CREATE INDEX IF NOT EXISTS idx_dev_submissions_status ON developer_submissions(status);
CREATE TABLE IF NOT EXISTS developer_submission_events (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES developer_submissions(id) ON DELETE CASCADE,
  actor_user_id TEXT,
  actor_role TEXT,
  event TEXT NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dev_submission_events_sub ON developer_submission_events(submission_id);
CREATE TABLE IF NOT EXISTS developer_thread_attachments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES developer_threads(id) ON DELETE CASCADE,
  message_id TEXT,
  uploader_user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  scan_status TEXT DEFAULT 'PENDING' CHECK (scan_status IN ('PENDING','CLEAN','DETECTED','FAILED','UNAVAILABLE')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_thread_attachments_thread ON developer_thread_attachments(thread_id);

-- Phase 15: storefront curation + discovery metadata.
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
-- applications gains privacy_url / support_url / video_url (nullable adds).


-- Phase 18: production marketplace payments, entitlements & ownership.
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  provider TEXT NOT NULL,
  provider_reference TEXT UNIQUE,
  provider_transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','failed','refunded')),
  failure_reason TEXT,
  refunded_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);
CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  purchase_id TEXT REFERENCES purchases(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  provider_transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','REFUNDED','REVOKED','EXPIRED')),
  activated_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT,
  refunded_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, app_id)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_user ON entitlements(user_id);
CREATE INDEX IF NOT EXISTS idx_entitlements_status ON entitlements(status);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'processed' CHECK (status IN ('received','processed','ignored','failed')),
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(provider, event_key)
);
CREATE TABLE IF NOT EXISTS download_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  package_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_download_grants_user ON download_grants(user_id);


-- Phase 19: developer finance.
CREATE TABLE IF NOT EXISTS developer_billing (
  developer_id TEXT PRIMARY KEY REFERENCES developers(id) ON DELETE CASCADE,
  payout_destination TEXT,
  payout_notes TEXT,
  min_payout_minor INTEGER NOT NULL DEFAULT 10000,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS developer_payouts (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'GHS',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','PAID','FAILED','HELD','CANCELLED')),
  period_start TEXT,
  period_end TEXT,
  requested_by TEXT NOT NULL,
  processed_by TEXT,
  processor_reference TEXT,
  failure_reason TEXT,
  paid_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_developer_payouts_dev ON developer_payouts(developer_id);
CREATE INDEX IF NOT EXISTS idx_developer_payouts_status ON developer_payouts(status);
