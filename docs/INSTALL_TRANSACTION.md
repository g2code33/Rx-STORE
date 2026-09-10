# RX Store — Installation / Update Transaction Pipeline

This document explains how RX Store distinguishes **downloading** an application
from **actually installing it**, verifies the artifact before installation,
verifies the installation after installation, and synchronizes only verified
native state with the account.

## The core rule: DOWNLOAD ≠ INSTALL

A completed download is **never** treated as an installed application. The
transition to `INSTALLED` only happens after native detection actually confirms
the application is present (and, for an update, that the version advanced).

```
GET / UPDATE
  → DOWNLOAD_STARTED
  → DOWNLOADING          (progress: received / total / percent)
  → DOWNLOAD_COMPLETED
  → VERIFYING            (size + SHA-256)
  → VERIFIED
  → INSTALLER_STARTED
  → INSTALLATION_PENDING
  → VERIFYING_INSTALLATION  (poll native detection within a window)
  → INSTALLED
```

Failure states:

```
DOWNLOAD_FAILED, VERIFICATION_FAILED, INSTALL_FAILED,
INSTALLATION_NOT_DETECTED, CANCELLED
```

The central model lives in `src/native/installTransaction.ts`
(`TransactionState`, `createTransaction`, `transition`, `createTransactionStore`).
The UI consumes the state via `src/native/useInstallTransaction.ts`; components
never infer the lifecycle on their own.

## Files

- `src/native/verify.ts` — pure SemVer comparison + artifact verification
  (size + SHA-256). `verifyArtifactHash` hashes and compares; a size mismatch or
  a SHA-256 mismatch fails verification and is never installed. Prereleases sort
  below the same final release (`1.3.0-beta < 1.3.0`), and `1.10.0 > 1.9.0`.
- `src/native/installTransaction.ts` — the transaction state machine + a
  subscription store.
- `src/native/installCoordinator.ts` — the coordinator that drives the pipeline:
  download → verify → install → detect → sync. Platform operations are injected
  so it is unit-testable and honest about platform capabilities.
- `src/native/useInstallTransaction.ts` — React hook exposing the transaction
  state to the UI.
- `src/native/installTransaction.test.ts`, `src/native/verify.test.ts` — tests.

## Platform behavior

### Web / PWA
- Streams the artifact body so progress + SHA-256 are computed in place.
- `verifyArtifactHash` compares size + checksum; on failure the artifact is
  discarded and `VERIFICATION_FAILED` is emitted (no install).
- A website is only opened when the application is explicitly a web/PWA app —
  never as a fallback for a native app whose executable couldn't be detected.

### Desktop (Electron)
- Download via the Electron main process (`native:download`), streaming
  `native-download:progress`.
- SHA-256 is computed in the **main process** (`native:hash-file`) so the
  renderer never needs arbitrary file-read privileges; size + checksum are
  compared before install.
- `native:install` opens the OS installer (`.exe` / `.deb` / `.AppImage`). For
  an AppImage the launcher is made executable and launched directly — never
  opened as text (the Ubuntu/CGPA Pilot bug).
- After install, the coordinator polls native detection within a
  `INSTALL_VERIFY_WINDOW_MS` window. If detection confirms the app (and, for an
  update, the new version), it becomes `INSTALLED`; otherwise
  `INSTALLATION_NOT_DETECTED` / `INSTALLATION_PENDING`.

### Android (Capacitor)
- The existing `AppInstaller` plugin downloads via `DownloadManager`, streams
  progress, computes the APK SHA-256 on completion (`downloadProgress` →
  `complete.sha256`), and opens Android's protected installer.
- The coordinator verifies size + the plugin-reported SHA-256, then relies on
  post-install `PackageManager` detection to confirm the installed
  package/version. Installer-launched ≠ installed.

## Update / failed-update semantics

- `previousVersion` (e.g. `1.2.0`) is preserved on the transaction. If an update
  to `1.3.0` fails verification or installation, native detection still reports
  `1.2.0` installed, so the UI continues to offer `UPDATE` (never `GET`).
- `UPDATE` uses the same pipeline and only resolves to `OPEN` after detection
  confirms the new version.

## Backend synchronization

After native detection confirms the final state, the coordinator calls
`reportCurrentInstallation` (via `src/native/accountSync.ts`) with the
**confirmed** `installed_version` / `status: installed`. Uninstall reports
`status: not_installed` only after native detection confirms removal. The backend
is never updated to "installed" merely because an installer was launched.

## Download records ≠ installation records

The `downloads` table is a log, not installation state. The canonical
`/apps/:slug/download` route now records the download **with the authenticated
user's `user_id`** (derived from the token, never from the client body) and
returns authoritative package metadata (`url`, `checksum`, `size`, `fileName`,
`version`, `platform`) from the **releases/packages** system. Installation state
lives in `app_installations` (account/device) and is only updated after verified
native detection.

## Tests

- `src/native/verify.test.ts` — SemVer (`1.2.0<1.2.1<1.10.0`, `2.0.0>1.9.99`,
  prerelease ordering), checksum success/failure, file-size mismatch, empty
  download, missing checksum, PWA exemption.
