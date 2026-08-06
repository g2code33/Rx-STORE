# RX Store Database Schema

## Overview
- Primary Database: PostgreSQL 15+ (or Cloudflare D1 for edge deployments)
- Cache Layer: Redis / Cloudflare KV
- Object Storage: Cloudflare R2

---

## Tables

### users
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    avatar_url TEXT,
    role VARCHAR(50) DEFAULT 'user' CHECK (role IN ('user', 'admin', 'developer')),
    email_verified BOOLEAN DEFAULT FALSE,
    two_factor_enabled BOOLEAN DEFAULT FALSE,
    two_factor_secret TEXT,
    preferences JSONB DEFAULT '{}',
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
```

### apps
```sql
CREATE TABLE apps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    long_description TEXT,
    category VARCHAR(50) NOT NULL CHECK (category IN ('healthcare', 'education', 'productivity', 'technology', 'gaming', 'social')),
    tags TEXT[] DEFAULT '{}',
    icon VARCHAR(10),
    color VARCHAR(7),
    gradient VARCHAR(100),
    developer_id UUID REFERENCES users(id),
    current_version VARCHAR(50),
    size_mb INTEGER,
    rating DECIMAL(3,2) DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    download_count BIGINT DEFAULT 0,
    price_type VARCHAR(20) DEFAULT 'free' CHECK (price_type IN ('free', 'paid', 'subscription')),
    price_amount DECIMAL(10,2),
    platforms TEXT[] DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'beta', 'coming-soon', 'archived')),
    is_featured BOOLEAN DEFAULT FALSE,
    is_new BOOLEAN DEFAULT FALSE,
    is_trending BOOLEAN DEFAULT FALSE,
    release_date DATE,
    last_updated TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_apps_slug ON apps(slug);
CREATE INDEX idx_apps_category ON apps(category);
CREATE INDEX idx_apps_status ON apps(status);
CREATE INDEX idx_apps_download_count ON apps(download_count DESC);
CREATE INDEX idx_apps_rating ON apps(rating DESC);
CREATE INDEX idx_apps_tags ON apps USING GIN(tags);
```

### app_versions
```sql
CREATE TABLE app_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    version VARCHAR(50) NOT NULL,
    release_notes TEXT[],
    release_date TIMESTAMPTZ DEFAULT NOW(),
    mandatory BOOLEAN DEFAULT FALSE,
    files JSONB, -- Platform-specific file info
    -- files structure: { "windows": { "url": "...", "size": 148, "checksum": "..." }, ... }
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_app_versions_app_id ON app_versions(app_id);
CREATE UNIQUE INDEX idx_app_versions_unique ON app_versions(app_id, version);
```

### reviews
```sql
CREATE TABLE reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    helpful_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(app_id, user_id)
);

CREATE INDEX idx_reviews_app_id ON reviews(app_id);
CREATE INDEX idx_reviews_user_id ON reviews(user_id);
CREATE INDEX idx_reviews_rating ON reviews(rating);
```

### subscriptions
```sql
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    app_id UUID NOT NULL REFERENCES apps(id),
    plan_name VARCHAR(100) NOT NULL,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired', 'past_due')),
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    billing_cycle VARCHAR(20) DEFAULT 'monthly',
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_app_id ON subscriptions(app_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
```

### payments
```sql
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    subscription_id UUID REFERENCES subscriptions(id),
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    provider VARCHAR(50) NOT NULL CHECK (provider IN ('paystack', 'mobile_money', 'hubtel', 'stripe')),
    provider_transaction_id VARCHAR(255),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_provider ON payments(provider);
```

### downloads
```sql
CREATE TABLE downloads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    app_id UUID NOT NULL REFERENCES apps(id),
    version VARCHAR(50),
    platform VARCHAR(20) NOT NULL,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_downloads_app_id ON downloads(app_id);
CREATE INDEX idx_downloads_user_id ON downloads(user_id);
CREATE INDEX idx_downloads_created_at ON downloads(created_at DESC);
```

### notifications
```sql
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL CHECK (type IN ('update', 'download', 'message', 'system', 'payment')),
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    data JSONB DEFAULT '{}',
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_read ON notifications(read) WHERE read = FALSE;
```

### audit_logs
```sql
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id UUID,
    details JSONB DEFAULT '{}',
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
```

### licenses
```sql
CREATE TABLE licenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    app_id UUID NOT NULL REFERENCES apps(id),
    license_key VARCHAR(255) UNIQUE NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('personal', 'enterprise', 'trial')),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
    max_devices INTEGER DEFAULT 1,
    activated_devices INTEGER DEFAULT 0,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_licenses_user_id ON licenses(user_id);
CREATE INDEX idx_licenses_license_key ON licenses(license_key);
```

---

## Views

### app_stats
```sql
CREATE VIEW app_stats AS
SELECT
    a.id,
    a.name,
    a.slug,
    a.download_count,
    a.rating,
    a.review_count,
    COUNT(DISTINCT d.user_id) as unique_downloaders,
    COUNT(d.id) as total_downloads_30d,
    COUNT(CASE WHEN d.created_at > NOW() - INTERVAL '7 days' THEN 1 END) as downloads_7d
FROM apps a
LEFT JOIN downloads d ON d.app_id = a.id AND d.created_at > NOW() - INTERVAL '30 days'
GROUP BY a.id;
```

### revenue_summary
```sql
CREATE VIEW revenue_summary AS
SELECT
    DATE_TRUNC('month', p.created_at) as month,
    SUM(p.amount) as total_revenue,
    COUNT(DISTINCT p.user_id) as paying_users,
    COUNT(p.id) as transaction_count
FROM payments p
WHERE p.status = 'completed'
GROUP BY DATE_TRUNC('month', p.created_at)
ORDER BY month DESC;
```

---

## Storage Structure (Cloudflare R2)

```
rx-store-cloud/
├── apps/
│   ├── clinical-rx/
│   │   ├── 3.2.1/
│   │   │   ├── android/app.apk
│   │   │   ├── windows/installer.exe
│   │   │   ├── linux/package.AppImage
│   │   │   ├── linux/package.deb
│   │   │   ├── linux/flatpak/
│   │   │   ├── ios/app.ipa
│   │   │   └── web/build.zip
│   │   ├── 3.2.0/
│   │   └── latest.json
│   ├── pharmagame/
│   ├── code-rx-society/
│   ├── tawomo/
│   └── curelink/
├── assets/
│   ├── logos/
│   │   ├── clinical-rx.png
│   │   ├── pharmagame.png
│   │   └── ...
│   ├── screenshots/
│   │   ├── clinical-rx/
│   │   │   ├── 1.webp
│   │   │   ├── 2.webp
│   │   │   └── 3.webp
│   │   └── ...
│   ├── videos/
│   └── documents/
└── releases/
    ├── clinical-rx/
    │   └── version.json
    └── ...
```
