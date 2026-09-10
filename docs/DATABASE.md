# RX Store — Database

The database is **Cloudflare D1 (SQLite)**, not PostgreSQL. An earlier version of
this document described PostgreSQL 15 with `UUID`, `JSONB` and `TIMESTAMPTZ`
columns; none of that exists in this project. This file now reflects the real
schema.

* **Engine:** Cloudflare D1 (SQLite semantics)
* **Canonical schema:** `backend/schema.sql` (fresh installs)
* **Incremental changes:** `backend/migrations/*.sql`
* **Cache / rate limiting:** Cloudflare KV (`CACHE` binding)
* **Object storage:** Cloudflare R2 (`STORAGE` binding)

## SQLite/D1 conventions used

| Concern | Convention |
| --- | --- |
| Primary keys | `TEXT` (application-generated ids, e.g. `crypto.randomUUID()`, `pkg_…`, `sess_…`) — **not** `UUID`/auto-increment |
| JSON columns | `TEXT` holding a JSON string (`'[]'`, `'{}'`), parsed in code |
| Booleans | `INTEGER` 0/1 (coerced to booleans at the API boundary) |
| Timestamps | `TEXT` via `datetime('now')` (UTC, `YYYY-MM-DD HH:MM:SS`), **not** `TIMESTAMPTZ` |
| Enumerations | `TEXT` + `CHECK (col IN (...))` |
| Cascades | `REFERENCES … ON DELETE CASCADE` |

---

## Tables

### Core

* **`users`** — `id TEXT PK`, unique `email`/`username`/`phone`, `password_hash`,
  `role CHECK (user|developer|admin)`, `preferences TEXT` (JSON), `advertiser INTEGER`,
  `reset_token` / `reset_token_expiry`, timestamps.
* **`applications`** — `id TEXT PK`, unique `slug`, `name`, `description`,
  `long_description`, `category CHECK`, `status CHECK`, `current_version`,
  `size_mb`, `platforms TEXT` (JSON), plus the **native identity fields**:
  `android_package_id`, `windows_uninstall_key`, `windows_executable`,
  `linux_package_name`, `linux_executable` (migration `0005_native_app_identity`).
  A view `apps` aliases this table for older code.
* **`downloads`** — a **log**, not installation state: `user_id`, `app_id`,
  `platform`, `version`, `created_at`. `user_id` is derived from the access token.

### Release system (canonical)

* **`releases`** — `UNIQUE(application_id, version)`, `channel CHECK (stable|beta|alpha)`,
  `status CHECK (draft|processing|ready_for_review|published|disabled|rolled_back|archived)`,
  `published_at`.
* **`packages`** — one artifact per **(release, platform, architecture)**:
  `UNIQUE(release_id, platform, architecture)` (migration `0008`),
  `platform CHECK`, `architecture NOT NULL DEFAULT 'x64'`, `filename`,
  `storage_key`, `file_size`, `sha256`, `version`, optional compatibility
  metadata `min_os_version TEXT` / `min_android_sdk INTEGER`, `package_type CHECK`,
  `status CHECK`.

### Account / device / installation (Prompt 1–2)

* **`devices`** — `id TEXT PK` (internal), `device_id TEXT` (stable client id),
  **`UNIQUE(user_id, device_id)`** so the same physical install under two accounts
  gets its own row and never duplicates on restart. Includes `platform`,
  `device_type`, `os_version`, `rx_store_version`, `last_seen_at`, `status CHECK`,
  `revoked_at`.
* **`app_installations`** — **`UNIQUE(device_id, application_id)`** (idempotent
  upsert). `device_id` references `devices.id` (the internal row). Carries
  `installed_version`, `status`, `detection_source`, `last_detected_at`,
  `installed_at`.
* **`auth_sessions`** — refresh-token rotation. Stores only the **SHA-256 hash**
  of a refresh token (`token_hash`, unique index), never the raw token. Carries
  `device_id`, `user_agent`, `expires_at`, `revoked_at`.

### Supporting

`reviews` (`UNIQUE(app_id, user_id)`), `payments`, `subscriptions`,
`notifications`, `audit_logs`, `licenses`, `download_statistics`, `upload_jobs`,
`ai_settings`, `site_settings` (`key TEXT PK`, created lazily).

### Legacy (compatibility only)

`versions` and `app_versions` remain for older clients. They are **mirrored on
publish** (`syncLegacyAppVersion`) and are never read first — see
`docs/RELEASES.md`.

---

## Indexes

Every foreign-key column used for lookup is indexed, plus:

| Index | Purpose |
| --- | --- |
| `idx_users_email`, `idx_users_phone`, `idx_users_role` | auth lookups |
| `idx_applications_slug`, `idx_applications_category`, `idx_applications_status` | catalog |
| `idx_releases_app`, `idx_releases_status`, `idx_releases_version` | release lookup |
| `idx_packages_release`, `idx_packages_platform`, `idx_packages_arch` | package selection |
| `idx_devices_user`, `idx_devices_status`, `idx_devices_device_id` | device sync |
| `idx_app_installations_user`, `idx_app_installations_device`, `idx_app_installations_app` | installation sync |
| `idx_auth_sessions_user`, `idx_auth_sessions_hash` (unique) | session lookup/rotation |

---

## Migrations

Run in filename order. All are idempotent or safely re-runnable (see each file's
header).

```
0002_packages_platforms.sql          allow all upload platforms
0003_fast_ai_model.sql               default AI model -> 8B
0004_applications_columns.sql        features / release_notes / deleted_at
0005_native_app_identity.sql         the five native identity columns
0005b_site_settings.sql              site_settings table
0006_devices_installations.sql       devices + app_installations
0007_auth_sessions.sql               refresh-token sessions
0008_packages_architecture.sql       UNIQUE(release, platform, architecture) + compat metadata
```

### Migration numbering

There **was** a duplicate `0005` (`0005_native_app_identity.sql` and
`0005_site_settings.sql`). It has been resolved by renaming the latter to
**`0005b_site_settings.sql`**, which removes the collision while preserving
execution order. The rename is safe: the file is `CREATE TABLE IF NOT EXISTS`,
and renaming does not re-run anything for deployments that already applied the
old filename.

Apply against production D1:

```bash
npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/<file>.sql
```

---

## Integrity notes

* **Uniqueness guarantees idempotency** at the database level:
  `UNIQUE(user_id, device_id)` (no duplicate devices),
  `UNIQUE(device_id, application_id)` (no duplicate installations),
  `UNIQUE(release_id, platform, architecture)` (one artifact per target),
  `UNIQUE(application_id, version)` (no duplicate releases),
  `UNIQUE(app_id, user_id)` (one review per user per app).
* **Idempotent upserts** are used for device registration, installation
  reporting and package writes (`INSERT … ON CONFLICT DO UPDATE`).
* **Nothing destructive.** Migration `0008` copies every existing row forward
  (normalizing a missing architecture to `x64`) before dropping the old table, so
  no package data is lost.
* **Nullable by design:** compatibility metadata (`min_os_version`,
  `min_android_sdk`) and the native identity fields are optional; the code treats
  their absence as "not configured" rather than failing.
* **D1 caveat:** dropping a table drops its indexes — migrations recreate them
  after the rename.
