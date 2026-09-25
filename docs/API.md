# RX Store API Documentation

## Base URL
```
Production: https://rx-store-api.calcitoninpay.workers.dev/v1
Local dev:  http://localhost:8787/v1
```

The `/v1` prefix is optional (the Worker strips it). This is the ONLY real
deployment; references to `api.rxstore.com` in older documents are obsolete.
Configure one canonical base per client (web: `VITE_API_URL`; SDK: `apiUrl`,
defaulting to the production URL above).

## Authentication
All authenticated endpoints require a Bearer token in the Authorization header:
```
Authorization: Bearer <token>
```

---

## Endpoints

### Authentication

#### POST /auth/register
Register a new user account.

**Request:**
```json
{
  "name": "Dr. John Smith",
  "email": "john@hospital.org",
  "password": "secure_password_123",
  "role": "user"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr_abc123",
      "name": "Dr. John Smith",
      "email": "john@hospital.org",
      "role": "user",
      "avatar": null,
      "joinDate": "2024-12-20T10:00:00Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
  }
}
```

#### POST /auth/login
```json
{
  "email": "john@hospital.org",
  "password": "secure_password_123"
}
```

#### POST /auth/refresh
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

#### POST /auth/logout
Requires authentication. Invalidates the current token.

---

### Applications

#### GET /apps
List all applications with optional filters.

**Query Parameters:**
- `category` (string) - Filter by category
- `platform` (string) - Filter by platform (web, windows, linux, android, ios)
- `search` (string) - Search by name, description, or tags
- `sort` (string) - Sort by: popular, rating, newest, name
- `page` (number) - Page number (default: 1)
- `limit` (number) - Items per page (default: 20, max: 100)

**Response:**
```json
{
  "success": true,
  "data": {
    "apps": [...],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 8,
      "pages": 1
    }
  }
}
```

#### GET /apps/:slug
Get application details by slug.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "clinical-rx",
    "name": "Clinical Rx",
    "slug": "clinical-rx",
    "description": "...",
    "longDescription": "...",
    "category": "healthcare",
    "tags": ["clinical", "prescribing"],
    "icon": "🏥",
    "version": "3.2.1",
    "size": "148 MB",
    "developer": "Calcitonin Technologies",
    "rating": 4.8,
    "reviewCount": 2847,
    "downloadCount": 156000,
    "price": "subscription",
    "priceAmount": 29.99,
    "platforms": ["web", "windows", "linux", "android", "ios"],
    "releaseDate": "2023-01-15",
    "lastUpdated": "2024-12-20",
    "releaseNotes": ["...", "..."],
    "features": ["...", "..."],
    "status": "active"
  }
}
```

#### GET /apps/:slug/reviews
Get reviews for an application.

**Query Parameters:**
- `sort` (string) - recent, helpful, rating
- `page` (number)
- `limit` (number)

#### GET /apps/:slug/releases
Get version history for an application.

---

### Categories

#### GET /categories
List all categories with app counts.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "healthcare",
      "name": "Healthcare",
      "icon": "Heart",
      "description": "...",
      "count": 3,
      "color": "#FF6B6B"
    }
  ]
}
```

---

### Downloads

#### POST /downloads
Record a download event (requires authentication).

**Request:**
```json
{
  "appId": "clinical-rx",
  "platform": "windows",
  "version": "3.2.1"
}
```

#### GET /downloads/:appId/:platform
Get download URL for a specific platform.

**Response:**
```json
{
  "success": true,
  "data": {
    "url": "https://rx-store-api.calcitoninpay.workers.dev/downloads/<short-lived-grant-token>",
    "expiresAt": "2024-12-20T11:00:00Z",
    "checksum": "sha256:abc123..."
  }
}
```

---

### Updates

#### GET /updates/check
Check whether a newer RX Store release exists. This is the ONE canonical
update endpoint, consumed by the RX Store Developer SDK (`sdk/`) and any host
application. Aliases (all identical): `/update/check`, `/api/updates/check`,
`/api/update/check`.

Unauthenticated + public — no secrets belong in shipped applications. Paid
applications NEVER expose a binary download URL here; the SDK only needs the
store/deep-link destination, and entitlement + short-lived download grants
stay inside RX Store.

**Query Parameters:**
- `app` (string, required) - Application slug (e.g. `pharmatrack`)
- `currentVersion` (string, required) - SemVer of the installed build (`1.0.0-beta.1` ok)
- `platform` (string, required) - `android` | `windows` | `linux` | `web` | `pwa` (aliases: `deb` → `linux_deb`, `appimage` → `linux_appimage`)
- `arch` (string, optional) - `x64` | `arm64` | `x86` | `arm` | `universal`
- `channel` (string, optional) - `stable` (default) | `beta` | `alpha`

