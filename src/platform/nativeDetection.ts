/**
 * RX Store — runtime installed-application detection orchestrator.
 *
 * Bridges the normalized model (detect.ts) to the actual native bridges:
 *  - Electron/desktop shell  -> window.rxDesktop.detectApp(...)
 *  - Android Capacitor shell -> AppInstaller.isInstalled(packageId)
 *  - Web/PWA                  -> nothing (browsers cannot inspect the OS)
 *
 * Detection results are cached briefly and invalidated on install / uninstall /
 * update / manual refresh so we don't hammer the OS in every render.
 */
import { useEffect, useState, useCallback } from 'react';
import type { App } from '../types';
import {
  DetectedPlatform,
  DetectionState,
  InstalledApp,
  normalizeInstalledApp,
  stateForDetection,
} from './detect';
import {
  androidIsInstalled,
  desktopDetect,
  desktopInvalidateDetect,
  isAndroidShell,
  isDesktopShell,
} from './nativeInstaller';

/** How long a detection result is considered fresh (ms). */
export const DETECTION_TTL_MS = 60_000;

interface CacheEntry {
  at: number;
  result: InstalledApp | null;
}

const cache = new Map<string, CacheEntry>();

/** True when the current runtime can perform real OS-level detection. */
export function isDetectionAvailable(): boolean {
  return isDesktopShell() || isAndroidShell();
}

/** Remove cached detections. Omit `appId` to clear every app. */
export function invalidateDetectionCache(appId?: string): void {
  if (appId) cache.delete(appId);
  else cache.clear();
}

/** Resolve the platform for the current native runtime, or null on web. */
function currentPlatform(): DetectedPlatform | null {
  if (isAndroidShell()) return 'android';
  if (isDesktopShell()) {
    // The Electron main process reports the OS; fall back to the renderer UA.
    const ua = (navigator.userAgent || '').toLowerCase();
    if (/windows/.test(ua)) return 'windows';
    if (/linux|x11/.test(ua)) return 'linux';
    return 'windows'; // desktop shell covers windows/linux primarily
  }
  return null;
}

/**
 * Detect whether `app` is installed for the current runtime. Returns the
 * normalized model, or `null` when detection is unavailable (web/PWA).
 *
 * Results are cached for `DETECTION_TTL_MS`. Call `invalidateDetectionCache`
 * after install / uninstall / update to force a fresh read.
 */
export async function detectInstalledApp(app: App): Promise<InstalledApp | null> {
  const platform = currentPlatform();
  if (!platform) return null; // web/PWA — browsers cannot inspect the OS

  const cached = cache.get(app.slug);
  if (cached && Date.now() - cached.at < DETECTION_TTL_MS) return cached.result;

  let result: InstalledApp;
  if (platform === 'android') {
    if (!app.androidPackageId) {
      result = normalizeInstalledApp(app.slug, 'android', { installed: false, source: 'unconfigured' });
    } else {
      try {
        const r = await androidIsInstalled(app.androidPackageId);
        result = normalizeInstalledApp(app.slug, 'android', {
          installed: r.installed,
          version: r.version,
          source: 'package-manager',
        });
      } catch {
        result = normalizeInstalledApp(app.slug, 'android', { installed: false, source: 'error' });
      }
    }
  } else {
    const identity = {
      appId: app.slug,
      windowsUninstallKey: app.windowsUninstallKey,
      windowsExecutable: app.windowsExecutable,
      linuxPackageName: app.linuxPackageName,
      linuxExecutable: app.linuxExecutable,
    };
    let raw: any = { installed: false };
    try {
      raw = (await desktopDetect(identity)) || { installed: false };
    } catch {
      raw = { installed: false, source: 'error' };
    }
    // Prefer the OS the native bridge actually reported over a UA guess.
    const reported = (raw.platform === 'windows' || raw.platform === 'linux') ? raw.platform : platform;
    result = normalizeInstalledApp(app.slug, reported, raw, app.version);
  }

  cache.set(app.slug, { at: Date.now(), result });
  return result;
}

export type { InstalledApp, DetectionState };

/** Coerce a raw native result into a normalized model (unit-test friendly). */
export { normalizeInstalledApp, stateForDetection, detectionState, compareVersions } from './detect';

/**
 * Reactive installed state for a single app. Web/PWA degrades to
 * DETECTION_UNAVAILABLE (-> Get). Native clients resolve against the OS.
 */
export function useInstalledState(app: App): {
  state: DetectionState;
  detection: InstalledApp | null;
  installed: boolean;
  refresh: () => Promise<void>;
} {
  const [detection, setDetection] = useState<InstalledApp | null>(null);
  const [state, setState] = useState<DetectionState>('DETECTION_UNAVAILABLE');

  const refresh = useCallback(async () => {
    if (!app) return;
    // Force a fresh read on explicit refresh (install/update/uninstall): drop
    // the frontend cache AND the Electron main-process cache.
    invalidateDetectionCache(app.slug);
    await desktopInvalidateDetect(app.slug);
    const result = await detectInstalledApp(app);
    setDetection(result);
    if (!result) setState('DETECTION_UNAVAILABLE');
    else setState(stateForDetection(result, app.version));
  }, [app]);

  useEffect(() => {
    if (!app) return;
    let alive = true;
    (async () => {
      const result = await detectInstalledApp(app);
      if (!alive) return;
      setDetection(result);
      setState(result ? stateForDetection(result, app.version) : 'DETECTION_UNAVAILABLE');
    })();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [app?.slug, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    state,
    detection,
    installed: !!(detection && detection.installed),
    refresh,
  };
}

/** Refresh detection after an install/uninstall/update and drop the native cache. */
export async function refreshInstalledApps(appIds?: string[]): Promise<void> {
  if (appIds?.length) {
    await desktopInvalidateDetect(appIds[0]);
    appIds.forEach((id) => invalidateDetectionCache(id));
  } else {
    await desktopInvalidateDetect();
    invalidateDetectionCache();
  }
}

