# RX Store — System Architecture

> **Parent Company:** Calcitonin Technologies  
> **Type:** Central Marketplace + Update Manager + Account Platform  
> **Status:** New ecosystem — must NOT interfere with existing Cloudflare resources

---

## 1. Vision Diagram

```
                        ┌─────────────────┐
                        │   RX STORE      │
                        │  (Marketplace)  │
                        └────────┬────────┘
                                 │
                    ┌────────────┴────────────┐
                    │   Rx Cloud Platform     │
                    │  rx-store-api (Worker)  │
                    │  rx-store-db (D1)       │
                    │  rx-store-storage (R2)  │
                    │  CACHE (KV)             │
                    └────────────┬────────────┘
                                 │
        ┌────────────┬───────────┼───────────┬────────────┐
        │            │           │           │            │
   Web Store   Mobile App  Windows App  Linux App   Future Platforms
   (Pages)     (Flutter)   (Tauri)      (Tauri)
        │            │           │           │
        └────────────┴─────┬─────┴───────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   Clinical Rx      PharmaGAME      Code Rx Society
   (standalone)    (existing)       (existing)
        │                  │                  │
   TAWOMO           CureLink          Future Apps
        │                  │                  │
        └──────────────────┴──────────────────┘
                           │
                    Rx Account (JWT/OAuth)
                    Single Sign-On across all apps
```

### Key Principle: API-Only Integration

```
PharmaGAME  ──API──>  Rx Store Backend  <──API──  Code Rx Society
                            ↑
                            │ API
                            │
                        Clinical Rx
```

- **No codebase merging.** Each app remains independent repository/deployment.
- Rx Store exposes REST APIs; satellite apps call them for auth, updates, licensing.
- Satellite apps NEVER share D1/R2 with Rx Store — isolated resources.

---

## 2. Cloudflare Resource Plan (Safe Coexistence)

All **new** resources use prefix `rx-store-*`. Existing resources untouched.

| Resource | Type | Name | Purpose |
|----------|------|------|---------|
| **rx-store-web** | Pages | `rx-store-web` | React frontend |
| **rx-store-api** | Workers | `rx-store-api` | Backend API |
| **rx-store-db** | D1 | `rx-store-db` | Marketplace database |
| **rx-store-storage** | R2 | `rx-store-storage` | App binaries, assets, releases |
| **rx-store-cache** | KV | `rx-store-cache` | Sessions, rate-limit counters |

**Existing — DO NOT MODIFY:**
- `pharmagame-*` (Pages, Worker, D1, R2)
- `code-rx-*` (Pages, Worker, D1, R2)

Deploy commands are scoped:

```bash
wrangler d1 create rx-store-db          # new DB only
wrangler r2 bucket create rx-store-storage
wrangler pages deploy dist --project-name=rx-store-web
wrangler deploy --config backend/wrangler.toml  # only rx-store-api
```

No `wrangler delete`, no cross-binding.

---

## 3. Database Schema (see DATABASE.md + backend/schema.sql)

Core tables (D1, SQLite-compatible):

- `users` — Rx Account (id, username, email, password_hash, role, created_at)
- `applications` — app catalog (id, name, description, category, developer, icon, screenshots, status)
- `versions` — per-app releases (id, application_id, version_number, platform, download_url, release_notes, release_date)
- `downloads` — telemetry (id, user_id, app_id, device, date)
- `subscriptions` — billing (id, user_id, plan, status, expiry)
- plus: `reviews`, `payments`, `notifications`, `audit_logs`, `licenses`, `app_versions`

All DDL uses `IF NOT EXISTS`. No migration touches `pharmagame` or `code-rx` databases.

---

## 4. Storage Structure (R2: rx-store-storage)

```
/apps
  /clinical-rx/{android,windows,linux}/
  /pharmagame/{android,windows,linux}/
  /code-rx/{...}/
  /tawomo/
  /curelink/
/assets/{icons,screenshots,videos,documents}/
/releases/versions.json   — global manifest for updaters
```

