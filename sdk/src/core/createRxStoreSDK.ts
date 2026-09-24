/**
 * createRxStoreSDK — the RX Store Developer SDK core.
 *
 * Architecture position (one canonical system):
 *
 *   HOST APP → this SDK → RX Store update API (GET /updates/check)
 *           → update metadata → host renders its own UI
 *           → openUpdateInRxStore() → rxstore://app/{slug} (or HTTPS fallback)
 *           → RX Store app page → RX Store's OWN install/update pipeline.
 *
 * The SDK NEVER downloads, checksum-verifies, entitlement-checks or installs
 * an application update. Those stay inside RX Store. It contains no secrets —
 * the update check is the same unauthenticated public API any browser uses.
 * All update metadata (latestVersion, mandatory, minimum supported version,
 * checksum, destinations) is validated and treated as SERVER-AUTHORITATIVE;
 * client-supplied values are never trusted for security decisions.
 */

import { detectPlatform } from './platform.ts';
import { isValidSemver } from './semver.ts';
import type {
  RxStoreSDK, RxStoreSDKConfig, SdkPlatform, UpdateCheckResult, UpdateInfo,
} from './types.ts';

export const DEFAULT_API_URL = 'https://rx-store-api.calcitoninpay.workers.dev/v1';
export const DEFAULT_WEB_URL = 'https://rx-store-web.pages.dev';

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;      // brief cache of a good response
const DEFAULT_BACKOFF_INITIAL_MS = 30 * 1000;    // 30s after a failure…
const DEFAULT_BACKOFF_FACTOR = 2;                // …doubling…
const DEFAULT_BACKOFF_MAX_MS = 10 * 60 * 1000;   // …up to 10 minutes
const DEFAULT_FALLBACK_DELAY_MS = 2000;          // deep-link → HTTPS fallback window
const VALID_PLATFORMS: SdkPlatform[] = ['web', 'pwa', 'android', 'windows', 'linux'];

