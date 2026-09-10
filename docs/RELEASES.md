# RX Store — Release, Package & Update Architecture

This document defines the **canonical** release system and the package-selection
rules. It reflects what is actually implemented.

---

## 1. Canonical model

```
Application
   └── Release            (version + channel + status; UNIQUE(application_id, version))
          └── Package      (one artifact per platform + architecture)
                 ├── Platform      windows | linux_deb | linux_appimage | android | macos | flatpak | web | pwa | ios
                 └── Architecture  x64 | arm64 | x86 | arm | universal
```

**Canonical tables: `releases` + `packages`.** This is the preferred source of
truth for current release/package metadata, and the only system the download
route consults for selection.

**Legacy:** `versions` and `app_versions` remain for backwards compatibility
(old clients read `app_versions.files`). They are **kept in sync on publish** by
`syncLegacyAppVersion`, which mirrors each published release's packages. They are
never read first — the canonical path wins. Do not add a third version system.

### Package uniqueness

`packages` is unique on **`(release_id, platform, architecture)`** (migration
`0008_packages_architecture.sql`). This allows:

| Release | Platform | Architecture |
| --- | --- | --- |
| 1.2.0 | `windows` | `x64` |
| 1.2.0 | `windows` | `arm64` |
| 1.2.0 | `android` | `universal` |
| 1.2.0 | `android` | `arm64` |
| 1.2.0 | `linux_deb` | `x64` |

Previously the constraint was `(release_id, platform)`, which made shipping more
than one architecture per platform impossible.

---

## 2. Release channels

Channels: **`stable`**, `beta`, `alpha`.

* `releases.channel` is validated against that set on publish; an unknown
  channel is refused.
* Normal users and anonymous callers always resolve to **`stable`**
  (`defaultChannel()`), so an unpublished/experimental channel is never served
  by accident.
* A non-stable channel may only be requested by an authenticated **admin**
  (`?channel=beta` is downgraded to `stable` for everyone else).
* Only releases with `status = 'published'` are ever selected. Drafts,
  `ready_for_review`, `disabled`, `rolled_back` and `archived` releases are
  excluded by the query and re-checked in code.

---

## 3. Version semantics

Version comparison is centralized in `backend/src/services/releases.ts`
(`parseSemver` / `compareSemver` / `isNewer`). Rules:

* `1.10.0 > 1.9.0`, `2.0.0 > 1.99.0` (numeric, not lexicographic)
* `1.3.0 > 1.3.0-beta` (a final release is newer than its prerelease)
* `1.3.0-beta.2 > 1.3.0-beta.1`; build metadata is ignored for precedence
* partial versions are accepted (`1.2` == `1.2.0`)
* unparseable input sorts **below** parseable input, so a real version always wins

`backend/src/routes/updates.ts` delegates to this implementation — its previous
local comparator could not distinguish `1.3.0-beta` from `1.3.0` and could
therefore suppress a legitimate update.

---

## 4. Package selection

`selectPackage(packages, { platform, architecture })` is deterministic:

1. Only packages of the requested platform family are considered. The legacy
   generic `linux` request expands to `linux`, `linux_deb`, `linux_appimage`,
   `flatpak` (in that preference order).
2. Architecture must match **exactly**, or fall back to a `universal` build.
   An explicit `arm64` request is **never** silently satisfied by an `x64`
   build — the caller gets a clear reason instead.
3. A `universal` request (unknown/unspecified device architecture) accepts any
   build, preferring `universal` first.
4. Web/PWA/iOS packages are architecture-agnostic and resolve to `universal`.
5. Packages failing integrity validation are skipped.
6. No compatible candidate ⇒ `{ selected: null, reason }` and the download route
   returns `404 NO_COMPATIBLE_PACKAGE` (it never fabricates a URL).

---

## 5. Release manifest

`buildManifest(...)` produces the client-facing manifest containing everything a
client needs to decide and verify:

