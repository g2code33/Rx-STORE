/**
 * RX Store — generic Native Runtime.
 *
 * A thin, application-agnostic layer that hides OS-specific details from the
 * React UI. It composes the existing platform modules (nativeInstaller.ts and
 * nativeDetection.ts) into one coherent runtime surface:
 *
 *   NativeRuntime
 *   ├── Detection      (has the app been installed? what version?)
 *   ├── Launcher       (open a detected app)
 *   ├── Installer      (download + open the installer for the current platform)
 *   ├── Updater        (download the newer build)
 *   ├── Uninstaller    (invoke the OS's real uninstall mechanism)
 *   └── DeviceIdentity (stable per-install device id + record)
 *
 * No application-specific logic (e.g. "CGPA Pilot") lives here. The runtime is
 * fed an `App` and a wallet of platform operations; it decides the current
 * device's install state via the pure detectors in detect.ts.
 */
import type { App } from '../types';
import {
  DetectionState,
  InstallOperation,
  InstalledApp,
  currentDeviceInstallState,
  detectionState,
  resolveDeviceView,
  stateForDetection,
  type InstallState,
} from '../platform/detect';
import {
  detectInstalledApp,
  invalidateDetectionCache,
  refreshInstalledApps,
  isDetectionAvailable,
} from '../platform/nativeDetection';
import {
  androidDownloadAndInstall,
  androidIsInstalled,
  androidOpen,
  androidUninstall,
  desktopDetect,
  desktopDownload,
  desktopInvalidateDetect,
  desktopOpenTarget,
  desktopUninstall,
  isAndroidShell,
  isDesktopShell,
  type NativePackageState,
} from '../platform/nativeInstaller';
import { buildDeviceRecord, getDeviceId, getRuntimePlatform } from './deviceIdentity';

export type { NativePackageState, InstallState, InstalledApp, DetectionState, InstallOperation };

export interface NativeRuntime {
  /** Whether this runtime can perform real OS-level detection at all. */
  canDetect(): boolean;

  /** Detect whether `app` is installed on the CURRENT device (authoritative). */
  detect(app: App): Promise<InstalledApp | null>;

  /** Resolve the current device's install state, plus other-device count. */
  resolve(app: App, opts?: { operation?: InstallOperation; otherInstallations?: any[]; currentDeviceId?: string }): Promise<{ state: InstallState; otherDevices: number }>;

  /** Reconstruct a fresh detection result after install/uninstall/update. */
  refresh(appId?: string): Promise<void>;

  /** Launch a positively-detected application on the current device. */
  open(app: App, target?: string): Promise<void>;

  /** Download + open the OS installer for the current platform. */
  install(app: App, url: string, fileName: string, opts?: { platform?: string }): Promise<{ started?: boolean; permissionRequired?: boolean }>;

  /** Invoke the registered uninstaller for the current platform. */
  uninstall(app: App, target?: string): Promise<void>;

  /** Stable device identity for this install. */
  device(): ReturnType<typeof buildDeviceRecord>;
}

const isWeb = () => !isDesktopShell() && !isAndroidShell();

export function createNativeRuntime(): NativeRuntime {
  return {
    canDetect: () => isDetectionAvailable(),

    detect: async (app) => detectInstalledApp(app),

    resolve: async (app, opts) => {
      const local = await detectInstalledApp(app);
      const currentDeviceId = opts?.currentDeviceId || getDeviceId();
      return resolveDeviceView({
        local,
        storeVersion: app.version,
        operation: opts?.operation,
        otherInstallations: opts?.otherInstallations,
        currentDeviceId,
      });
    },

    refresh: async (appId) => {
      if (appId) {
        await desktopInvalidateDetect(appId);
        invalidateDetectionCache(appId);
      } else {
        await refreshInstalledApps();
      }
    },

    open: async (app, target) => {
      // Android: launch by the configured package ID (never a remote path).
      if (isAndroidShell() && app.androidPackageId) {
        await androidOpen(app.androidPackageId);
        return;
      }
      // Desktop: launch a POSITIVELY-DETECTED native executable/launcher ONLY.
      // For a NATIVE application we must never fall back to opening its website
      // when no native executable could be detected. A website is only opened
      // when the application is explicitly a web/PWA app OR when the resolved
      // target is a URL and detection was unavailable.
      if (isDesktopShell()) {
        const detected = await detectInstalledApp(app);
        const launchTarget = target || detected?.executable;
        // Explicit URL targets (PWA / website) route to the system browser.
        if (/^https?:\/\//i.test((launchTarget || '')) && !detected?.installed) {
          await desktopOpenTarget(launchTarget!);
          return;
        }
        if (!launchTarget) throw new Error('The publisher has not configured an Open target for this app yet');
        await desktopOpenTarget(launchTarget);
        return;
      }
      throw new Error('Opening an installed application is only available in the native apps.');
    },

    install: async (app, url, fileName, opts) => {
      // Android: hand the completed APK to Android's protected installer.
      if (isAndroidShell()) {
        return androidDownloadAndInstall(url, fileName);
      }
      // Desktop: download to the real Downloads folder then expose an Install step.
      // We deliberately DO NOT default launchTarget to app.website — a native
      // app's Open must resolve to its detected executable, never a website.
      if (isDesktopShell()) {
        await desktopDownload({
          slug: app.slug,
          url,
          fileName,
          version: app.version,
          // Only a known web/PWA app gets a website launch target.
          launchTarget: app.platforms?.includes('web') && !app.androidPackageId && !app.windowsExecutable && !app.linuxExecutable
            ? (app as any).website || undefined
            : undefined,
        });
        return { started: true, permissionRequired: false };
      }
      // Web/PWA: the browser handles the download.
      return { started: true, permissionRequired: false };
    },

    uninstall: async (app, target) => {
      if (isAndroidShell() && app.androidPackageId) {
        await androidUninstall(app.androidPackageId);
        return;
      }
      if (isDesktopShell()) {
        // Pass the detected uninstall target (registry UninstallString / package
        // name) so the main process invokes the real mechanism, not a software
        // manager. Empty target falls back to the app's configured identity.
        await desktopUninstall(app.slug, target);
        return;
      }
      throw new Error('Uninstalling is only available in the native apps.');
    },

    device: () => buildDeviceRecord(),
  };
}

/** A single shared runtime instance for the app. */
let runtime: NativeRuntime | null = null;
export function getNativeRuntime(): NativeRuntime {
  if (!runtime) runtime = createNativeRuntime();
  return runtime;
}

export { getDeviceId, getRuntimePlatform };

// Re-export helpers the UI may still want (kept for backward-compat usage).
export { detectionState as dstate, stateForDetection as sstate, currentDeviceInstallState as cdState };
