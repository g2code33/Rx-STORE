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
   * Under **Identifying and authorizing users**:
     - **Callback URL** (required — GitHub refuses to save the app with
       "This GitHub App must be configured with a callback URL" when
       "Request user authorization (OAuth) during installation" is ticked and
       this is empty):
       `https://rx-store-api.calcitoninpay.workers.dev/v1/developers/github/callback`
       The `/v1` prefix is part of the public API base — the Worker builds the
       same value, so both must match exactly.
     - Copy the **Client ID** and click **Generate a new client secret**
       (this enables the reliable user-authorization connect flow).
     - "Request user authorization (OAuth) during installation" may stay
       un-ticked (the connect button performs its own authorization), but if
       you tick it the Callback URL above is mandatory.
     - Override the callback with the `GITHUB_APP_CALLBACK_URL` variable if
       the deployment lives on another domain.

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

## 6. Verification budget (why it is incremental, and how assets are hashed)

A GitHub asset is never copied into RX Store storage: it lives on GitHub and is
streamed on demand, so **every verification pass pays for the download** and for
hashing it inside the Worker.

* **One asset per request.** `POST /v1/admin/github/releases/:id/retry` verifies
  a single asset (`maxAssets: 1`) and returns `{ remaining, verifiedAssets,
  totalAssets }`; the admin panel loops until nothing is left. Asking for a whole
  release in one request used to exceed the Worker's CPU budget, the runtime
  killed the request, the edge answered with an error page **without CORS
  headers**, and the browser only showed `Failed to fetch`.
* **Streaming is linear and bounded.** `loadExternalPackageBytes()` hashes the
  stream with `crypto.DigestStream`, keeps the first and last 2 MB for the
  structure/signature checks, and buffers the whole file in memory only up to
  32 MB. (It previously walked every byte in JavaScript and shifted a 2 MB ring
  per byte — a 100 MB installer could never finish.)
* **Manual approval prefers GitHub's own digest.** GitHub returns
  `digest: "sha256:…"` on release-asset metadata; a manual approval binds to that
  hash without re-downloading the file. When no digest exists (older assets) the
  real bytes are streamed and hashed. The audit entry records which path was
  used (`hashSource`: `recorded` / `github_digest` / `streamed`).
* **Confirm the deployed pipeline.** `GET /v1/health` returns
  `securityPipelineVersion`; it changes whenever the verification code changes,
  so a stale Worker is visible immediately after a deploy.

### When the scanner says SCANNING / UNAVAILABLE

`SCANNING` means the VirusTotal analysis was still running when the polling
budget ran out; `UNAVAILABLE` means the scanner was rate limited or unreachable.
Neither is a pass, so publication stays blocked. The scanner cache is keyed by
the package SHA-256 and stores the analysis id, so **Re-check security**
(`POST /v1/admin/github/releases/:id/recheck`) polls the SAME analysis instead of
uploading the file again, then re-evaluates the release. Retry verification
cannot do this on its own — it only works through assets that still lack
verified bytes.

A `FAILED` check (for example `native_identity: package identity mismatch`) is a
real finding and is shown with its reason under the badge. Fix the app record
(Admin → Applications → `linux_package_name` / `android_package_id`) or take an
explicit, audited **Manual approve** on that asset. A `DETECTED` malware verdict
can never be approved.

## 7. Desktop shell: why reasons are captured in-app

`window.prompt()` is **not implemented by Electron** — calling it throws
`Error: prompt() is and will not be supported.` Every admin action that asked
for a reason through it (Manual approve, Reject, Withdraw, Delete, Suspend /
Disconnect a repository, reset a user's login) therefore did *nothing* in the
desktop app: no dialog, no request, no audit entry.

All of those now use `src/components/common/PromptDialog.tsx`: a real modal with
inline validation (10+ characters), Escape to close and a visible character
count. `src/components/common/desktopShell.test.ts` fails the build if
`window.prompt` returns to any source file. `window.confirm` **is** supported by
Electron, so confirmations may keep using it.

## 8. Request budget (why the approval queue batches its queries)

The queue used to enrich each release with 4+ D1 queries, plus one
security-results query **per package**. With ~40 queued releases that was 150+
subrequests in a single request; the Worker exceeded its budget, the isolate was
killed, and the edge error page (which has no CORS headers) surfaced in the
browser as a bare network error — the queue could not be loaded at all.

Now: `ensureGithubTables()` runs once per isolate, `latestChecksForPackages()`
is one batched query, and `adminQueue()` uses a fixed handful of queries
(assets, canonicals, packages, checks, manual reviews) regardless of how many
releases it returns. Long release notes are trimmed to 4 KB.

Verification follows the same rule: **one download per asset**. GitHub's own
`digest: sha256:…` is used as the authoritative hash (and checked against the
streamed bytes when both exist — a disagreement is a `mismatch`), and the bytes
streamed for hashing are passed into the security pipeline instead of being
downloaded a second time.

## 9. Manual approval on the website (and why digests matter)

The panel's Manual approve button posts to
`/v1/admin/github/releases/:id/assets/:assetId/manual-verify`; the Worker strips
`/v1` and reads the ids from positions 4 and 6 of the remaining path. A
route-level test exercises that exact URL so the two can never drift.

To bind an approval to real bytes it needs a SHA-256, and it gets one in this
order — the cheapest correct source first:

1. the hash already recorded on the asset row (a previous verification),
2. **GitHub's own `digest: "sha256:…"`** from the release-asset API — this is
   what makes a 160 MB AppImage approvable in milliseconds, with zero download
   (`ghApi` pins `X-GitHub-Api-Version: 2022-11-28` so the field is always
   returned),
3. otherwise the real bytes are streamed once and hashed (180 s budget).

Verified against the live API: every asset of `g2code33/yayra` v1.0.78 reports a
`sha256:` digest, including the 161 MB AppImage — so the previous "cannot hash
inside one request" failure cannot recur for these releases.

If none of the three succeeds, the response names the fix ("press Retry
verification — it hashes ONE asset per request") instead of a generic failure.

**Approval requires a canonical package row.** Without it the release would be
marked verified but the publication gate only walks *package* rows — so that
platform would publish **ungated**. Approval is therefore refused with
`CONFLICT` and instructions to re-detect the release.

Network failures while streaming now return `null` (an honest "could not read")
instead of throwing, so a CDN outage surface as an actionable message rather
than an opaque 500.

## 10. Publishing a large release

"Approve & publish" used to re-hash **and** re-scan every asset in the single
publish request. For a release like yayra v1.0.79 (161 MB AppImage + three
~100 MB installers) that is ~750 MB of downloads; the Worker was killed and the
browser only saw a network error.

The publish path now binds bytes **without downloading**:

1. Each asset's GitHub `digest` is compared with the hash that was reviewed.
   Equal → the exact approved file is on GitHub. Different → the release is
   **blocked** and audited (`publish_blocked`).
2. Only when GitHub publishes no digest does it stream the file (180 s budget).
3. The security gate runs with `reverify: false` — the bytes were already bound
   in step 1, and re-running the pipeline would download them all again.
   Clearance semantics are unchanged: recorded evidence still has to authorize
   each package (AUTOMATED / MANUAL_APPROVAL / SECURITY_OVERRIDE) and DETECTED
   always blocks.

### The evidence gate was a no-op (fixed)

The gate demotes a `PASSED` badge that has no recorded checks by mutating its
own read of the package row — but D1 returns a copy, and the next statement
re-read it. A package flagged PASSED with zero evidence therefore still
authorized publication. The demotion is now applied to the local decision
(never to stored state), and requires at least one *terminal* recorded check.
