# RX Store Deployment Guide

The ACTUAL production architecture. This document reflects what really ships —
older revisions described a PostgreSQL/Redis/Tauri stack that has never been
part of this deployment; those instructions are obsolete and were removed.

---

## Architecture (as deployed)

```
┌────────────────────────── Cloudflare ──────────────────────────┐
│                                                                 │
│  Web (Pages)                    API (Worker)                    │
│  https://rx-store-web.pages.dev  https://rx-store-api.calcitoninpay.workers.dev
│  React + Vite SPA + PWA          all /v1 routes, inline dispatch │
│        │                                │                       │
│        └────────── fetch ───────────────┘                       │
│                                         │                       │
│  D1 (SQLite) ── R2 (packages) ── KV (cache + rate limits)       │
│  rx-store-db      rx-store-storage     CACHE                    │
└─────────────────────────────────────────────────────────────────┘
        │                    │                      │
   Electron desktop     Capacitor Android       PWA / iOS
   (Windows .exe,       (rx-store-<v>.apk,      (Add to Home
    Linux .deb/AppImage) rxstore:// deep link)   Screen guidance)
```

| Layer | Technology | Deployment |
| --- | --- | --- |
| Web frontend | React 18 + Vite (SPA + PWA + service worker) | Cloudflare Pages, **Git-connected to `main`** (auto-deploy) |
| API | Cloudflare Worker (`backend/src/index.ts`) | **Git-connected to `main`** (auto-deploy) — or `npx wrangler deploy --config backend/wrangler.toml` |
| Database | D1 (`rx-store-db`, id `dc6f6d5c-9d7e-412f-8e35-b4d2ef7cfeec`) | migrations via `npx wrangler d1 execute rx-store-db --remote --file backend/migrations/NNNN_*.sql` |
| Object storage | R2 (`rx-store-storage`) — app packages, quarantine, attachments | managed by the Worker |
| Cache / rate limits | KV namespace `CACHE` | managed by the Worker |
| Desktop | Electron (`electron/`), built by `release.yml` → GitHub Releases | self-updates via `electron-updater` + `latest.yml` |
| Android | Capacitor (`android/`), release-signed APK via `release.yml` | `rxstore://` deep link + secure credential storage |
| iOS | PWA guidance (no native app — by design) | — |

> **Not part of this deployment:** PostgreSQL, Redis, nginx, Tauri, Flutter.
> `desktop/tauri/` and `mobile/flutter/` are LEGACY trees retained for history;
> they are non-shipping and must not be documented as deployment targets.

---

## Deploying a change

1. Merge to `main` (the session branch flow: `git pull origin arena/<id> && git push origin HEAD:main`).
   - The Worker and Pages both auto-deploy from `main`.
2. Apply any NEW database migrations (check `backend/migrations/` for files
   newer than your last deploy):
   ```bash
   npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/NNNN_name.sql
   ```
   Migration runbook: [`DATABASE.md`](./DATABASE.md).
3. Run the secrets pre-flight: `./scripts/release-preflight.sh`.

## Shipping a production release (desktop + Android)

Production releases are **tag-controlled and atomic**
(`.github/workflows/release.yml`):

```bash
npm version patch          # or minor/major — commits the version bump
git push origin main       # CI validates (ci.yml) — publishes nothing
git tag vX.Y.Z             # MUST equal package.json version
git push origin vX.Y.Z     # release.yml: full pipeline → atomic publish
```

The release pipeline builds every platform, verifies artifacts + signatures +
versions, and only then publishes (draft → published). Android signing secrets
are **mandatory** — without them the build fails closed (a debug-signed
production APK is never built). Windows installers are signed only when a
certificate is configured (`WIN_CSC_LINK_B64`) and are **labelled unsigned
otherwise**. See [`RELEASES.md`](./RELEASES.md).

## Secrets & configuration

All secrets live as Worker secrets (`npx wrangler secret put NAME --config
backend/wrangler.toml`) or GitHub Actions secrets — never in the repository.
The mandatory/optional matrix and the pre-flight check:
[`RELEASE_READINESS.md`](./RELEASE_READINESS.md) + `./scripts/release-preflight.sh`.

| Setting | Where | Mandatory for |
| --- | --- | --- |
| `JWT_SECRET` | Worker secret | authentication (everything) |
| `PAYSTACK_SECRET_KEY` | Worker secret | paid apps / purchases |
| `VIRUSTOTAL_API_KEY` | Worker secret | package malware scanning |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Worker secrets | Google sign-in (optional) |
| `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` | Worker secrets | GitHub sign-in (optional) |
| `RESEND_API_KEY` + `FROM_EMAIL` | Worker secrets | email (password reset, release notices) |
| `AI_*_API_KEY` (one or more) | Worker secrets | AI chat |
| `CORS_ALLOWED_ORIGINS`, `RX_STORE_WEB_URL`, `MALWARE_SCANNER` | `backend/wrangler.toml` `[vars]` | API config |
| `VITE_API_URL` | `.env.production` (committed; public URL) | web/desktop/Android builds |
| `ANDROID_KEYSTORE_*` (4) | GitHub secrets | release APK signing |
| `WIN_CSC_LINK_B64` + `WIN_CSC_KEY_PASSWORD` | GitHub secrets | Windows code signing (optional; label is honest without it) — full guide: [`WINDOWS_SIGNING.md`](./WINDOWS_SIGNING.md) |
| `VITE_API_URL` | GitHub Actions variable | CI/release builds |

## Local development

```bash
npm install
npm run dev            # web (Vite)
npm run dev:desktop    # Electron + Vite
npx wrangler dev --config backend/wrangler.toml   # local Worker + D1
```

The web build **refuses to compile** without a valid HTTPS `VITE_API_URL`
(vite.config.ts guard; escape hatch `VITE_ALLOW_UNCONFIGURED=1` for
intentional offline builds).

## Operational runbooks

* **Launch checklist** (live verifications): [`LAUNCH_CHECKLIST.md`](./LAUNCH_CHECKLIST.md)
* **Backup & recovery** (D1 export, R2 mirror, Time Travel, restore): [`BACKUP_RECOVERY.md`](./BACKUP_RECOVERY.md)
* **Windows code signing** (current state + setup): [`WINDOWS_SIGNING.md`](./WINDOWS_SIGNING.md)

## CI / release workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | push to `main`, PRs | validation only — typecheck, lint, tests, web+Electron builds, SDK external-consumer gate, Android `assembleDebug`. **Publishes nothing.** |
| `release.yml` | `vX.Y.Z` tag push (or manual dispatch) | atomic production release: build all platforms → verify everything → publish once. Fails closed on tag/version mismatch, existing published release, missing Android signing secrets, unsigned-when-required. |
