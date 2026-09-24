/**
 * @rx-store/sdk — public types.
 *
 * The SDK lets a host application check for RX Store updates and hand the
 * user to RX Store to install them. It NEVER downloads, verifies or installs
 * anything itself — that stays inside RX Store (download → SHA-256 → package
 * security → installer → native detection → install record).
 */

/** Host platforms the SDK can report. Detected or explicitly overridden. */
export type SdkPlatform = 'web' | 'pwa' | 'android' | 'windows' | 'linux';

/**
 * Terminal states of an update check. Network-level problems are reported as
 * results (never thrown) so a host application can `try/catch` nothing and
 * still keep running.
 */
export type UpdateCheckStatus =
  | 'UPDATE_AVAILABLE'      // a newer version exists
  | 'MANDATORY_UPDATE'      // newer version AND the server marked it mandatory
  | 'NO_UPDATE'             // current version is the latest
  | 'NETWORK_ERROR'         // offline / DNS / timeout — safe to retry later
  | 'INVALID_RESPONSE'      // server reply failed validation (fail closed)
  | 'APP_NOT_FOUND'         // unknown appId (404)
  | 'UNSUPPORTED_PLATFORM'  // platform not supported / not determinable
  | 'RATE_LIMITED'          // HTTP 429 — back off
  | 'SERVER_ERROR';         // HTTP 5xx — safe to retry later

/** Validated update metadata — every value is SERVER-AUTHORITATIVE. */
export interface UpdateInfo {
  /** Marketplace application id (server-issued). */
  appId: string | null;
  /** Display name of the application. */
  appName: string | null;
  /** Marketplace slug (also the deep-link target). */
  slug: string;
  /** The version the host app reported. */
  currentVersion: string;
  /** The latest published version on RX Store. */
  latestVersion: string;
  platform: string | null;
  architecture: string | null;
  channel: string;
  updateAvailable: boolean;
  /** The server says updating is required (mandatory release / below minimum). */
  mandatory: boolean;
  /** Oldest version still supported by this release (null = none set). */
  minimumSupportedVersion: string | null;
  /** True when currentVersion < minimumSupportedVersion. */
  updateRequired: boolean;
  releaseNotes: string[];
  fileSize: number | null;
  /** sha256:<hex> — informational; RX Store performs the real verification. */
  checksum: string | null;
  /** HTTPS store page (always works, even without RX Store installed). */
  storeUrl: string;
  /** rxstore://app/{slug} deep link. */
  deepLink: string | null;
  checkedAt: string;
}

/** Result of checkForUpdate(). */
export interface UpdateCheckResult {
  status: UpdateCheckStatus;
  /** Present for UPDATE_AVAILABLE / MANDATORY_UPDATE / NO_UPDATE. */
  update?: UpdateInfo;
  /** Human-readable detail for error statuses. */
  error?: string;
  /** True when this result came from the short-lived cache. */
  cached?: boolean;
  /** True when a backoff window (after failures) is still active. */
  backoffActive?: boolean;
  checkedAt?: string;
}

/** SDK configuration (see createRxStoreSDK). */
export interface RxStoreSDKConfig {
  /** REQUIRED — the application's RX Store slug (public identifier). */
  appId: string;
  /** REQUIRED — the host application's own version (SemVer). */
  currentVersion: string;
  /** RX Store API base. Default: the production Worker (with /v1). */
  apiUrl?: string;
  /** RX Store web origin (HTTPS fallback links). */
  webUrl?: string;
  /** Explicit platform override — never trust UA sniffing for identity. */
  platform?: SdkPlatform;
  /** Explicit architecture override (e.g. 'arm64', 'x64'). */
  architecture?: string;
  /** Release channel. Default 'stable'. */
  channel?: string;
  /** fetch implementation (tests / custom runtimes). */
  fetchImpl?: typeof fetch;
  /** Navigation hook (tests / custom open behaviour). Default window.open. */
  openLink?: (url: string) => void;
  /** Check once during initialize()? Default true (non-blocking). */
  checkOnStart?: boolean;
  /** Re-check when the host app becomes visible/active? Default true. */
  checkOnVisible?: boolean;
  /** Periodic re-check interval. Default 0 (OFF — no aggressive polling). */
  pollIntervalMs?: number;
  /** How long a successful check is cached. Default 5 minutes. */
  cacheTtlMs?: number;
  /** Backoff after failed checks. Defaults: 30s initial, ×2, 10 min max. */
  backoff?: { initialMs?: number; maxMs?: number; factor?: number };
  /** How long to wait before the HTTPS fallback after a deep-link attempt. */
  fallbackDelayMs?: number;
  /** Is the host document visible? Injectable for tests. */
  isVisible?: () => boolean;
}

/** The SDK instance returned by createRxStoreSDK(). */
export interface RxStoreSDK {
  /** Validate config (and run the optional startup check). Safe to await. */
  initialize(): Promise<void>;
  /** Check RX Store for an update. Never throws. */
  checkForUpdate(opts?: { force?: boolean }): Promise<UpdateCheckResult>;
  /** Last validated update info (null before the first successful check). */
  getUpdateInfo(): UpdateInfo | null;
  /** True when a newer version is available (mandatory included). */
  hasUpdate(): boolean;
  /** True when the server marked the available update as mandatory. */
  isMandatoryUpdate(): boolean;
  /** Open RX Store on this app's page (deep link, HTTPS fallback). */
  openUpdateInRxStore(): void;
  /** HTTPS store page URL. */
  buildStoreUrl(): string | null;
  /** rxstore://app/{slug} URL. */
  buildDeepLink(): string | null;
  /** Release resources (timers, listeners). Call on host app shutdown. */
  destroy(): void;
  /** The effective config (frozen copy, secrets-free). */
  readonly config: Readonly<Required<Pick<RxStoreSDKConfig, 'appId' | 'currentVersion' | 'platform'>> & RxStoreSDKConfig>;
}