- `src/native/installTransaction.test.ts` — unique attempt id, `transition` does
  not mutate, `describeTransaction`, `isFailed`/`isTerminalSuccess`, download
  completion never becomes INSTALLED, failed update preserves the previous
  version, store subscription.

---

## Prompt 4 — Native lifecycle hardening

### Electron Open
- Detected **executable/launcher** targets are launched via direct `execFile`
  (no shell, no `shell.openPath`). A Linux launcher script is executed, never
  opened as text (the Ubuntu/CGPA Pilot fix).
- **URLs** are kept separate: a URL target (web/PWA) opens via
  `shell.openExternal`. A native app's executable is never routed through a URL.
- A **stale executable path** (the file no longer exists on disk) throws
  `STALE_EXECUTABLE: ...` so the frontend re-detects and informs the user. A
  failed Open is a **recoverable** error and is **never** treated as an
  uninstall (`classifyOpenFailure`).

### Windows detection + uninstall
- Detection exposes `UninstallString`, `QuietUninstallString`, `DisplayVersion`,
  `InstallLocation`, `DisplayIcon`, executable, across HKCU / HKLM /
  WOW6432Node. No invented GUIDs.
- Uninstall prefers `QuietUninstallString` when present (silent where safe),
  otherwise `UninstallString` (shows Windows' confirmation/privilege UI). Both
  are parsed into executable + **args array** (never a shell string) and the exe
  is validated to exist before launch. A command that can't be safely parsed is
  rejected (`parseWindowsCommand`).

### Linux detection + uninstall
- Detection uses dpkg + PATH + `.desktop` entries (`/usr/share/applications`,
  `~/.local/share/applications`), extracting `Name`, `Exec`, `Icon`, `NoDisplay`.
- `.deb`: `apt-get purge -- <pkg>` via the OS (handles privilege/auth), then
  re-detect. AppImage: only an RX Store-owned (filename
  `rx-store-<version>.AppImage`) artifact is removed; `appImagePath` is tracked
  so uninstall removes ONLY that store-owned file and never unrelated user files.

### Android
- Open uses the actual distributed package ID via the plugin's launch intent,
  never RX Store's own `com.calcitonin.rxstore`.
- Uninstall launches Android's delete flow, then **re-runs detection**; the
  current device is reported `not_installed` only after confirmed absence (the
  reconciler polls within a verification window). `isInstalled` is Android 11+
  visibility-safe (`getLaunchIntentForPackage` first, then `getPackageInfo`).

### Verification
Every install/update/uninstall goes through native detection verification. An
`INSTALLER_STARTED` state is never treated as `INSTALLED`; only detection
confirmation reaches `INSTALLED`, and only confirmed absence reaches
`not_installed`.

---

## Prompt 5 — Frontend installation state & multi-device UX

### Single source of truth
- `src/native/installUi.ts` maps the transaction state machine + the current
  device's detected install state into one `InstallButton` (`GET`, `DOWNLOADING`,
  `VERIFYING`, `INSTALLING`, `CHECKING`, `OPEN`, `UPDATE`, `UPDATING`, `RETRY`).
- `src/native/useInstallButton.ts` combines the active transaction + native
  detection so AppCard / AppDetail read one button, never inferring conflicts.
- Native detection is authoritative for the CURRENT device; the backend
  (`app_installations`) is last-known for OTHER devices; localStorage is cache
  only. `currentDeviceInstallState` / `resolveDeviceView` enforce this.

### Button states
`installButtonFor` maps every state to a clear label and `action`:
- idle not installed → `GET`; installed → `OPEN`; update → `UPDATE`.
- `Downloading 42%`, `Verifying…`, `Installing…`, `Checking installation…`,
  `Updating 42%`, failure → `RETRY`.
- Update wording is used throughout the transient pipeline when `isUpdate`.

### Installed elsewhere / multiple devices
AppCard and AppDetail show `Installed on another device` / `Installed on N
devices` from `otherDeviceInstallCount` — this NEVER flips the current device to
`OPEN`. The user can still install locally (`GET`).

### My Apps (Profile)
Uses native detection (`useInstalledState`) for each installed app and the real
native uninstall flow (`useNativeRuntime().uninstall`), which re-detects before
reconciling. It never reports uninstalled merely because the intent launched.

### Device management
Profile's "My Devices" lists device name, platform, current-device flag, last
seen, installed-app count, and a `deviceActivity` badge (Active / Last seen /
Offline) that never claims a device is online from `last_seen_at` alone. Revoke
is scoped and does not remote-uninstall.

### Offline / login transitions
- Current native detection + opening installed apps works offline; catalog is
  cached; sync is best-effort (queued/retried on connectivity).
- On account change, AuthContext dispatches `rx-auth-change`; AppContext /
  DeviceContext re-read per-user keys and clear account data. The persistent
  device id is unchanged (deviceIdentity), so login/logout never registers a new
  device.

### Accessibility
Buttons carry `aria-label`/`role="status"` and progress communicates percent.
State indicators are not color-only (text labels + icons for busy/alert).

### Tests
`src/native/installUi.test.ts` (11 tests) covers GET / OPEN / UPDATE, downloading
percent, verifying/checking labels, installing ≠ open, retry on all failures,
updating wording, accessible statuses, and that current-device detection decides
OPEN (never other-device data).
