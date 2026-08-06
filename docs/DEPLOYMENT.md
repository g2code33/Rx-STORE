# RX Store Deployment Guide

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        CDN (Cloudflare)                       │
├────────────┬────────────┬───────────────┬───────────────────┤
│  Web App   │  API GW    │  R2 Storage   │  KV/D1 Cache     │
│  (Pages)   │  (Workers) │  (Assets)     │  (Sessions)      │
├────────────┴────────────┴───────────────┴───────────────────┤
│                    Backend Services                           │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────────┐  │
│  │ Auth Svc │ │ App Svc  │ │ Pay Svc   │ │ AI Service   │  │
│  └──────────┘ └──────────┘ └───────────┘ └──────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌───────────┐                   │
│  │PostgreSQL│ │  Redis   │ │ R2 Store  │                   │
│  └──────────┘ └──────────┘ └───────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Environment Variables

### Required
```env
# Application
NODE_ENV=production
PORT=8080
API_BASE_URL=https://api.rxstore.com
WEB_APP_URL=https://rxstore.com

# Database
DATABASE_URL=postgresql://user:pass@host:5432/rxstore
DATABASE_POOL_SIZE=20

# Redis
REDIS_URL=redis://user:pass@host:6379

# Cloudflare
CLOUDFLARE_ACCOUNT_ID=xxx
CLOUDFLARE_R2_BUCKET=rx-store-cloud
CLOUDFLARE_R2_ACCESS_KEY=xxx
CLOUDFLARE_R2_SECRET_KEY=xxx

# Authentication
JWT_SECRET=your-256-bit-secret
JWT_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d
BCRYPT_ROUNDS=12

# Payment Providers
PAYSTACK_PUBLIC_KEY=pk_xxx
PAYSTACK_SECRET_KEY=sk_xxx
PAYSTACK_WEBHOOK_SECRET=xxx

MOBILE_MERCHANT_ID=xxx
MOBILE_MERCHANT_KEY=xxx

HUBTEL_ACCOUNT_NUMBER=xxx
HUBTEL_CLIENT_ID=xxx
HUBTEL_CLIENT_SECRET=xxx

# AI Services
OPENAI_API_KEY=sk-xxx
OPENAI_MODEL=gpt-4
AI_RATE_LIMIT=30

# Email
SMTP_HOST=smtp.provider.com
SMTP_PORT=587
SMTP_USER=noreply@rxstore.com
SMTP_PASS=xxx
FROM_EMAIL=noreply@rxstore.com

# Security
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX=100
CORS_ORIGIN=https://rxstore.com
FILE_UPLOAD_MAX_SIZE=524288000
ALLOWED_FILE_TYPES=.apk,.exe,.deb,.AppImage,.dmg,.ipa,.zip
```

---

## Deployment Options

### Option 1: Cloudflare Stack (Recommended)

**Web Frontend:**
```bash
# Build
npm run build

# Deploy to Cloudflare Pages
npx wrangler pages deploy dist --project-name=rx-store
```

**Backend API:**
```bash
# Deploy to Cloudflare Workers
npx wrangler deploy

# wrangler.toml
name = "rx-store-api"
main = "src/worker.ts"
compatibility_date = "2024-01-01"

[vars]
ENVIRONMENT = "production"

[[d1_databases]]
binding = "DB"
database_name = "rx-store-db"
database_id = "xxx"

[[r2_buckets]]
binding = "STORAGE"
bucket_name = "rx-store-cloud"

[[kv_namespaces]]
binding = "CACHE"
id = "xxx"
```

### Option 2: Traditional Server (Node.js)

**Prerequisites:**
- Node.js 18+
- PostgreSQL 15+
- Redis 7+
- Nginx (reverse proxy)

**Setup:**
```bash
# Clone repository
git clone https://github.com/calcitonin-tech/rx-store.git
cd rx-store/backend

# Install dependencies
npm install

# Run migrations
npm run db:migrate

# Seed initial data
npm run db:seed

# Build
npm run build

# Start with PM2
pm2 start dist/server.js --name rx-store-api -i max
```

**Nginx Configuration:**
```nginx
server {
    listen 443 ssl http2;
    server_name api.rxstore.com;

    ssl_certificate /etc/ssl/rxstore.crt;
    ssl_certificate_key /etc/ssl/rxstore.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # File upload size
        client_max_body_size 500M;
    }
}
```

### Option 3: Docker

**docker-compose.yml:**
```yaml
version: '3.8'

services:
  web:
    build: ./frontend
    ports:
      - "3000:80"
    depends_on:
      - api

  api:
    build: ./backend
    ports:
      - "8080:8080"
    environment:
      - DATABASE_URL=postgresql://postgres:password@db:5432/rxstore
      - REDIS_URL=redis://redis:6379
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      - db
      - redis

  db:
    image: postgres:15
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: rxstore
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password

  redis:
    image: redis:7-alpine
    volumes:
      - redisdata:/data

  minio:
    image: minio/minio
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
    volumes:
      - miniodata:/data

volumes:
  pgdata:
  redisdata:
  miniodata:
```

---

## Desktop Applications

### Windows (Tauri)
```bash
cd desktop/tauri
npm install
npm run tauri build
# Output: src-tauri/target/release/bundle/msi/RX-Store-Setup.msi
```

### Linux
```bash
# AppImage
npm run tauri build
# Output: src-tauri/target/release/bundle/appimage/RX-Store.appimage

# .deb package
sudo apt install -y dpkg-deb
npm run tauri build -- --bundles deb
# Output: src-tauri/target/release/bundle/deb/rx-store_1.0.0_amd64.deb

# Flatpak
flatpak-builder --repo=repo build-dir org.rxstore.Store.json
flatpak build-bundle repo rx-store.flatpak org.rxstore.Store
```

---

## Mobile Applications

### Build
```bash
cd mobile/flutter

# Android
flutter build apk --release
flutter build appbundle --release  # For Play Store

# iOS
flutter build ios --release
# Open in Xcode for Archive + Distribute
```

### CI/CD Pipeline
```yaml
# .github/workflows/mobile.yml
name: Mobile Build
on:
  push:
    tags: ['mobile-v*']

jobs:
  android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
      - run: cd mobile/flutter && flutter build apk --release
      - uses: actions/upload-artifact@v4
        with:
          name: android-apk
          path: mobile/flutter/build/app/outputs/flutter-apk/app-release.apk

  ios:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
      - run: cd mobile/flutter && flutter build ios --release --no-codesign
```

---

## Monitoring & Observability

### Health Check Endpoint
```
GET /health
```

### Metrics
- Prometheus endpoint: `GET /metrics`
- Structured logging with correlation IDs
- Distributed tracing with OpenTelemetry

### Alerting
- Uptime monitoring (external)
- Error rate alerts (>1%)
- Latency alerts (p95 > 2s)
- Database connection pool alerts (>80%)