/** Strict shape a server response must satisfy before the SDK uses it. */
function validateUpdatePayload(data: any, expectedSlug: string): UpdateInfo | null {
  if (!data || typeof data !== 'object') return null;
  const updateAvailable = data.updateAvailable;
  if (typeof updateAvailable !== 'boolean') return null;

  const slug = typeof data.slug === 'string' ? data.slug : expectedSlug;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return null;

  let latestVersion = typeof data.latestVersion === 'string' ? data.latestVersion : '';
  if (updateAvailable) {
    // Fail closed: an "update" without a valid SemVer target is unusable.
    if (!isValidSemver(latestVersion)) return null;
  }

  const mandatory = data.mandatory === true; // anything else means "not mandatory"
  const minimumSupportedVersion =
    (typeof data.minimumSupportedVersion === 'string' && isValidSemver(data.minimumSupportedVersion))
      ? data.minimumSupportedVersion
      : null;

  // Destinations: FAIL CLOSED — a server-provided storeUrl/deepLink that is
  // present but malformed (javascript:, file:, wrong shape…) invalidates the
  // whole response. When absent, the SDK builds them from the validated slug.
  if (data.storeUrl !== undefined && data.storeUrl !== null && !/^https:\/\/[^\s"']*\/app\/[a-z0-9-]+$/i.test(String(data.storeUrl))) return null;
  if (data.deepLink !== undefined && data.deepLink !== null && !/^rxstore:\/\/app\/[a-z0-9][a-z0-9-]{0,63}$/i.test(String(data.deepLink))) return null;
  const storeUrl = typeof data.storeUrl === 'string' ? data.storeUrl : '';
  const deepLink = typeof data.deepLink === 'string' ? data.deepLink.toLowerCase() : null;

  const notes = Array.isArray(data.releaseNotes)
    ? data.releaseNotes.filter((n: unknown): n is string => typeof n === 'string' && n.length > 0).slice(0, 50)
    : [];

  return {
    appId: typeof data.appId === 'string' && data.appId.length <= 64 ? data.appId : null,
    appName: typeof data.app === 'string' && data.app.length <= 120 ? data.app : null,
    slug,
    currentVersion: String(data.currentVersion ?? ''),
    latestVersion,
    platform: typeof data.platform === 'string' ? data.platform : null,
    architecture: typeof data.architecture === 'string' ? data.architecture : null,
    channel: typeof data.channel === 'string' && data.channel.length <= 20 ? data.channel : 'stable',
    updateAvailable,
    mandatory,
    minimumSupportedVersion,
    updateRequired: data.updateRequired === true,
    releaseNotes: notes,
    fileSize: typeof data.fileSize === 'number' && Number.isFinite(data.fileSize) && data.fileSize >= 0 ? data.fileSize : null,
    checksum:
      typeof data.checksum === 'string' && /^(sha256:)?[0-9a-f]{64}$/i.test(data.checksum)
        ? (data.checksum.startsWith('sha256:') ? data.checksum.toLowerCase() : `sha256:${data.checksum.toLowerCase()}`)
        : null,
    storeUrl,
    deepLink,
    checkedAt: typeof data.checkedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(data.checkedAt) ? data.checkedAt : new Date().toISOString(),
  };
}

/** Factory — see sdk/README.md for the full integration guide. */
export function createRxStoreSDK(rawConfig: RxStoreSDKConfig): RxStoreSDK {
  const cfgError = validateConfig(rawConfig);
  if (cfgError) {
    // Config errors are programming errors: surface them immediately instead
    // of silently producing a dead SDK.
    throw new Error(`@rx-store/sdk: ${cfgError}`);
  }

  const detected = detectPlatform(rawConfig.platform ?? null);
  const platform: SdkPlatform = detected.platform;
  const architecture = rawConfig.architecture ?? detected.architecture ?? null;

  const apiUrl = String(rawConfig.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const webUrl = String(rawConfig.webUrl || DEFAULT_WEB_URL).replace(/\/+$/, '');
  const channel = rawConfig.channel || 'stable';
  const cacheTtlMs = Math.max(0, rawConfig.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  const backoffInitial = Math.max(0, rawConfig.backoff?.initialMs ?? DEFAULT_BACKOFF_INITIAL_MS);
  const backoffMax = Math.max(backoffInitial, rawConfig.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS);
  const backoffFactor = Math.max(1, rawConfig.backoff?.factor ?? DEFAULT_BACKOFF_FACTOR);
  const fallbackDelayMs = Math.max(0, rawConfig.fallbackDelayMs ?? DEFAULT_FALLBACK_DELAY_MS);
  const doFetch: typeof fetch = rawConfig.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null as any);

  const frozenConfig: RxStoreSDK['config'] = Object.freeze({
    ...rawConfig,
    appId: rawConfig.appId,
    currentVersion: rawConfig.currentVersion,
    platform,
    apiUrl,
    webUrl,
    channel,
    architecture,
  }) as RxStoreSDK['config'];

  // ---- state -------------------------------------------------------------
  let lastUpdate: UpdateInfo | null = null;
  let lastResult: UpdateCheckResult | null = null;
  let lastSuccessAt = 0;            // cache clock
  let nextAllowedCheckAt = 0;       // backoff clock
  let consecutiveFailures = 0;
  let inFlight: Promise<UpdateCheckResult> | null = null;
  let destroyed = false;
  let initialized = false;
  let visibilityHandler: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const openLink = rawConfig.openLink
    ?? ((url: string) => { try { (globalThis as any).open?.(url, '_blank'); } catch { /* host decides */ } });
  const isVisible = rawConfig.isVisible ?? (() => {
    try { return typeof document === 'undefined' ? true : document.visibilityState === 'visible'; } catch { return true; }
  });

  function buildStoreUrl(): string | null {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(rawConfig.appId)) return null;
    return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(webUrl) ? `${webUrl}/app/${encodeURIComponent(rawConfig.appId)}` : null;
  }
  function buildDeepLink(): string | null {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(rawConfig.appId)) return null;
    return `rxstore://app/${encodeURIComponent(rawConfig.appId)}`;
  }

  async function performCheck(): Promise<UpdateCheckResult> {
    const params = new URLSearchParams({
      app: rawConfig.appId,
      currentVersion: rawConfig.currentVersion,
      platform,
    });
    if (architecture) params.set('arch', architecture);
    if (channel) params.set('channel', channel);
    const endpoint = `${apiUrl}/updates/check?${params.toString()}`;

    let res: Response;
    try {
      res = await doFetch(endpoint, { method: 'GET', headers: { Accept: 'application/json' } });
    } catch (e: any) {
      return networkFailure(String(e?.message || 'network error'));
    }

    if (res.status === 404) return failure('APP_NOT_FOUND', 'Application not found on RX Store.');
    if (res.status === 429) return failure('RATE_LIMITED', 'Rate limited — retry later.');
    if (res.status >= 500) return failure('SERVER_ERROR', `RX Store responded ${res.status}.`);

    const json: any = await res.json().catch(() => null);
    const data = json?.data ?? json;
    const info = validateUpdatePayload(data, rawConfig.appId);
    if (!res.ok || !json || !info) {
      // Fail CLOSED for unusable/unsafe metadata…
      return failure('INVALID_RESPONSE', 'The update response failed validation.');
    }

    // Success: reset backoff, populate cache.
    consecutiveFailures = 0;
    nextAllowedCheckAt = 0;
    lastSuccessAt = Date.now();
    lastUpdate = info;
    const result: UpdateCheckResult = {
      status: info.updateAvailable ? (info.mandatory ? 'MANDATORY_UPDATE' : 'UPDATE_AVAILABLE') : 'NO_UPDATE',
      update: info,
      checkedAt: info.checkedAt,
    };
    lastResult = result;
    return result;
  }

  function networkFailure(message: string): UpdateCheckResult {
    return recordFailure('NETWORK_ERROR', message);
  }
  function failure(status: any, message: string): UpdateCheckResult {
    return recordFailure(status, message);
  }
  function recordFailure(status: any, message: string): UpdateCheckResult {
    // Fail OPEN for ordinary outages: report, back off, never crash the host.
    consecutiveFailures++;
    const delay = Math.min(backoffMax, backoffInitial * Math.pow(backoffFactor, consecutiveFailures - 1));
    nextAllowedCheckAt = Date.now() + delay;
    const result: UpdateCheckResult = { status, error: message, backoffActive: true };
    lastResult = result;
    return result;
  }

  async function checkForUpdate(opts?: { force?: boolean }): Promise<UpdateCheckResult> {
    if (destroyed) return { status: 'NETWORK_ERROR', error: 'SDK destroyed' };
    // Single-flight: concurrent callers share ONE request (never replay a check).
    if (inFlight) return inFlight;
    // Brief cache of a successful response.
    if (!opts?.force && lastUpdate && cacheTtlMs > 0 && Date.now() - lastSuccessAt < cacheTtlMs) {
      return { ...(lastResult as UpdateCheckResult), cached: true };
    }
    // Exponential backoff after failures (a manual force bypasses it).
    if (!opts?.force && nextAllowedCheckAt > Date.now()) {
      return { ...(lastResult as UpdateCheckResult), backoffActive: true };
    }
    inFlight = performCheck().finally(() => { inFlight = null; });
    return inFlight;
  }

  function openUpdateInRxStore(): void {
    if (destroyed) return;
    const deepLink = lastUpdate?.deepLink || buildDeepLink();
    const storeUrl = safeServerOrBuiltStoreUrl();
    if (!deepLink && !storeUrl) return;

    // On plain web hosts a custom-scheme navigation is unreliable — go
    // straight to the HTTPS store page (which itself offers "Get RX Store").
    if (platform === 'web') {
      if (storeUrl) openLink(storeUrl);
      return;
    }

    // Native-capable host: attempt the deep link first…
    if (deepLink) openLink(deepLink);
    // …then, if the host app is still visible after the window (RX Store not
    // installed / scheme unhandled), fall back to the HTTPS page.
    if (storeUrl) {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        if (!destroyed && isVisible()) openLink(storeUrl);
      }, fallbackDelayMs);
    }
  }

  function safeServerOrBuiltStoreUrl(): string | null {
    const server = lastUpdate?.storeUrl;
    if (server && /^https:\/\/[^\s"']*\/app\/[a-z0-9-]+$/i.test(server)) return server;
    return buildStoreUrl();
  }

  async function initialize(): Promise<void> {
    if (initialized || destroyed) return;
    initialized = true;

    if (rawConfig.checkOnVisible !== false && typeof document !== 'undefined' && !visibilityHandler) {
      visibilityHandler = () => {
        try {
          if (document.visibilityState === 'visible') void checkForUpdate();
        } catch { /* never break the host */ }
      };
      try { document.addEventListener('visibilitychange', visibilityHandler); } catch { /* SSR */ }
    }
    if (rawConfig.pollIntervalMs && rawConfig.pollIntervalMs >= 60_000 && !pollTimer) {
      // Opt-in periodic check, minimum one minute — no aggressive polling.
      pollTimer = setInterval(() => { void checkForUpdate(); }, rawConfig.pollIntervalMs);
    }
    if (rawConfig.checkOnStart !== false) {
      // Never block host startup: fire-and-forget.
      void checkForUpdate().catch(() => undefined);
    }
  }

  function destroy(): void {
    destroyed = true;
    if (visibilityHandler) {
      try { document.removeEventListener('visibilitychange', visibilityHandler); } catch { /* ignore */ }
      visibilityHandler = null;
    }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    inFlight = null;
  }

  return {
    initialize,
    checkForUpdate,
    getUpdateInfo: () => (lastUpdate ? { ...lastUpdate } : null),
    hasUpdate: () => !!lastUpdate?.updateAvailable,
    isMandatoryUpdate: () => !!lastUpdate?.mandatory,
    openUpdateInRxStore,
    buildStoreUrl,
    buildDeepLink,
    destroy,
    get config() { return frozenConfig; },
  };
}

/** Config validation — appId + currentVersion are required and must be sane. */
export function validateConfig(cfg: RxStoreSDKConfig): string | null {
  if (!cfg || typeof cfg !== 'object') return 'config is required';
  if (typeof cfg.appId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(cfg.appId)) {
    return 'appId is required (the RX Store application slug, e.g. "pharmatrack")';
  }
  if (typeof cfg.currentVersion !== 'string' || !isValidSemver(cfg.currentVersion)) {
    return `currentVersion must be a valid SemVer string (got ${JSON.stringify(cfg.currentVersion)})`;
  }
  if (cfg.platform && !VALID_PLATFORMS.includes(cfg.platform)) {
    return `platform must be one of ${VALID_PLATFORMS.join(', ')}`;
  }
  if (cfg.pollIntervalMs != null && cfg.pollIntervalMs < 60_000) {
    return 'pollIntervalMs must be at least 60000 (no aggressive polling)';
  }
  return null;
}