Releases addressed by signed URLs with expiry + checksum verification.

---

## 5. API Design (see API.md)

Base: `https://api.rxstore.com/v1` (Worker route)

| Group | Endpoint | Auth |
|-------|----------|------|
| Auth | `POST /auth/register|login|refresh|logout` | no / yes |
| Apps | `GET /apps`, `GET /apps/:slug`, `GET /categories` | no |
| Updates | `GET /api/update/check?app=&currentVersion=&platform=` | no |
| Users | `GET/PATCH /users/me`, `/users/me/apps` | yes |
| Payments | `POST /payments/subscribe`, `POST /payments/verify` | yes |
| AI | `POST /ai/chat`, `POST /ai/recommend` | yes |
| Admin | `POST /admin/apps`, `POST /admin/apps/:id/releases` | admin |

Update response (universal):

```json
{
  "application": "PharmaGAME",
  "currentVersion": "1.0",
  "latestVersion": "1.2",
  "updateAvailable": true,
  "downloadURL": "https://cdn.rxstore.com/...",
  "mandatory": false
}
```

All apps poll same endpoint.

---

## 6. Authentication — Rx Account (SSO)

- Single JWT (access 15m + refresh 7d) issued by `rx-store-api`.
- Satellite apps validate via `GET /auth/verify` or shared `JWT_SECRET`.
- OAuth ready (Google, GitHub) via Workers OAuth.
- Roles: `user` | `developer` | `admin` — enforced in middleware.

---

## 7. Frontend / Desktop / Mobile

- **Web:** React 18 + TS + Tailwind + React Router (Pages: Home, Browse, AppDetail, Categories, Downloads, My Apps, Profile, Developer Dashboard, Admin)
- **Desktop:** Tauri 1.6 (`com.calcitonin.rxstore`) — browse/install/update/launch, background updater polling `/api/update/check`, system tray.
- **Mobile:** Flutter 3.2 (`rx_store`) — browse, login, notifications, app management, subscriptions. Distinct from `pharmagame`/`code_rx` apps.

---

## 8. AI Service Layer

Worker route `POST /ai/chat` proxies to configurable provider:

```
env.AI_PROVIDER = "openai" | "anthropic" | "local"
env.OPENAI_API_KEY / env.AI_BASE_URL
```

Features: assistant, recommendations, tech support, docs. Rate-limited 30 req/min.

---

## 9. Payments

Abstraction over Paystack, Hubtel, Mobile Money. Tables `payments` + `subscriptions` + `licenses`. Webhook handlers verify signatures before activating entitlements.

---

## 10. Security (see SECURITY.md)

- Parameterized queries, CORS allowlist, rate limiting (100/300/500 per tier), JWT + bcrypt, signed R2 URLs, checksum + code signing for updates, audit logs, WAF via Cloudflare.

---

## 11. Deployment Order (Safe)

1. Create D1 `rx-store-db` + run `backend/schema.sql`
2. Create R2 `rx-store-storage` + create folder prefixes
3. Deploy Worker `rx-store-api` (`backend/wrangler.toml`)
4. Deploy Pages `rx-store-web` (`npm run build` → `wrangler pages deploy`)
5. Configure `VITE_API_URL` in Pages env to Worker URL
6. Desktop/Mobile point to same Worker URL — no changes to existing PharmaGAME/Code Rx deployments

---

## 12. Folder Structure (Repository)

```
Rx-STORE/
├── src/                 # Web frontend
├── backend/
│   ├── wrangler.toml
│   ├── schema.sql
│   └── src/{routes,middleware,services,utils}
├── desktop/tauri/       # Tauri (identifier com.calcitonin.rxstore)
├── mobile/flutter/      # Flutter (rx_store)
├── docs/
│   ├── ARCHITECTURE.md  # this file
│   ├── API.md
│   ├── DATABASE.md
│   ├── DEPLOYMENT.md
│   ├── SECURITY.md
│   └── TESTING.md
└── public/
```
