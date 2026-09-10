/**
 * RX Store — hook that exposes the NativeRuntime for lifecycle operations and a
 * reconcile-aware uninstall (re-detect before reporting, never assume success).
 */
import { useCallback, useMemo } from 'react';
import type { App } from '../types';
import { getNativeRuntime, type NativeRuntime } from './runtime';
import { reportCurrentInstallation } from './accountSync';
import { getRuntimePlatform } from './deviceIdentity';
import { invalidateDetectionCache } from '../platform/nativeDetection';

export interface UseNativeRuntimeResult {
  runtime: NativeRuntime;
  /** Invoke the real uninstall, then re-detect and reconcile only confirmed state. */
  uninstall: (app: App) => Promise<void>;
  /** Invoke Open for a detected app. */
  open: (app: App, target?: string) => Promise<void>;
}

export function useNativeRuntime(): UseNativeRuntimeResult {
  const runtime = useMemo(() => getNativeRuntime(), []);

  const uninstall = useCallback(async (app: App) => {
    await runtime.refresh(app.slug);
    const fresh = await runtime.detect(app);
    const target = fresh?.uninstallString || fresh?.packageName || fresh?.executable;
    const quietTarget = fresh?.quietUninstallString;
    const appImagePath = fresh?.appImagePath;
    if (!target && !appImagePath) throw new Error('No uninstall target was detected for this application.');
    await runtime.uninstall(app, target, { quietTarget, appImagePath });
    // Re-detect within a verification window; only report confirmed absence.
    const stillInstalled = await waitForRemoval(runtime, app.slug);
    await reportCurrentInstallation({
      appSlug: app.slug,
      platform: getRuntimePlatform(),
      installed: stillInstalled,
      installedVersion: stillInstalled ? (await runtime.detect(app))?.version : undefined,
      status: stillInstalled ? 'INSTALLED' : 'NOT_INSTALLED',
      detectionSource: stillInstalled ? (await runtime.detect(app))?.source : undefined,
    }).catch(() => {});
  }, [runtime]);

  const open = useCallback(async (app: App, target?: string) => {
    await runtime.open(app, target);
  }, [runtime]);

  return { runtime, uninstall, open };
}

/** Poll detection until the app is confirmed gone, or return its current state. */
async function waitForRemoval(runtime: NativeRuntime, appSlug: string): Promise<boolean> {
  const WINDOW = 60_000;
  const POLL = 3_000;
  const start = Date.now();
  let sawDetection = false;
  while (Date.now() - start < WINDOW) {
    try {
      invalidateDetectionCache(appSlug);
      await runtime.refresh(appSlug);
      const det = await runtime.detect({ slug: appSlug } as App);
      if (det) sawDetection = true;
      if (det?.installed) return true;
      if (det && !det.installed) return false;
    } catch { /* detection unavailable */ }
    await new Promise((r) => setTimeout(r, POLL));
  }
  return sawDetection ? false : true;
}