**Response:**
```json
{
  "success": true,
  "data": {
    "appId": "app_xxx",
    "app": "PharmaTRACK",
    "slug": "pharmatrack",
    "currentVersion": "1.1.4",
    "latestVersion": "1.1.5",
    "platform": "android",
    "architecture": "arm64",
    "channel": "stable",
    "updateAvailable": true,
    "mandatory": false,
    "minimumSupportedVersion": "1.1.0",
    "updateRequired": false,
    "releaseNotes": ["Bug fixes", "Performance improvements"],
    "fileSize": 12345678,
    "checksum": "sha256:…64 hex…",
    "storeUrl": "https://rx-store-web.pages.dev/app/pharmatrack",
    "deepLink": "rxstore://app/pharmatrack",
    "checkedAt": "2026-09-24T12:00:00.000Z",
    "downloadURL": "https://…/package.ext"
  }
}
```

Field notes:
- `mandatory` — the release was flagged mandatory, OR the caller's
  `currentVersion` is below the release's `minimumSupportedVersion`.
- `updateRequired` — true only for the below-minimum case.
- `downloadURL` — present for FREE apps (public package), always `null` for
  paid apps. The SDK ignores this field entirely; RX Store performs the
  authorized download.
- `storeUrl` / `deepLink` — the destinations the SDK opens
  (`RX_STORE_WEB_URL` var, default `https://rx-store-web.pages.dev`).
- All values are SERVER-AUTHORITATIVE; clients must not trust locally
  supplied versions/flags.

**Errors:** `400` `VALIDATION_ERROR` missing/invalid parameters · `404`
`NOT_FOUND` unknown application · `429` `RATE_LIMITED` (sliding window over
KV) · `5xx` server failure. Rate limiting is applied inline to every request
(300/min general bucket; see `backend/src/middleware/rateLimiter.ts`).

**Rate limit:** 300 requests/minute/IP (the general API bucket).

### Deep links (SDK destinations)

| Format | Opens |
|---|---|
| `rxstore://app/{slug}` | RX Store (Android app / Windows / Linux desktop) directly on `/app/{slug}` |
| `https://rx-store-web.pages.dev/app/{slug}` | The web RX Store app page — always works, offers "Get RX Store" when the native app is missing |

Slugs are strict kebab-case (`^[a-z0-9][a-z0-9-]{0,63}$`); RX Store validates
every incoming link against this allowlist and never executes URL content.
When RX Store is not installed, the HTTPS page can carry
`?pending=/app/{slug}` (same allowlist, 15-minute sessionStorage TTL) to
continue to the application after install — no credentials ever travel in links.

### Developer SDK

The SDK (`sdk/`, package `@rx-store/sdk`) consumes this API:

```ts
import { createRxStoreSDK } from '@rx-store/sdk';

const rxStore = createRxStoreSDK({
  appId: 'pharmatrack',       // your RX Store slug
  currentVersion: '1.1.4',    // your app's SemVer
  platform: 'android',        // explicit override on native hosts
});

const result = await rxStore.checkForUpdate();  // never throws
if (result.status === 'UPDATE_AVAILABLE' || result.status === 'MANDATORY_UPDATE') {
  rxStore.openUpdateInRxStore();  // deep link + HTTPS fallback; never installs
}
```

Full integration guide (banner, platforms, mandatory updates, security):
[`sdk/README.md`](../sdk/README.md) and `/developers/sdk` in the app.

---

### OAuth (secondary sign-in: Google / GitHub)

Optional secondary authentication on top of email/password. Enabled per
provider by setting `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` or
`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` Worker secrets.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /auth/oauth/providers` | none | Which providers are configured: `{ google: bool, github: bool }` |
| `GET /auth/oauth/{google\|github}/start?redirect=/path` | none | Begin the flow → 302 to the provider (state is server-generated, single-use, 10 min) |
| `GET /auth/oauth/{google\|github}/callback` | none | Provider callback → 302 to the web app's `/oauth/callback` with a one-time completion code |
| `POST /auth/oauth/complete` `{code}` | none | Exchange the completion code (or a sign-in code) for a **normal** login response (`user`, `token`, `refreshToken`, `status`, `redirect`) |
| `POST /auth/oauth/link-start` `{provider}` | Bearer | (Signed-in) start CONNECTING a provider → `{url}` |
| `POST /auth/oauth/link/confirm` `{token, password}` | none | Attach a provider identity to an existing account after proving its password → normal session |
| `POST /auth/oauth/pairing-code` | Bearer | Issue a one-time sign-in code for another device (10 min, single use) |
| `GET /auth/methods` | Bearer | Connected methods: password + google + github (connected/linkedAt/lastUsedAt/canDisconnect) |
| `POST /auth/oauth/{provider}/disconnect` | Bearer | Disconnect a linked provider (fails 403 when it is the last usable method) |
| `POST /auth/set-password` `{password}` | Bearer | Set a password for a social-only account (409 when one exists) |

Identity rules: the provider SUBJECT is the permanent key; a verified-email
match with an existing account NEVER auto-merges (password-confirmed linking
only); fresh users are created without a password. OAuth client secrets are
backend-only and never appear in any response. Errors: `501 NOT_IMPLEMENTED`
provider not configured · `400 VALIDATION_ERROR` · `401 INVALID_TOKEN`
expired/invalid state or code · `409 CONFLICT` already connected ·
`403 FORBIDDEN` last-method protection.

**Callback URLs to register:**
`https://rx-store-api.calcitoninpay.workers.dev/auth/oauth/google/callback` ·
`…/auth/oauth/github/callback` (local dev: `http://localhost:8787/…`).

