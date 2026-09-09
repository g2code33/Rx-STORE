/**
 * RX Store — normalized installed-application detection model.
 *
 * This module is the single source of truth for how RX Store classifies a
 * known application against the OS it is running on. It is intentionally PURE
 * (no Capacitor / Electron / browser access) so it can be unit-tested and so
 * the web build degrades safely.
 *
 * The backend/store application metadata (slug + the five native identity
 * fields) is the source of truth for *identifying* an application. The native
 * clients (Electron desktop + Android Capacitor + Tauri) report whether that
 * identity is installed and, when possible, its installed version. This module
 * turns that into a predictable, normalized UI state.
 */

/** OSes the native RX Store clients can detect against. */
export type DetectedPlatform = 'windows' | 'linux' | 'android';

/**
 * Normalized result for ONE known application, independent of the OS that
 * produced it. `appId` is the store's stable identity (the app slug) so the
 * frontend never has to know which native field was used to match it.
 */
export interface InstalledApp {
  appId: string;
  platform: DetectedPlatform;
  installed: boolean;
  /** Installed version reported by the OS (best-effort; may be undefined). */
  version?: string;
  /** A trusted launch target discovered on the local machine (or undefined). */
  executable?: string;
  /** Windows registry UninstallString (registered uninstaller), if any. */
  uninstallString?: string;
  /** Windows registry QuietUninstallString (silent uninstaller), if any. */
  quietUninstallString?: string;
  /** Linux package identifier (dpkg/Flatpak) used to invoke the uninstaller. */
  packageName?: string;
  /** Linux AppImage path positively owned by RX Store (safe to remove). */
  appImagePath?: string;
  /** Where the result came from: registry / executable / package / package-manager / desktop. */
  source?: string;
  /** Epoch ms when the detection ran — used for short-term caching. */
  detectedAt: number;
}

/**
 * Normalized state the UI consumes. Maps directly to the button copy:
 *
 *   NOT_INSTALLED        -> Get
 *   INSTALLED_CURRENT    -> Open
 *   UPDATE_AVAILABLE     -> Update
 *   DETECTION_UNAVAILABLE-> Get
 */
export type DetectionState =
  | 'NOT_INSTALLED'
  | 'INSTALLED_CURRENT'
  | 'UPDATE_AVAILABLE'
  | 'DETECTION_UNAVAILABLE';

/** Parse a version string into a comparable numeric array. */
export function parseVersion(version?: string | null): number[] {
  const v = String(version || '')
    .trim()
    .replace(/^v/i, '');
  if (!v) return [];
  return v
    .split(/[.+\-_]/)
    .map((seg) => {
      const m = seg.match(/\d+/);
      return m ? parseInt(m[0] as string, 10) : 0;
    })
    .filter((_n, i, arr) => i < arr.length);
}

/**
 * Compare two versions numerically, segment by segment.
 *
 * Returns:
 *   -1  when a < b
 *    0  when a == b (or either is missing/unparseable)
 *   +1  when a > b
 *
 * Missing/invalid versions are treated as "0" so they never crash and never
 * falsely produce an update. Examples:
 *   1.0.0  < 1.0.1  -> -1
 *   1.0.9  < 1.0.10 -> -1   (correctly numeric, not lexicographic)
 *   1.1.0  > 1.0.25 -> +1
 *   2.0.0  > 1.9.99 -> +1
 */
export function compareVersions(a?: string | null, b?: string | null): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.length === 0 && pb.length === 0) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Classify a detected installation against the store's current version.
 *
 * `storeVersion` is the current_version published by RX Store. `installed
 * ` comes from the OS. `installedVersion` may be undefined when the OS could
 * not read it.
 *
 * Rules (from the spec):
 *  - not installed        -> NOT_INSTALLED
 *  - installed, version unknown/invalid -> INSTALLED_CURRENT (we cannot prove
 *    it is older, so we must not offer an update; Open)
 *  - store == installed   -> INSTALLED_CURRENT (Open)
 *  - store < installed    -> INSTALLED_CURRENT (never auto-downgrade)
 *  - store > installed    -> UPDATE_AVAILABLE (Update)
 */
export function detectionState(
  storeVersion?: string | null,
  installed?: boolean | null,
  installedVersion?: string | null,
): DetectionState {
  if (!installed) return 'NOT_INSTALLED';
  if (installedVersion === undefined || installedVersion === null || String(installedVersion).trim() === '') {
    return 'INSTALLED_CURRENT';
  }
  const cmp = compareVersions(storeVersion, installedVersion);
  // store <= installed -> current/open ; store > installed -> update
  return cmp > 0 ? 'UPDATE_AVAILABLE' : 'INSTALLED_CURRENT';
}

/** The button/action label the UI should render for a normalized state. */
export function detectionAction(state: DetectionState): 'Get' | 'Open' | 'Update' {
  switch (state) {
    case 'INSTALLED_CURRENT':
      return 'Open';
    case 'UPDATE_AVAILABLE':
      return 'Update';
    case 'NOT_INSTALLED':
    case 'DETECTION_UNAVAILABLE':
    default:
      return 'Get';
  }
}

/**
 * Normalize a raw native detection payload (Electron / Android) into the
 * shared model. `storeVersion` drives the resolved state.
 */
