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

Run in filename order. `0002`–`0007` are idempotent (`IF NOT EXISTS` /
`CREATE TABLE` guards — safe to re-run). **`0008` runs exactly once** (see its
header: a needless re-run preserves rows but resets the compatibility metadata
columns), so back up before applying it.

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

---

## Production migration runbook (required before deploying the Prompt 2–10 worker)

The new backend endpoints (`/devices/*`, `/auth/refresh` sessions, the
architecture-aware package download) require the `0006`–`0008` tables. **Migrate
the database first, then deploy the worker code** — the old worker ignores the
new tables, so there is no downtime window.

Run from the repository root (the account comes from `npx wrangler login`):

```bash
# 0) Confirm you are logged in to the right Cloudflare account
npx wrangler whoami                 # if not logged in: npx wrangler login

# 1) BACK UP the remote database (0008 rebuilds the packages table)
npx wrangler d1 export rx-store-db --remote --output=db-backup.sql

# 2) Check which migrations are already applied (list existing tables)
npx wrangler d1 execute rx-store-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

# 3) Record the current package count — it MUST be identical after 0008
npx wrangler d1 execute rx-store-db --remote \
  --command "SELECT COUNT(*) AS packages_before FROM packages"

# 4) Apply the three new migrations IN ORDER (confirm if wrangler asks)
npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0006_devices_installations.sql
npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0007_auth_sessions.sql
npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0008_packages_architecture.sql

# 5) Verify: count unchanged + new tables exist
npx wrangler d1 execute rx-store-db --remote \
  --command "SELECT COUNT(*) AS packages_after FROM packages"
npx wrangler d1 execute rx-store-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('devices','app_installations','auth_sessions') ORDER BY name"

# 6) Deploy the updated worker (the new endpoints are code, not just tables)
cd backend && npx wrangler deploy && cd ..

# 7) Confirm required secrets are set on the worker
cd backend && npx wrangler secret list     # must include JWT_SECRET
```

Notes:

* If step 2 shows any of `0002`–`0005b`'s tables/columns missing (e.g. the
  native identity columns from `0005`), apply those files the same way first —
  they are all re-run safe.
* **CORS:** after deploying, only the first-party origins
  (`rxstore.com`, `www.rxstore.com`, `api.rxstore.com`, `app://rxstore`,
  Capacitor/localhost shells) are allowed in production. If the web frontend is
  served from anywhere else (e.g. a `*.pages.dev` host), add its exact origin to
  `CORS_ALLOWED_ORIGINS` in `backend/wrangler.toml` before deploying.
* **No user data migration:** existing password hashes still verify (legacy
  hashes upgrade on next login); do not rotate `JWT_SECRET` unless you want to
  force everyone to sign in again.

### Older deployments (DB created before this repo's migrations)

Symptom: `0008` fails with `no such column: deleted_at` AND the database contains
tables that are not in `backend/schema.sql` (e.g. `ad_stats`, `licenses`,
`upload_jobs`). Such a database predates migrations `0002`–`0005` entirely.

1. Dump the real DDL of the three tables the new worker depends on and compare
   against `backend/schema.sql`:
   ```bash
   npx wrangler d1 execute rx-store-db --remote --command "SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('packages','releases','applications')"
   ```
2. `applications` needs the `0004` + `0005` columns (the admin app editor writes
   all of them). Add each **one command at a time** — a `duplicate column name`
   error is harmless and means it already exists (do NOT use `--file` here: file
   execution is transactional, so one duplicate would roll back the rest):
   ```bash
   npx wrangler d1 execute rx-store-db --remote --command "ALTER TABLE applications ADD COLUMN features TEXT DEFAULT '[]'"
   npx wrangler d1 execute rx-store-db --remote --command "ALTER TABLE applications ADD COLUMN release_notes TEXT DEFAULT '[]'"
   npx wrangler d1 execute rx-store-db --remote --command "ALTER TABLE applications ADD COLUMN deleted_at TEXT"
   npx wrangler d1 execute rx-store-db --remote --command "ALTER TABLE applications ADD COLUMN android_package_id TEXT"
   npx wrangler d1 execute rx-store-db --remote --command "ALTER TABLE applications ADD COLUMN windows_uninstall_key TEXT"
   npx wrangler d1 execute rx-store-db --remote --command "ALTER TABLE applications ADD COLUMN windows_executable TEXT"
   npx wrangler d1 execute rx-store-db --remote --command "ALTER TABLE applications ADD COLUMN linux_package_name TEXT"
   npx wrangler d1 execute rx-store-db --remote --command "ALTER TABLE applications ADD COLUMN linux_executable TEXT"
   ```
3. `releases` needs (per `backend/schema.sql`): `channel`, `release_type`,
   `minimum_supported_version`, `published_at`, `updated_at`, `deleted_at`,
   `release_notes`. Check the step-1 dump and add any missing ones the same
   one-command-per-ALTER way, e.g.
   `ALTER TABLE releases ADD COLUMN channel TEXT DEFAULT 'stable'`.
   Also check the `status` CHECK in the dump includes `rolled_back` and
   `disabled` — if not, the rollback feature needs a table rebuild (ask before
   attempting one).
4. Then continue with the `0008` repair steps above.



**`0008` fails with `no such column: deleted_at` (or `created_at`)**

Your production `packages` table is older than this repo's schema baseline and
is missing a column the migration copies. The failed run **rolled back** —
wrangler executes the file as one transaction, so `packages` is untouched.

1. Confirm the rollback left no half-built table behind:
   ```bash
   npx wrangler d1 execute rx-store-db --remote --command "SELECT name FROM sqlite_master WHERE name LIKE 'packages%' ORDER BY name"
   ```
   Only `packages` should be listed. If a leftover `packages_new` exists
   (should not happen), drop it: `DROP TABLE packages_new;`
2. Inspect the real table definition:
   ```bash
   npx wrangler d1 execute rx-store-db --remote --command "SELECT sql FROM sqlite_master WHERE name='packages'"
   ```
3. Add each missing column **one command at a time** (a `duplicate column
   name` error just means it already exists — skip past it):
   ```bash
   npx wrangler d1 execute rx-store-db --remote --command "ALTER TABLE packages ADD COLUMN deleted_at TEXT"
   npx wrangler d1 execute rx-store-db --remote --command "ALTER TABLE packages ADD COLUMN created_at TEXT"
   ```
4. Optional data-quality check — rows with empty required fields would be
   silently skipped by the copy, so this must return `0`:
   ```bash
   npx wrangler d1 execute rx-store-db --remote --command "SELECT COUNT(*) AS bad_rows FROM packages WHERE filename IS NULL OR filename='' OR storage_key IS NULL OR storage_key='' OR sha256 IS NULL OR sha256='' OR file_size IS NULL OR version IS NULL OR version=''"
   ```
5. Re-run `0008`, then verify the row count matches step 1's pre-migration
   count. If the count dropped, stop and investigate — do not re-run.

For one-off ad-hoc SQL, the same command shape applies:

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
