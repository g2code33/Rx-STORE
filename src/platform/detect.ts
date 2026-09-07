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
  /** Where the result came from: registry / executable / package / package-manager. */
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
  raw: { installed?: boolean; version?: string; executable?: string; launchTarget?: string; source?: string },
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
    source: raw.source,
    detectedAt: Date.now(),
  };
}

/** Resolve the normalized UI state for a normalized detection result. */
export function stateForDetection(app: InstalledApp, storeVersion?: string): DetectionState {
  if (!app.installed) return 'NOT_INSTALLED';
  return detectionState(storeVersion, true, app.version);
}