export function normalizeInstalledApp(
  appId: string,
  platform: DetectedPlatform,
  raw: {
    installed?: boolean; version?: string; executable?: string; launchTarget?: string;
    uninstallString?: string; quietUninstallString?: string; packageName?: string; appImagePath?: string;
    source?: string;
  },
  storeVersion?: string,
): InstalledApp {
  const installed = !!raw.installed;
  const executable = raw.launchTarget || raw.executable;
  return {
    appId,
    platform,
    installed,
    version: raw.version,
    executable,
    uninstallString: raw.uninstallString,
    quietUninstallString: raw.quietUninstallString,
    packageName: raw.packageName,
    appImagePath: raw.appImagePath,
    source: raw.source,
    detectedAt: Date.now(),
  };
}

/** Resolve the normalized UI state for a normalized detection result. */
export function stateForDetection(app: InstalledApp, storeVersion?: string): DetectionState {
  if (!app.installed) return 'NOT_INSTALLED';
  return detectionState(storeVersion, true, app.version);
}

// ---------------------------------------------------------------------------
// Rich installation-state model (account/multi-device aware).
//
// The local device's native detection is authoritative for the *current*
// device. The cloud (app_installations) is LAST-KNOWN info for *other* devices
// and must never flip the current device to OPEN. This module encodes that rule
// in a pure, unit-tested function.
// ---------------------------------------------------------------------------

/** Rich, non-boolean installation state for an application on the current device. */
export type InstallState =
  | 'NOT_INSTALLED'
  | 'INSTALLED'
  | 'UPDATE_AVAILABLE'
  | 'INSTALLING'
  | 'UPDATING'
  | 'UNINSTALLING'
  | 'INSTALL_FAILED'
  | 'UPDATE_FAILED'
  | 'UNINSTALL_FAILED'
  | 'DETECTION_UNAVAILABLE';

/** A transient/terminal operation in progress on the current device. */
export type InstallOperation =
  | 'installing'
  | 'updating'
  | 'uninstalling'
  | 'install_failed'
  | 'update_failed'
  | 'uninstall_failed'
  | null;

/** A single installation record reported by the cloud (any device). */
export interface DeviceInstallation {
  deviceId: string;
  appSlug?: string;
  status: string;
  installedVersion?: string;
}

/** Map the base DetectionState to the corresponding rich InstallState. */
export function mapDetectionToInstall(state: DetectionState): InstallState {
  switch (state) {
    case 'INSTALLED_CURRENT': return 'INSTALLED';
    case 'UPDATE_AVAILABLE': return 'UPDATE_AVAILABLE';
    case 'DETECTION_UNAVAILABLE': return 'DETECTION_UNAVAILABLE';
    case 'NOT_INSTALLED':
    default: return 'NOT_INSTALLED';
  }
}

/**
 * Decide the current device's install state from real local detection.
 *
 * `local` is the current device's native detection result (authoritative).
 * `storeVersion` is the published version. `operation` is the transient
 * install/update/uninstall progress (overrides the base state when set).
 */
export function currentDeviceInstallState(
  local: InstalledApp | null,
  storeVersion?: string,
  operation?: InstallOperation,
): InstallState {
  // A transient operation in progress wins over the detected base state.
  if (operation === 'installing') return 'INSTALLING';
  if (operation === 'updating') return 'UPDATING';
  if (operation === 'uninstalling') return 'UNINSTALLING';
  if (operation === 'install_failed') return 'INSTALL_FAILED';
  if (operation === 'update_failed') return 'UPDATE_FAILED';
  if (operation === 'uninstall_failed') return 'UNINSTALL_FAILED';

  if (!local) return 'DETECTION_UNAVAILABLE'; // web/PWA — cannot inspect the OS
  if (!local.installed) return 'NOT_INSTALLED';
  const base = detectionState(storeVersion, true, local.version);
  return mapDetectionToInstall(base);
}

/**
 * Count how many OTHER devices (excluding `currentDeviceId`) have this app
 * installed or with an update available, per the cloud's last-known state.
 * Used only to render "Installed on N other devices" — never to flip the
 * current device to OPEN.
 */
export function otherDeviceInstallCount(
  installations: DeviceInstallation[],
  currentDeviceId?: string,
): number {
  if (!installations?.length) return 0;
  const active = new Set(['installed', 'update_available']);
  return installations.filter((i) => {
    if (currentDeviceId && i.deviceId === currentDeviceId) return false;
    return active.has(String(i.status || '').toLowerCase());
  }).length;
}

/**
 * The combined, current-device-authoritative view.
 *
 * `state` is what the CURRENT device should show (GET/OPEN/UPDATE + transient).
 * `otherDevices` is the number of OTHER devices with a matching installation,
 * purely informational.
 */
export function resolveDeviceView(input: {
  local: InstalledApp | null;
  storeVersion?: string;
  operation?: InstallOperation;
  otherInstallations?: DeviceInstallation[];
  currentDeviceId?: string;
}): { state: InstallState; otherDevices: number } {
  const state = currentDeviceInstallState(input.local, input.storeVersion, input.operation);
  const otherDevices = otherDeviceInstallCount(input.otherInstallations || [], input.currentDeviceId);
  return { state, otherDevices };
}

/** Map a rich InstallState to the backend's lowercase status value. */
export function installStatusForReport(state: InstallState): string {
  switch (state) {
    case 'INSTALLED': return 'installed';
    case 'NOT_INSTALLED': return 'not_installed';
    case 'UPDATE_AVAILABLE': return 'update_available';
    case 'INSTALLING': return 'installing';
    case 'UPDATING': return 'updating';
    case 'UNINSTALLING': return 'uninstalling';
    case 'INSTALL_FAILED': return 'install_failed';
    case 'UPDATE_FAILED': return 'update_failed';
    case 'UNINSTALL_FAILED': return 'uninstall_failed';
    case 'DETECTION_UNAVAILABLE':
    default: return 'unknown';
  }
}
