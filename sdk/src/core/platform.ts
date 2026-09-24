/**
 * Platform detection for the SDK.
 *
 * RULES (Phase 4):
 *   - The developer MAY pass an explicit `platform` / `architecture` — that
 *     always wins, because automatic browser detection must NEVER be treated
 *     as authoritative for package identity.
 *   - Automatic detection distinguishes host RUNTIMES (web / PWA / Android /
 *     Windows / Linux) from *safe* signals only. An Android package identity
 *     is NEVER inferred from a browser user-agent: a desktop browser merely
 *     REPORTING "Android" in its UA (or a spoofed UA) must not make the SDK
 *     claim it runs on Android. We only trust hard environment evidence:
 *     the Android WebView bridge (window.Capacitor with native platform) or
 *     an Electron main-process bridge (window.rxDesktop) — i.e. signals that
 *     cannot come from a normal web page.
 */

import type { SdkPlatform } from './types';

export interface DetectedPlatform {
  platform: SdkPlatform;
  /** Architecture when it can be read SAFELY (navigator.cpuClass-free). */
  architecture: string | null;
  /** How the answer was determined — 'override' | 'bridge' | 'heuristic'. */
  source: 'override' | 'bridge' | 'heuristic';
}

interface PlatformEnv {
  userAgent?: string;
  /** A native bridge object, when the SDK runs inside a native shell. */
  capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } | null;
  /** An Electron bridge object, when the SDK runs inside the RX Store desktop shell or similar. */
  desktopBridge?: unknown;
  /** Standalone display mode hint (PWA), when the host can report it. */
  standalone?: boolean;
  /** WebGL renderer string (used only for a soft arch hint, never identity). */
  webglRenderer?: string | null;
}

function envFromGlobals(): PlatformEnv {
  const g: any = (typeof globalThis !== 'undefined' ? globalThis : {}) as any;
  return {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    capacitor: g.Capacitor ?? null,
    desktopBridge: g.rxDesktop ?? null,
    webglRenderer: null,
  };
}

/**
 * Resolve the effective platform. Explicit override wins; otherwise hard
 * bridge evidence; otherwise conservative web heuristics.
 */
export function detectPlatform(
  override?: SdkPlatform | null,
  env: PlatformEnv = envFromGlobals(),
): DetectedPlatform {
  if (override) {
    const valid: SdkPlatform[] = ['web', 'pwa', 'android', 'windows', 'linux'];
    if (!valid.includes(override)) {
      throw new Error(`Unsupported platform override: ${String(override)}`);
    }
    return { platform: override, architecture: null, source: 'override' };
  }

  // Hard evidence: a Capacitor NATIVE bridge (not the web polyfill —
  // isNativePlatform() is false in a plain browser).
  try {
    if (env.capacitor?.isNativePlatform?.()) {
      const p = String(env.capacitor.getPlatform?.() || '');
      if (p === 'android') return { platform: 'android', architecture: null, source: 'bridge' };
    }
  } catch { /* bridge unavailable */ }

  // Hard evidence: an Electron-style desktop bridge exposed by the host shell.
  if (env.desktopBridge) {
    const ua = String(env.userAgent || '');
    if (/Windows/i.test(ua)) return { platform: 'windows', architecture: null, source: 'bridge' };
    if (/Linux/i.test(ua) && !/Android/i.test(ua)) return { platform: 'linux', architecture: null, source: 'bridge' };
  }

  // Conservative heuristics for a plain web context. NOTE: "Android" in a UA
  // does NOT make this an Android host app — a phone browser is still `web`.
  const ua = String(env.userAgent || '');
  const standalone =
    env.standalone === true ||
    (typeof matchMedia !== 'undefined' &&
      (() => { try { return matchMedia('(display-mode: standalone)').matches; } catch { return false; } })());
  const iosPwa = standalone && (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in (typeof document !== 'undefined' ? document : {})));
  const platform: SdkPlatform = standalone || iosPwa ? 'pwa' : 'web';
  return { platform, architecture: archFromUa(ua), source: 'heuristic' };
}

/**
 * A soft architecture HINT from the UA (used only as a default; package
 * identity never depends on it). x86-64 Windows/Linux report 'x64', ARM64
 * devices 'arm64'; anything ambiguous is null — the developer override or the
 * server is then authoritative.
 */
export function archFromUa(userAgent: string): string | null {
  const ua = String(userAgent || '');
  if (/arm64|aarch64/i.test(ua) && !/x86_64|x64/i.test(ua)) return 'arm64';
  if (/x86_64|WOW64|x64/i.test(ua)) return 'x64';
  // Android armv7/older — 'arm' is common enough to hint, still overridable.
  if (/armv[5-8]/i.test(ua)) return 'arm';
  return null;
}