```jsonc
{
  "app": { "id": "...", "slug": "cgpa-pilot", "name": "CGPA Pilot" },
  "version": "1.0.25",
  "channel": "stable",
  "platform": "linux_deb",
  "architecture": "x64",
  "filename": "cgpa-pilot_1.0.25_amd64.deb",
  "size": 104857600,          // ALWAYS derived from the uploaded artifact
  "sha256": "…64 hex…",
  "url": "https://…/r2/apps/…",
  "packageType": "installer",
  "releaseNotes": ["…"],
  "mandatory": false,
  "minOsVersion": "10.0.19041",   // optional, informational
  "minAndroidSdk": 24             // optional, informational
}
```

The legacy flat fields (`url`, `checksum`, `size`, `fileName`, `version`,
`platform`) are still returned alongside `manifest` for older clients.

---

## 6. OS compatibility

`packages.min_os_version` (TEXT) and `packages.min_android_sdk` (INTEGER) are
optional. `isOsCompatible()` is **informational and never blocking**: an app
without compatibility metadata is always compatible, and a missing device signal
never blocks a download.

---

## 7. Package integrity & publish validation

`validatePackageIntegrity()` requires: `platform`, `architecture`, `filename`,
`version`, a valid 64-hex `sha256`, and a positive `file_size`. Non-PWA packages
also require `storage_key`.

`publishRelease` refuses to publish when:

* the release has no version, or an unknown channel
* there are no packages
* any package is incomplete (missing metadata)
* two packages resolve to the same `platform/architecture`
* a web/PWA package has no HTTPS deployment URL
* the artifact is **missing from storage** (`STORAGE.head` returns null)
* the recorded `file_size` **disagrees with the object actually stored**

---

## 8. Rollback

`rollbackRelease` marks the current release `rolled_back`, archives its packages,
then **restores the target release to `published` and re-publishes its packages**.
History is never deleted — no release row is removed, and rolling back twice (or
rolling back to a release whose packages were previously archived) still leaves
the app with a servable package.

---

## 9. Storage policy (honest)

Object storage is served by the Worker at `GET /r2/<key>`, and **that route is
public**: anyone who knows/guesses a key can fetch the object. Keys are
predictable (`apps/<slug>/<version>/<platform>/<arch>/<filename>`).

* Package URLs are **public, unsigned, non-expiring**.
* They are **not** signed or temporary. Do not describe them as private.
* The `/apps/:slug/download` endpoint adds bookkeeping (download counting, admin
  toggles, maintenance mode) and returns the manifest + URL — it is **not** an
  access-control boundary.
* **Extension point for signed URLs:** `buildManifest()` is the single place a
  URL is produced. To protect paid/private packages, replace the
  `${origin}/r2/${storage_key}` construction there with a short-lived signed URL
  (R2 presigned GET or an authenticated streaming route) and leave public free
  packages on the existing `/r2/` path. Nothing else needs to change.

---

## 10. Downloads ≠ installations

`downloads` is a log of download events with the authenticated `user_id`
(derived from the token, never the request body). Installation state lives in
`app_installations` (Prompt 2) and is only written after **confirmed native
detection** (Prompt 3/4). A completed download is never treated as an install.

---

## 11. Pagination

`GET /apps` returns pagination metadata computed from a separate filtered
`COUNT(*)`, not the page length:

```json
{ "pagination": { "page": 2, "limit": 20, "pageSize": 20, "total": 57,
                  "totalPages": 3, "hasNext": true, "hasPrevious": true } }
```

`page` clamps to ≥ 1 and `limit` to 1–100.

Search is unchanged (LIKE-based, backed by the existing indexes) — no new
infrastructure was introduced.

---

## 12. Migration

```bash
npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0008_packages_architecture.sql
```

Non-destructive: existing rows are copied forward, with a missing architecture
normalized to `x64` (the previous hard-coded value), so behaviour for
single-architecture releases is unchanged. Indexes are recreated after the table
rename (D1 drops indexes with the table).
