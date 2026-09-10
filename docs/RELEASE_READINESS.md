# RX Store — Final Integration Audit & Release Readiness (Prompt 10)

**Date:** 2026-09-10 · **Version:** 1.4.0 · **Phase:** final verification (no new features)

This is the release-readiness assessment for the complete RX Store system after
Prompts 1–10. It verifies that everything works together as **one coherent
system**, per the fundamental model:

> One account → many devices → each device has its own real installation state
> → native reality is authoritative for the current device → backend stores
> last-known state for other devices → downloads are verified → installations
> are verified → updates are verified → uninstall is verified → synchronization
> is reliable.

**Status legend** — **PASS** (implemented and verified here), **FAIL** (broken),
**BLOCKED** (cannot be verified in this sandbox; never reported as PASS),
**TECH DEBT** (non-blocking, safe to defer).

Per-requirement detail for Prompts 1–9 lives in
[`docs/ACCEPTANCE_CHECKLIST.md`](./ACCEPTANCE_CHECKLIST.md). This document is
the final top-level verdict.

---

## Verification matrix (exact results, this environment)

| Check | Command | Result |
| --- | --- | --- |
| Unit + integration + acceptance tests | `npm test` | **245/245 pass, 0 fail** (236 from Prompts 1–9 + 9 new Prompt 10 acceptance tests) |
| Frontend typecheck | `tsc --noEmit` | **0 errors** |
| Backend typecheck | `tsc --noEmit -p backend/tsconfig.json` | **0 errors** |
| Lint | `npm run lint` | **0 problems** |
| Web production build | `VITE_API_URL=… npm run build:web` | **success** |
| Web build, missing API config | `npm run build:web` (no env) | **fails clearly** (exit 1, actionable message) — by design (§20) |
| Web build, localhost API in production | `VITE_API_URL=http://localhost:8787 …` | **fails clearly** (exit 1) — by design (§20) |
| Web build, intentional no-backend | `VITE_ALLOW_UNCONFIGURED=1 npm run build:web` | success + explicit warning |
| Electron main/preload build | `npm run build:electron` | **success** (`dist-electron/main.cjs`, `preload.cjs`) |
| Electron installer packaging | `npx electron-builder --linux --dir` | **BLOCKED** — sandbox TLS: `unable to verify the first certificate` while fetching the Electron binary |
| Android APK build | `android/gradlew` | **BLOCKED** — no JDK (`JAVA_HOME is not set`), `ANDROID_HOME` unset |
| Tauri (legacy, non-shipping) | `cargo` | **BLOCKED** — no Rust toolchain |

---

## 1. Final architecture — PASS

The implemented flow matches the required model end-to-end:

```
RX Store Account (auth: PBKDF2 + JWT + rotating refresh sessions)
        ↓
Multiple Devices (devices table, UNIQUE(user_id, device_id), heartbeat/revocation)
        ↓
Independent App Installations (app_installations, UNIQUE(device_id, application_id))
        ↓
Native Detection (Windows registry / Linux dpkg+PATH+.desktop / Android PackageManager)
        ↓
Download (authenticated package selection: app → published release → channel → platform → arch)
        ↓
Checksum Verification (SHA-256 before anything is installed)
        ↓
Install / Update (native installer; failed update preserves the previous version)
        ↓
Native Verification (re-detection confirms the OS state; never assumed)
        ↓
Backend Synchronization (per-device installation records; durable offline queue)
```

No component contradicts the model. The single remaining architectural
limitation is documented, not hidden: `/r2/<key>` package downloads are
public-by-key (unsigned, non-expiring) — see §15 and `docs/RELEASES.md`.

## 2. Current device — PASS

Current-device installation state comes from native detection only.
`resolveLocalInstall()` (`src/native/installUi.ts`): with detection available,
the OS answer wins; localStorage cannot make an absent app appear installed.
Verified by `hardening.test.ts` (no-fake-state cases) and
`multiDeviceAcceptance.test.ts` (§2 case: backend-only state never yields OPEN).
Download records are never installation state (`downloads` table is analytics
only — enforced since Prompt 2).