---

### Users (Authenticated)

#### GET /users/me
Get current user profile.

#### PATCH /users/me
Update user profile.

**Request:**
```json
{
  "name": "Dr. Jane Smith",
  "avatar": "👩‍⚕️",
  "preferences": {
    "emailNotifications": true,
    "autoUpdate": true
  }
}
```

#### GET /users/me/apps
Get user's installed applications.

#### GET /users/me/subscriptions
Get user's active subscriptions.

#### GET /users/me/notifications
Get user's notifications.

#### PATCH /users/me/notifications/:id/read
Mark a notification as read.

---

### Admin Endpoints

#### GET /admin/dashboard
Get admin dashboard statistics.

**Response:**
```json
{
  "success": true,
  "data": {
    "totalDownloads": 734000,
    "activeUsers": 28400,
    "monthlyRevenue": 47832,
    "averageRating": 4.7,
    "newUsersToday": 156,
    "downloadTrend": [12.5, 8.2, ...],
    "topApps": [...]
  }
}
```

#### POST /admin/apps
Create a new application listing.

#### PATCH /admin/apps/:id
Update application details.

#### DELETE /admin/apps/:id
Remove an application.

#### POST /admin/apps/:id/releases
Create a new release for an application.

**Request:**
```json
{
  "version": "3.3.0",
  "releaseNotes": ["New features", "Bug fixes"],
  "platforms": {
    "windows": { "fileUrl": "...", "checksum": "..." },
    "android": { "fileUrl": "...", "checksum": "..." }
  },
  "mandatory": false
}
```

#### GET /admin/users
List all users with filters.

#### PATCH /admin/users/:id/role
Update user role.

#### GET /admin/analytics
Get detailed analytics.

**Query Parameters:**
- `period` (string) - 7d, 30d, 90d, 1y
- `metric` (string) - downloads, users, revenue, ratings

#### GET /admin/revenue
Get revenue data.

---

### Payments

#### POST /payments/subscribe
Create a subscription.

**Request:**
```json
{
  "appId": "clinical-rx",
  "plan": "professional",
  "paymentMethod": "paystack",
  "paymentDetails": { ... }
}
```

#### GET /payments/history
Get payment history.

#### POST /payments/verify/:transactionId
Verify a payment transaction.

---

### AI Assistant

#### POST /ai/chat
Send a message to the AI assistant.

**Request:**
```json
{
  "message": "Which app is best for drug interaction checking?",
  "context": {
    "currentApp": null,
    "userRole": "pharmacist"
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "response": "Based on your needs, I recommend Clinical Rx...",
    "suggestions": [
      "Compare Clinical Rx vs CureLink",
      "Show me drug interaction features"
    ]
  }
}
```

#### POST /ai/recommend
Get AI-powered app recommendations.

---

## Error Responses

All errors follow this format:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid email format",
    "details": [
      {
        "field": "email",
        "message": "Must be a valid email address"
      }
    ]
  }
}
```

### Error Codes
| Code | HTTP Status | Description |
|------|-------------|-------------|
| VALIDATION_ERROR | 400 | Request validation failed |
| UNAUTHORIZED | 401 | Authentication required |
| FORBIDDEN | 403 | Insufficient permissions |
| NOT_FOUND | 404 | Resource not found |
| RATE_LIMITED | 429 | Too many requests |
| INTERNAL_ERROR | 500 | Server error |

---

## Rate Limits
Actual configured buckets (sliding window, per user id or IP — `backend/src/middleware/rateLimiter.ts`):
- `/auth/*`: 20/min · `/payments/*`: 20/min · `/reviews/*`: 20/min
- `/apps/*` and general traffic (incl. `GET /updates/check`): 300/min
- `/developers/*`: 120/min (submits 10/5min, payouts 10/5min)
- `/admin/*`: 500/min · `/ai/*`: 30/min · `/community` discussions 20/min
