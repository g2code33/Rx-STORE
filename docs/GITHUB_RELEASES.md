# GitHub Releases Integration — Setup & Operations

Free apps can connect a **public GitHub repository**. Every GitHub Release on
that repository is **detected automatically**, **verified** (real bytes:
size + SHA-256 + malware scan) and queued in **Admin → GitHub Releases &
Approvals**. Nothing reaches users until an admin explicitly **approves &
publishes** it. RX Store never copies the binaries into its own storage —
users download straight from the verified public GitHub asset URLs.

**Channel policy (server-enforced):** GitHub distribution is **free apps
only**. Paid apps keep the manual admin upload + entitlement-protected
download flow, unchanged. Developers cannot connect, publish or serve a paid
app through GitHub.

---

## 1. Create the GitHub App (one-time, ~5 minutes)

1. On GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App**
   (or org-level: *Organization Settings → Developer settings → GitHub Apps*).
2. Fill in:
   * **GitHub App name**: `RX Store Releases (production)`
   * **Homepage URL**: `https://rx-store-web.pages.dev`
   * **Callback URL**: `https://rx-store-api.calcitoninpay.workers.dev/v1/developers/github/callback`
     *(only used if you later add user-to-server tokens; harmless to set now)*
   * **Setup URL**: `https://rx-store-api.calcitoninpay.workers.dev/v1/developers/github/callback`
     ✅ check **Redirect on update** — this is the post-install redirect the
     connect flow relies on.
   * **Webhook URL**: `https://rx-store-api.calcitoninpay.workers.dev/v1/webhooks/github`
   * **Webhook secret**: a long random string (generate one, e.g.
     `openssl rand -hex 32`) — this becomes the `GITHUB_WEBHOOK_SECRET` secret.
3. **Permissions → Repository permissions** (read-only, the minimum):
   * **Contents: Read-only** (releases + release assets)
   * **Metadata: Read-only** (mandatory, auto-selected)
   * Nothing else. **No write access is requested.**
4. **Subscribe to events**: check **Release**. Nothing else.
5. Where can this app be installed: **Any account** (developers install it on
   their own repositories).
6. Create the App, then on its page:
   * Note the **App ID** (numeric) → `GITHUB_APP_ID`
   * Note the **slug** in the URL (`https://github.com/apps/<slug>`) → `GITHUB_APP_SLUG`
   * **Generate a private key** (Credentials → Key pairs → New key) → download the `.pem`
     → `GITHUB_APP_PRIVATE_KEY` (the full PEM including the BEGIN/END lines)
   * Under **Identifying and authorizing users** copy the **Client ID** and
     generate a **Client secret**, and set **Callback URL** to
     `https://rx-store-api.calcitoninpay.workers.dev/v1/developers/github/callback`
     (this enables the reliable user-authorization connect flow).

> The domains above are the current production deployment. If you change the
> Worker or Pages domains, update the App's URLs accordingly — they are
> placeholders for whatever the deployed configuration is.

## 2. Worker secrets (do NOT commit these)

```bash
cd ~/Documents/Rx-STORE
wrangler secret put GITHUB_APP_ID           --name rx-store-api
wrangler secret put GITHUB_APP_SLUG         --name rx-store-api
wrangler secret put GITHUB_APP_PRIVATE_KEY  --name rx-store-api   # paste the whole PEM
wrangler secret put GITHUB_WEBHOOK_SECRET   --name rx-store-api   # the webhook secret from step 1.2

# RECOMMENDED — the App's OWN OAuth client (Identifying and authorizing users).
# Enables the reliable connect flow: it lists only the installations and
# repositories the signed-in GitHub user can access, survives the
# "already installed" case, and completes on a self-contained page.
wrangler secret put GITHUB_APP_CLIENT_ID     --name rx-store-api
wrangler secret put GITHUB_APP_CLIENT_SECRET --name rx-store-api
```

Without the two OAuth secrets, connecting falls back to the install redirect
(GitHub → Setup URL). That fallback requires a fresh install and can lose the
state when the App is already installed on the account.

Optional tunables (plain `[vars]` in `backend/wrangler.toml`, defaults shown):

| Var | Default | Meaning |
| --- | --- | --- |
| `GITHUB_ASSET_MAX_BYTES` | `524288000` (500MB) | Hard cap for a verified external asset |
| `GITHUB_VT_MAX_BYTES` | `33554432` (32MB) | VirusTotal upload ceiling for external assets (raise on VT premium) |

Until the four secrets exist, the Developer Center panel and the admin center
report **"integration not configured"** — nothing is faked.

## 3. Database migration

```bash
wrangler d1 migrations apply rx-store-db --remote
```

Migration `0023_github_releases.sql` adds the `packages.provider /
external_url / github_asset_id` columns and the `github_repo_connections`,
`github_release_events`, `github_releases`, `github_release_assets`,
`github_audit_log` tables. (Re-running reports `duplicate column name` for the
ALTERs — that is the harmless already-applied signal.)

## 4. Rollout / use

1. **Developer**: Developer Center → their free app → *GitHub Releases* →
   **Connect GitHub repository** → install the App on the repository → pick
   the repository.
2. **Detection**: publish a GitHub Release (tag like `v1.2.3`, non-draft,
   non-prerelease, with installer assets). The webhook records it; verification
   runs in the background (or via the admin **Retry verification** button /
   **Sync repositories now** for reconciliation when webhooks can't reach the
   Worker).
3. **Admin**: Admin → **GitHub Releases** → review the pending release →
   **Approve & Publish** (explicit confirmation; a security override with an
   audited reason exists ONLY for UNAVAILABLE scanner results, never for
   DETECTED) or **Reject** (reason required, audited).

### Asset → platform mapping (deterministic, documented)

| Extension | Platform | Architecture |
| --- | --- | --- |
| `.apk` | android | universal |
| `.exe` / `.msi` | windows | x64 (arm64 if the filename says arm64/aarch64) |
| `.deb` | linux_deb | **required in filename**: amd64/x64, arm64/aarch64, or armhf/arm |
| `.AppImage` | linux_appimage | **required in filename**: x86_64/x64 or aarch64/arm64 |
| `.dmg` / `.pkg` | macos | universal (arm64 if the filename says so) |

Anything else (source zips, checksums…) is not mapped. For unambiguous
control, include an explicit manifest in the release body — a fenced json
block; filenames may only disambiguate platform/architecture, never URLs:

    ```json
    { "rx-store": { "assets": [ { "file": " MyApp-1.2.3.apk", "platform": "android", "architecture": "universal" } ] } }
    ```

## 5. What the gates guarantee (all backend-enforced)

* GitHub detection **never** writes `current_version`, `app_versions`,
  notifications or canonical release rows. Only the admin **publish** action
  does — after re-verifying asset identity AND re-hashing the actual bytes.
* Prereleases are quarantined (`blocked`); drafts/deleted releases are ignored.
* Any asset change after review (rename/resize/hash change) re-blocks the
  release and requires fresh approval.
* Duplicate webhook deliveries are idempotent (delivery-id unique index);
  concurrent publish attempts cannot double-publish (unique constraints).
* Verification failures roll back cleanly — a half-published state cannot
  survive.
* Scanner results are honest: UNAVAILABLE blocks publication unless an
  explicit, audited override is chosen; DETECTED can never be overridden.
* Paid apps can never connect, publish, or serve a GitHub-hosted package
  (checked at connect, at publish, and again at download time).
