# RX Store — Account-Aware Device & Installation System

This document explains the foundation for a production-grade, account-aware,
multi-device RX Store installation system. It is a *foundation*: the pieces are
wired end-to-end and unit-tested, but the release pipeline, R2 upload flow, and
the release manager are intentionally untouched.

---

## 1. High-level model

```
account (user)
  └── device (one stable RX Store install per machine/browser)
        └── application  ── app_installation (one record per device/app)
```

- **Local native detection is AUTHORITATIVE for the current device.**
- **The cloud (`app_installations`) is LAST-KNOWN info for OTHER devices.**
  It is used only to render "Installed on N other devices" — it can never flip
  the current device's Get button to Open.

---

## 2. Native Runtime abstraction

New generic layer at `src/native/` — no application-specific (e.g. "CGPA
Pilot") logic lives here. It composes the existing platform modules.

```
src/native/
├── deviceIdentity.ts   → stable per-install device id + device record
├── runtime.ts          → NativeRuntime (Detection / Launcher / Installer /
│                          Updater / Uninstaller / DeviceIdentity)
└── accountSync.ts      → register/heartbeat device + report/reconcile installs
```

### Device identity (`deviceIdentity.ts`)
- `getDeviceId()` produces a stable `crypto.randomUUID()` persisted in
  `localStorage` under `rx-store-device-id`.
- Stable across RX Store restarts (app:// origin persists for Electron; WebView
  localStorage persists for Android; browser localStorage persists per origin for
  the PWA).
- Stable across login/logout (it is not keyed to the user).
- Unique per install; never derived from an IP; stores no hardware identifiers
  (only a best-effort OS version string from the user agent).
- The web/PWA uses a browser-scoped identity but **never** claims native
  detection (`canDetect()` is false on web).

### Runtime (`runtime.ts`)
`getNativeRuntime()` exposes:
- `detect(app)` → current-device `InstalledApp | null`
- `resolve(app, { operation, otherInstallations, currentDeviceId })` →
  `{ state, otherDevices }` (current-device-authoritative)
- `refresh(appId)` → invalidate local + Electron caches and re-detect
- `open(app, target)` → launch via the OS (execFile on desktop, package launch
  on Android, URL → system browser)
- `install(app, url, fileName)` / `uninstall(app, target)`
- `device()` → the stable device record

---

## 3. Fixing the Linux/Windows "Open" bug (`electron/main.ts`)

Previously `native:open` used `shell.openPath(target)`, which *opened* the
launcher/executable as a text file (the reported Ubuntu CGPA Pilot bug).

Now:
- A **URL** target → `shell.openExternal` (kept separate from native launching).
- A **local** target → `launchDetached(target)` which uses `execFile(target, [])`
  (no shell, no `shell.openPath`, no `xdg-open`). For a launcher script this
  executes the launcher itself (preserving its Chromium sandbox setup); for an
  `.exe` it starts the executable. `.bat`/`.cmd` are run via `cmd.exe /c <path>`
  (single argument, not concatenation); `.lnk` are resolved via PowerShell with
  the path passed through an environment variable.

---

## 4. Real uninstall (`electron/main.ts`)

Detection now returns uninstall metadata and `native:uninstall` invokes the
registered mechanism directly instead of opening a software manager.

### Windows
- `detectWindows` reads each uninstall subkey's `UninstallString`,
  `QuietUninstallString`, `DisplayVersion`, `InstallLocation`, `DisplayIcon`.
- `uninstallWindows(target)` parses the `UninstallString` into executable + args
  (no shell) and runs it **detached** so Windows shows its normal
  confirmation/privilege UI.
- The app is never "uninstalled" just because the intent was launched.

### Linux
- Debian/Ubuntu package: `uninstallLinux` runs
  `apt-get purge -- <package>` directly (via `execFile`, argument array, no
  shell) so the OS handles privilege authentication. No manual sudo/password
  handling inside RX Store.
- AppImage: only removes an AppImage that RX Store can positively establish as
  a store-managed artifact (filename must match `rx-store-*-*.AppImage`). Never
  deletes an arbitrary file.
- Flatpak is prepared for via the `packageName` field (the abstraction holds the
  app ID; invocation is left to a future integration since Flatpak is not
  currently a shipped target).

---

## 5. Linux detection improvements (`electron/main.ts`)

- Keep the existing `dpkg-query -W -f=${Version}` package detection.
- Keep PATH executable resolution via `whichInPath` (pure fs scan, no shell).
- **New `.desktop` fallback**: reads `/usr/share/applications` and
  `~/.local/share/applications`, parses `Name`/`Exec`/`Icon`/`NoDisplay` safely,
  and matches the app's configured `linuxExecutable`/`linuxPackageName`. The
  resolved launcher `Exec` becomes the launch target so `Open` runs the real
  launcher.

---

## 6. Android uninstall & reconciliation

- The existing Capacitor `AppInstaller` plugin is kept (it already emits live
  `downloadProgress` and reports `isInstalled(packageId)` → `{ installed,
  version, packageId, platform }`).
- Distributed app identities use each app's configured `android_package_id`
  (e.g. `com.cgpapilot.app`), never RX Store's own `com.calcitonin.rxstore`.
- After `uninstall` (which launches Android's uninstall intent), the frontend:
  1. invalidates the detection cache,
  2. re-runs `PackageManager` detection,
  3. only then reports the current device as not installed /
     reconciles to the account.

---

## 7. Installation state model (`src/platform/detect.ts`)

The system is not a single boolean. `InstallState` supports:

```
NOT_INSTALLED  INSTALLED  UPDATE_AVAILABLE  INSTALLING  UPDATING  UNINSTALLING
INSTALL_FAILED UPDATE_FAILED UNINSTALL_FAILED  DETECTION_UNAVAILABLE
```

Pure helpers (unit-tested):
- `currentDeviceInstallState(local, storeVersion, operation)` — the current
  device's state from real detection (authoritative).
- `resolveDeviceView({ local, storeVersion, operation, otherInstallations,
  currentDeviceId })` → `{ state, otherDevices }` — enforces that local
  detection wins and cloud info never flips to OPEN.
- `otherDeviceInstallCount(...)` — excludes the current device id.
- `installStatusForReport(state)` → backend lowercase status string.

UI mapping stays: `NOT_INSTALLED → Get`, `INSTALLED → Open`,
`UPDATE_AVAILABLE → Update`, plus transitional states while an operation runs.

---

## 8. localStorage compatibility

The existing `rx-native-packages` and `rx-store-installed` keys are **retained**,
not deleted. They are treated as legacy/display cache only. The authoritative
state comes from native detection (current device) and the backend
(`app_installations`, other devices). Existing login/logout flows are untouched.

---

## 9. Account device-sync API (`/devices/*`)

Authenticated endpoints in `backend/src/routes/devices.ts`, wired in the worker
(`backend/src/index.ts`), all scoped to the requesting user:

| Method | Path                       | Purpose |
| ------ | -------------------------- | ------- |
| POST   | `/devices/register`         | idempotent upsert of the current device (per user + device) |
| POST   | `/devices/heartbeat`        | bump `last_seen_at` + version (revoked devices are ignored) |
| GET    | `/devices?currentDeviceId=` | list the user's devices, the current device flagged |
| POST   | `/devices/:deviceId/revoke` | revoke one of the user's devices (does NOT uninstall its apps) |
| POST   | `/devices/installations`    | upsert the current device's app installation record (revoked rejected) |
| GET    | `/devices/installations`    | list installation state across the user's devices |

DB tables (`backend/migrations/0006_devices_installations.sql` + `schema.sql`):
- `devices(id, user_id, device_id, device_name, platform, device_type,
  os_version, rx_store_version, app_version, last_seen_at, created_at,
  updated_at, revoked_at, status, UNIQUE(user_id, device_id))` — `id` is the
  internal row id; `device_id` is the stable client per-install id.
- `app_installations(id, user_id, device_id, application_id, platform,
  installed_version, status, detection_source, last_detected_at, installed_at,
  updated_at, UNIQUE(device_id, application_id))` — `device_id` references
  `devices.id` (internal).

The `UNIQUE(user_id, device_id)` means the SAME physical install registered under
two different accounts gets its OWN row, so account state is isolated on shared
computers and a device never becomes a duplicate on every start. The unique
constraint on `app_installations` prevents duplicate records on re-detection;
the upsert keeps exactly one current record per (device, application).

### Migration numbering
There were previously **two** `0005_*` migrations. I did **not** add another
`0005`. The new migration is `0006_devices_installations.sql`, and the tables
are also created lazily (idempotent `IF NOT EXISTS`) in `devices.ts` so existing
deployments need no manual step.

---

## 10. UI behavior

`src/context/DeviceContext.tsx` is the clean frontend state layer: it exposes
`currentDevice`, `devices`, `installations`, `syncState`, and `syncNow / refresh
/ revoke / reportInstallation`. Components stay presentational and consume it
via `useDevices()`.

`src/pages/AppDetail.tsx`:
- Current-device action is `Get` / `Open` / `Update` from **local detection**
  (`useInstalledState` + `getNativeRuntime().resolve`).
- When `!osInstalled` but the cloud reports this app installed elsewhere, it
  shows a small **"Installed on N other devices · <device name>"** hint — it does
  **NOT** change `Get` to `Open`.
- After successful native operations the code invalidates the cache, re-detects,
  reconciles the UI, and reports the confirmed state to the account.

`src/pages/Profile.tsx` gains a **"My Devices"** tab: lists the account's devices
with the current one flagged, a human-friendly name, platform, last-seen,
a Refresh action, and a safe "Remove" (revoke) that does NOT uninstall apps.

`src/components/apps/AppCard.tsx` continues to use local detection for the card
action (no cloud override).

---

## 11. Security

- All OS spawning uses `execFile` / `Command::args` (argument arrays), never a
  shell string → no command injection from registry keys, package names,
  executable/path metadata, app names, or package IDs.
- `Open` only launches a target that was positively detected **and** verified to
  exist on disk.
- URL handling is separated from native launching.
- The preload surface stays minimal; context isolation is unchanged.
- AppImages are only removed when RX Store can positively establish ownership.
- Invalid package/executable names are rejected before invoking package managers.

---

## 12. Tests

- `src/platform/detect.test.ts` (53 tests): current device installed/not
  installed, installed only on another device, installed on multiple devices,
  current device outdated while another is current, uninstall changes only the
  current device, other-device installations unchanged, version comparison,
  detection unavailable, operation state overrides, the full Phone A / Phone B
  multi-device scenario, update preserving the actual installed version until
  verification, offline detection, Windows uninstall metadata, Android uninstall
  reconciliation, backend status mapping, and device staleness thresholds.
- `src/native/deviceIdentity.test.ts` (5 tests): device id persists across reads,
  device id survives logout (never regenerated), different installs get different
  ids, a human-readable device name is produced, and web never claims native
  detection.

Native OS access is not exercised (that requires real Windows/Linux/Android);
the pure decision layer is tested in isolation. Run all with `npm test` (58
tests, all passing on the repo).

---

## 13. Remaining limitations / not in this phase

- **iOS is PWA-only**: no native iOS package detection is added.
- **Tauri/Flutter** are legacy and are not part of the active Electron path.
- **Flatpak** uninstall invocation is prepared for but not wired to a shipped
  target.
- The web/PWA can register a device and report browser-scoped installs, but it
  never performs native detection (`canDetect()` is false).
- The release/R2 pipeline and the release manager are untouched (auto size,
  SHA-256, channels, status all preserved).