## 3. Other devices — PASS

Other-device state comes from the backend's last-known records
(`GET /devices/installations`, user-scoped). The UI distinguishes
**current device** (native truth), **recently seen** (`Active` badge) and
**stale** (`Last seen` / `Offline` + "last known" labelling) —
`src/pages/Profile.tsx` device list and `reliability.test.ts`
("a stale other-device record is labelled 'last known', not current").

## 4. Installation pipeline — PASS

`IDLE → DOWNLOAD_STARTED → DOWNLOADING → DOWNLOAD_COMPLETED → VERIFYING →
VERIFIED → INSTALLER_STARTED → INSTALLATION_PENDING → VERIFYING_INSTALLATION →
INSTALLED`. Verification cannot be skipped: a completed download renders as
**Verifying…**, never OPEN, and checksum failure aborts before install
(`VERIFICATION_FAILED` → RETRY). Verified by `installTransaction.test.ts`,
`hardening.test.ts`, and the new `multiDeviceAcceptance.test.ts` §4 case which
asserts the full button sequence and both invariants.

## 5. Update pipeline — PASS

UPDATE follows the same verified pipeline with update wording
(Updating XX%). On failure, re-detection keeps reporting the previous version
(1.2.0), the button returns to **RETRY** then **UPDATE** (never GET — the
existing install is not erased), and crash recovery never assumes the target
version. Verified by `transactionRecovery` cases in `reliability.test.ts` and
the §5 acceptance case in `multiDeviceAcceptance.test.ts`.

## 6. Uninstall pipeline — PASS

UNINSTALL → native uninstall (Windows registered uninstaller —
QuietUninstallString preferred; Linux apt-get purge / store-owned AppImage
removal only; Android package uninstall intent) → **re-detection** (absence is
confirmed only after the OS reports it, within a 60s poll) → synchronization of
`not_installed`. No fake local-only removal: the record without detection is
rejected. Verified by `hardening.test.ts` (Android uninstall reconciliation,
fake-uninstall rejection) and the §6 acceptance case.

## 7. Windows — PARTIAL (code PASS, live OS BLOCKED)

Code verified: registry detection across HKCU/HKLM/WOW6432Node with
DisplayVersion/InstallLocation/DisplayIcon resolution and executable fallback
(`windowsFileVersion`, `resolveWindowsExecutable` via `where.exe`); Open via
direct `execFile` (never `shell.openPath`), stale-path → `STALE_EXECUTABLE`
re-detect error; uninstall parses UninstallString/QuietUninstallString into
exe+args arrays (no shell string), verifies the uninstaller exists on disk, and
the caller re-detects afterwards. No installer identifiers are invented —
detection is driven by the app's configured `windowsUninstallKey` /
`windowsExecutable`. **Live registry/uninstall execution requires a real
Windows machine — BLOCKED in this sandbox.**

## 8. Linux — PARTIAL (code PASS, live OS BLOCKED)

Code verified: `.deb` via `dpkg-query -W -f=${Version}`; PATH executable
detection; `.desktop` launcher resolution that reads the real `Exec` line and
**executes** it (never opens as text — `launchDetached` + `execBaseCommand`);
AppImage handling restricted to positively-identified store-owned
`rx-store-*.AppImage` files; uninstall via `apt-get purge` (OS handles
privilege) with strict package-name validation. **Live dpkg/.desktop/AppImage
runs require a real Linux desktop — BLOCKED here** (this sandbox has no display
and the flows are desktop-runtime dependent).

## 9. Android — PARTIAL (code PASS, device BLOCKED)

Code verified: `AppInstallerPlugin` detects distributed apps by their
configured `androidPackageId` via `getLaunchIntentForPackage` first, then
`getPackageInfo`; Android 11+ visibility handled by the scoped `<queries>`
manifest element (RX Store never enumerates the full package inventory); APK
install/update via the system installer intent (user confirmation required,
RX Store cannot silently install); uninstall intent + post-operation
re-detection reconciliation (tested logic in `hardening.test.ts`).
RX Store's own package `com.calcitonin.rxstore` is the store, never conflated
with distributed packages — the plugin only queries per-app configured ids.
**No device/emulator or JDK here — live APK flows BLOCKED.**

