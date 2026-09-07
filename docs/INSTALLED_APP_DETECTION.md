# RX Store — Installed-Application Detection

RX Store can tell whether one of its listed applications is already installed
on the device it is running on, and show the right action button:

| State                       | Button |
| --------------------------- | ------ |
| `NOT_INSTALLED`             | Get    |
| `INSTALLED_CURRENT`         | Open   |
| `UPDATE_AVAILABLE`          | Update |
| `DETECTION_UNAVAILABLE`     | Get    |

The store application metadata is the **source of truth for identity**: the app
slug plus five optional native identity fields. The native clients then ask the
OS whether that identity is present and, when possible, what version is
installed. This doc explains how that works and how to configure a new app.

---

## 1. The five native identity fields

Each application can carry up to five optional identifiers. All five are
optional — an app that has none of them still works (it is simply treated as
"not installed" and shows **Get**).

| Field                   | Backend column             | Meaning |
| ----------------------- | -------------------------- | ------- |
| `androidPackageId`      | `android_package_id`       | Stable Android package identifier, e.g. `com.example.app`. |
| `windowsUninstallKey`   | `windows_uninstall_key`    | Stable Windows uninstall-registry subkey (e.g. the app key name or `{GUID}`). |
| `windowsExecutable`     | `windows_executable`       | Windows executable name or absolute path used as an additional detection method. |
| `linuxPackageName`      | `linux_package_name`       | Linux package identifier (Debian/Ubuntu) used to detect installed packages. |
| `linuxExecutable`       | `linux_executable`         | Linux executable name used as a fallback detection method. |

> You only need to fill in the fields for platforms you actually ship. Do not
> invent a Windows registry key — use the one your installer writes.

---

## 2. Windows detection

Implemented in the Electron main process (`electron/main.ts`) and the Tauri
Rust client (`desktop/tauri/src-tauri/src/main.rs`).

1. **Registry.** If `windowsUninstallKey` is set, the client queries the three
   standard uninstall locations in order:
   - `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`
   - `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`
   - `HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`

   A fully-qualified `windowsUninstallKey` (e.g. one already containing
   `\CurrentVersion\Uninstall`) is used verbatim; a bare subkey name is tried
   under each root. When the subkey exists, the installed version is read from
   the registry `DisplayVersion` (falling back to `Version`), and the install
   location is remembered as a launch candidate. Both the 32-bit and 64-bit
   hive locations are searched, so no administrator privilege is required.

2. **Executable.** If `windowsExecutable` is set, the client resolves it:
   - an absolute path is checked for existence on disk;
   - a bare executable *name* is resolved via `where.exe` (PATH lookup).

   The resolved path becomes the launch target. If the registry did not yield a
   version, the executable's file-version metadata is read as a fallback.

3. **Launch.** `Open` launches the discovered executable via the OS directly
   (no shell). The path is only ever opened after it was positively detected and
   verified to exist.

---

## 3. Linux detection

Implemented in the Electron main process and the Tauri Rust client.

1. **Package.** If `linuxPackageName` is set, the client runs
   `dpkg-query -W -f=${Version} <package>` (argument-array exec, no shell).
   Exit code 0 means the package is installed; the output is the installed
   version. If `dpkg-query` is unavailable or the package is absent, this step
   silently fails and the client falls through.

2. **Executable.** If `linuxExecutable` is set, the client scans `PATH` for the
   executable and returns its absolute path. This works even when the package
   database is unavailable.

3. **Fallback result.** If neither identity is present or resolvable, the app is
   reported **not installed** — never guessed.

---

## 4. Android detection

Implemented in the Capacitor plugin
`android/app/src/main/java/com/calcitonin/rxstore/AppInstallerPlugin.java`
(`AppInstaller.isInstalled(packageId)`).

- Detection uses the **Android package ID** (`androidPackageId`) — never the
  display name.
- `PackageManager.getPackageInfo(packageId, 0)` returns the installed version
  (`versionName`) when the package exists.
- A missing/empty/invalid package ID or a package not found returns
  `installed = false` — no false positives.
- `AppInstaller.openInstalled(packageId)` launches the package's launch
  activity; if there is none it returns a clear native error.

---

## 5. Version comparison

Version comparison is centralized in
`src/platform/detect.ts` (`compareVersions`). It compares versions
segment-by-segment as numbers, so:

- `1.0.0` < `1.0.1`
- `1.0.9` < `1.0.10` (numeric, not lexicographic)
- `1.1.0` > `1.0.25`
- `2.0.0` > `1.9.99`

Rules for the state:

- installed version is **unknown / invalid** → treat as current → **Open**
  (we cannot prove it is older, so we never show **Update**).
- store version **==** installed version → **Open**.
- store version **<** installed version → **Open** (never auto-downgrade).
- store version **>** installed version → **Update**.

---

## 6. UI state mapping (`detectionState`)

The normalized model lives in `src/platform/detect.ts`:

```ts
type InstalledApp = {
  appId: string;         // the app slug (store identity)
  platform: 'windows' | 'linux' | 'android';
  installed: boolean;
  version?: string;
  executable?: string;
  source?: string;
};

type DetectionState =
  | 'NOT_INSTALLED'       // -> Get
  | 'INSTALLED_CURRENT'   // -> Open
  | 'UPDATE_AVAILABLE'    // -> Update
  | 'DETECTION_UNAVAILABLE' // -> Get
```

`src/platform/nativeDetection.ts` bridges to the native clients
(`window.rxDesktop.detectApp(...)` for desktop, `AppInstaller.isInstalled(...)`
for Android), normalizes the result, caches it for 60 seconds, and exposes
`useInstalledState(app)` for the UI. It also honors a manual refresh and
invalidates the cache after install / uninstall / update.

---

## 7. Configuring a new application

In **Admin → App Editor → Installed-app detection** fill in only the identifiers
for platforms you publish. Example for **CGPA Pilot**:

```
Android package ID:     com.cgpapilot.app
Linux package name:     cgpa-pilot
Linux executable:       cgpa-pilot
Windows uninstall key:  (use the exact uninstall key your installer writes)
Windows executable:     (use the exact executable name/path your installer writes)
```

Do **not** invent a Windows registry key. Once a real native build is
installed, RX Store will detect it and show **Open** (or **Update** when a newer
version is published). Installing/updating triggers a detection refresh so the
button changes from **Get → Install → Open** after the OS confirms.

---

## 8. Why the web/PWA cannot inspect installed apps

Browsers cannot read the Windows registry, the Linux package database, or the
Android package manager for arbitrary applications. The normal web/PWA frontend
therefore returns `DETECTION_UNAVAILABLE` and shows **Get**. Only the native
clients (Electron desktop and the Android Capacitor app) perform real OS-level
detection; the browser is never asked to inspect the OS and never sees a false
"Open"/"Update".

---

## 9. Security notes

- All OS commands are spawned with an **arguments array** (`execFile` /
  `Command::args`) — never a shell string — so app metadata (registry key,
  package name, executable name, path) cannot be interpreted by a shell.
- Executable **file-version** reads on Windows pass the path through an
  environment variable rather than interpolating it into a PowerShell command.
- `Open` only launches a target that was positively detected and verified to
  exist on disk; it never executes an arbitrary remote path verbatim.
- Detection only reads metadata (registry, package database, file metadata). It
  never executes the target application as part of detection.