## 10. Web/PWA — PASS

Web browsers cannot inspect native installs: `resolveLocalInstall` with
detection unavailable falls back to the store record **explicitly labelled
`source: 'store'`** (weaker signal, documented), and native clients never use
it. Web never shows a native OPEN claim from localStorage. iOS remains PWA
only — no native iOS installation path exists or was added.

## 11. Multi-device acceptance test — PASS

The exact scenario from the spec is now an **executable test**
(`src/native/multiDeviceAcceptance.test.ts`) driving the real backend route
handlers with an in-memory D1 and the real frontend decision logic:

* Device A installs X → A: **OPEN**; backend: A → installed ✅
* Device B (same account, X absent) → B: **GET** + "Installed on another
  device" ✅ (stale store record cannot flip it)
* Device B installs X → B: **OPEN**; backend: A installed, B installed ✅
  (independent per-device records)
* Device B uninstalls X → B: **GET**; backend: A installed, B not_installed ✅
* Device A still **OPEN** ✅ (B's state never overrides A's native detection,
  and A's "installed elsewhere" hint correctly disappears)

## 12. Account isolation — PASS

Every device/installation query is scoped by the token-derived `user_id`:
device resolution (`WHERE user_id=? AND device_id=?`), registration upserts,
installation reports (a device that is not *yours* is `NOT_FOUND`), revocation
(`NOT_FOUND` for other users' devices), and listing. Verified by
`security.test.ts` (ownership scoping suite) and the §12 acceptance case:
user B sees only their own device, cannot target user A's device, and cannot
poison A's records. Downloads record the authenticated user but the storage
route itself is public (see §15).

## 13. Offline acceptance — PASS (logic), live-network BLOCKED for field tests

Verified by `reliability.test.ts`: native detection has no network dependency;
cache namespaces are separated (auth / catalog / device / installation /
transaction) and account-scoped; stale cached state never overrides native
reality; the sync queue persists across restarts, coalesces duplicates, backs
off exponentially (capped), and flushes on reconnect; crash recovery handles
every interrupted state honestly; a corrupted queue/cache is tolerated.
Sign-in gated sync returns `offline` state without crashing. Real
connectivity-loss field testing on devices is BLOCKED here.

## 14. Security acceptance — PASS

* Passwords: PBKDF2-HMAC-SHA256, 600k iterations, per-user salt — never
  plaintext (legacy SHA-256 hashes still verify + upgrade, no lockout).
* Refresh tokens: server-side sessions, hashed at rest, single-use rotation,
  replay rejected, revocation per-device and all-devices; access/refresh token
  types cannot be confused.
* Logout revokes the session and clears local tokens.
* Authorization enforced on every device/admin route (token-derived identity).
* CORS: explicit origin allowlist (`CORS_ALLOWED_ORIGINS`), no suffix/`includes`
  matching; dev-localhost only outside production.
* Rate limiting: true sliding window, per-identity+route rules.
* Reset tokens: hashed with 30-min expiry; never returned in production
  (`RESET_TOKEN_DEBUG` off); no email provider integrated (documented).
* API errors: standardized codes, no stack traces/internals; request IDs
  correlated client↔server; logs never contain passwords/tokens (redaction
  tested).

Caveat (documented in `docs/SECURITY.md`): 600k PBKDF2 iterations can exceed
the Workers free-plan 10 ms CPU budget — paid plan recommended.

## 15. Package acceptance — PASS (with one documented FAIL: unsigned URLs)

Every published package carries version, platform, architecture, size, SHA-256
and a storage key; publishing **fail-closed** verifies the storage object
exists (`STORAGE.head`) and that the recorded size matches storage exactly.
Package selection filters by application → published release → channel →
platform family → architecture (with agnostic fallback) → compatibility
(`min_os_version` / `min_android_sdk`) → integrity, so an incompatible
artifact is never selected. Verified by `releases.test.ts` +
`validatePackageIntegrity`/`selectPackage` cases.

**FAIL (carried, documented):** download URLs (`/r2/<key>`) are public,
unsigned and non-expiring — intentional free-tier behavior, documented in
`docs/RELEASES.md` with the signed-URL extension point (`buildManifest()`).
Not claimed as private anywhere.

## 16. File size — PASS

No package size depends on manual entry: the manual Size field was removed from
the admin editor; `file_size` is recorded from the actual uploaded artifact at
upload time; publish re-validates it against storage; `applications.size_mb`
and the storefront `sizes` map are derived from published packages only.
Verified by code inspection (`backend/src/routes/admin.ts`,
`src/components/admin/AppEditor.tsx`) and `releases.test.ts`.

## 17. Release system — PASS

Application → Release → Package (platform + architecture) is canonical:
`UNIQUE(release_id, platform, architecture)`; stable/beta/development channels
with role-based defaults; publishing validates integrity fail-closed; rollback
marks the current release `rolled_back`, archives its packages, restores the
previous release and re-publishes its packages without deleting history;
legacy `versions`/`app_versions` are kept in sync for old clients only and are
documented as non-canonical. Admin UI includes the architecture selector.
Verified by `releases.test.ts` and `hardening.test.ts` (migration checks).

## 18. Database — PASS

Migrations execute in order with **no duplicate numbers** (the historical
`0005` collision was resolved as `0005b`, documented in-file; dup-check clean).
Foreign keys cascade (`devices`, `app_installations`, `packages`, `auth_sessions`
→ parents). Unique constraints enforce `(user_id, device_id)`,
`(device_id, application_id)`, `(release_id, platform, architecture)`,
`(app_id, user_id)` reviews, session token hashes. Indexes exist for the
device/installation queries (`idx_devices_user/device_id/status`,
`idx_app_installations_user/device/app`, `idx_packages_release/platform/arch`,
`idx_auth_sessions_*`). Production data is never reset — migrations are
additive/`IF NOT EXISTS`. Deployment commands listed in `docs/DATABASE.md`.

## 19. Cleanup — PASS (conservative)

Performed after verification, this phase: corrected the misleading
"defaults to mock mode" comment in `src/services/api.ts`; replaced the
crash-prone undefined-API calls with clear errors (3 call sites, see §20).
From Prompt 9: dead health route, duplicate `formatBytes`, duplicate
migration, unused deps (`framer-motion`, `jimp`), unused exports already
removed. **Tauri/Flutter legacy code is intentionally retained** (not shipping,
but not proven unsafe to remove). No legacy architecture was deleted merely
for being old.

## 20. Production configuration — PASS (fixed this phase)

* **Build-time guard (new):** production builds now **fail clearly** when
  `VITE_API_URL` is missing or points at localhost (exit 1 with actionable
  messages). `VITE_ALLOW_UNCONFIGURED=1` is the explicit, warned opt-out for
  preview/CI bundles. All four paths verified (see matrix).
* **Runtime:** unconfigured builds surface "RX Store is not connected to its
  application service…" — never fake success. This phase fixed the last three
  crash-prone spots (`AppCard` legacy download, `AppDetail` review submit,
  `Admin` app delete) which previously threw
  `Cannot read properties of undefined (reading 'replace')`.
* **Secrets:** only `VITE_API_URL` / `VITE_ALLOW_UNCONFIGURED` exist; both are
  public-by-design. A scan of the built bundle found no secrets (only public
  API origin + UI form-field strings).

## 21. Final tests — PASS (matrix above)

245/245 tests, 0 type errors (frontend + backend), 0 lint problems, web build
success (all config paths), Electron main/preload build success. Installer
packaging and device builds remain environment-BLOCKED (see matrix).

## 22. Final acceptance summary

### PASS (verified)
Architecture coherence (§1) · current-device native authority (§2) ·
other-device last-known + staleness (§3) · install pipeline without skipped
verification (§4) · update failure preserves existing install (§5) ·
uninstall pipeline with re-detection (§6) · Windows/Linux/Android **code paths
with tested decision logic** (§7–9) · web/PWA honesty + iOS-as-PWA (§10) ·
the exact multi-device acceptance scenario as an executable test (§11) ·
account isolation (§12) · offline queue/recovery logic (§13) · security
acceptance (§14) · package integrity/selection (§15, except URLs) ·
artifact-derived sizes (§16) · canonical release system (§17) ·
database integrity (§18) · safe cleanup (§19) · production config guard,
runtime honesty, no secrets in bundles (§20) · full test matrix (§21).

### FAIL (known, documented — none hidden)
1. **Download URLs are public/unsigned/non-expiring** (`/r2/<key>`). Deliberate
   current-tier tradeoff, documented in `docs/RELEASES.md`; signed expiring
   URLs are the recommended next hardening step.

### BLOCKED (environment limits — never counted as PASS)
1. Live Windows registry/executable/uninstall execution (needs a Windows PC).
2. Live Linux dpkg/.desktop/AppImage open/uninstall (needs a Linux desktop).
3. Live Android install/update/uninstall on device/emulator (needs JDK + SDK).
4. Electron installer packaging (sandbox TLS blocks the Electron binary
   download; Wine absent for cross-building Windows installers).
5. Android APK build (no JDK, `ANDROID_HOME` unset).
6. Real network offline/online field tests on physical devices.

### TECHNICAL DEBT (non-blocking, safe to defer)
1. Signed, expiring download URLs (extension point ready in `buildManifest()`).
2. Email delivery for password reset (no provider integrated; tokens hashed +
   never leaked, but delivery is manual in production).
3. 2FA, account lockout, email verification, malware scanning of uploads,
   signed update manifests — none present; all documented in
   `docs/SECURITY.md`.
4. PBKDF2 600k iterations vs Workers free-plan CPU budget — paid plan or a
   tuned constant.
5. Legacy `versions`/`app_versions` dual-write for old clients — remove after
   old client versions age out.
6. Tauri/Flutter legacy trees retained — archive or delete once desktop is
   confirmed Electron-only going forward.
7. Live OS acceptance runs (§7–9 BLOCKED items) should be executed on real
   hardware before public launch, using the checklists in
   `docs/ACCEPTANCE_CHECKLIST.md`.

## 23. Final product requirement — verdict

RX Store now behaves as a **real cross-platform application store**, not a
localStorage simulation: one account maps to many devices with independent,
per-device installation state; native detection is authoritative for the
current device; the backend holds last-known state for other devices and is
clearly labelled as such; downloads are checksum-verified before install;
installations and updates are confirmed by re-detection; failed updates
preserve the previous version; uninstalls are confirmed by absence detection;
synchronization is queued durably and survives restarts/offline; accounts are
isolated; and production builds refuse to ship silently misconfigured.

**Release readiness: READY for configured deployments, with the environment
BLOCKED items (real-OS/device validation, installer packaging) to be executed
on real hardware before public distribution.** The one FAIL (public download
URLs) is a documented product decision, not a hidden defect.

---

## Changes made in this phase

| File | Change |
| --- | --- |
| `vite.config.ts` | Production build guard: fail clearly on missing/localhost `VITE_API_URL`; explicit `VITE_ALLOW_UNCONFIGURED=1` opt-out |
| `src/vite-env.d.ts` | Type the new env var |
| `src/components/apps/AppCard.tsx` | Clear error instead of `undefined.replace` crash in the legacy web download |
| `src/pages/AppDetail.tsx` | Clear error for review submit when unconfigured |
| `src/pages/Admin.tsx` | Clear error for app delete when unconfigured |
| `src/services/api.ts` | Corrected misleading "mock mode" comment |
| `src/native/multiDeviceAcceptance.test.ts` | NEW — the §11 multi-device acceptance scenario + §2/§4/§5/§6/§12 acceptance cases (9 tests) |
| `package.json` | Test script includes the new suite |
| `docs/RELEASE_READINESS.md` | This report |
