/**
 * RX Store — Library device-awareness classification (Phase 16).
 *
 * PURE functions: given the current device's NATIVE detection (authoritative),
 * the account's last-known installations for OTHER devices, and the app's
 * platform availability, classify each catalog app for the Library and the
 * first-launch restore flow. No localStorage guessing, no fabricated usage.
 */

import type { App } from '../types/index.ts';
import type { AppInstallation } from '../types/device.ts';

export type RuntimePlatformLite = 'windows' | 'linux' | 'android' | 'web';

/** What the Library shows for one app on this device. */
export interface LibraryClassification {
  /** Native detection says installed on THIS device. */
  thisDevice: boolean;
  /** An update is available on THIS device (native detection). */
  thisDeviceUpdate: boolean;
  /** Other registered devices report it installed (last known). */
  otherDeviceIds: string[];
  /** Some other device reports an update available (last known). */
  otherDeviceUpdate: boolean;
  /** Every account installation record is not_installed (was installed before). */
  previouslyInstalled: boolean;
  /** The app publishes a package/platform usable from this device. */
  supportedOnThisPlatform: boolean;
}

export interface ClassifyInput {
  app: Pick<App, 'slug' | 'platforms'>;
  /** Native detection result for THIS device (authoritative). */
  thisDevice: { installed: boolean; updateAvailable: boolean };
  /** Account installations (backend last-known; may include this device's row). */
  installations: Array<Pick<AppInstallation, 'appSlug' | 'deviceId' | 'status'>>;
  /** Stable id of the CURRENT device (to exclude its own backend rows). */
  currentDeviceId?: string;
  /** The platform this device runs on. */
  runtimePlatform: RuntimePlatformLite;
}

/** Can this app run on/behind the given device platform? (web apps run anywhere.) */
export function appSupportsPlatform(platforms: string[] | undefined, runtimePlatform: RuntimePlatformLite): boolean {
  const list = Array.isArray(platforms) ? platforms.map((p) => String(p).toLowerCase()) : [];
  if (list.includes(runtimePlatform)) return true;
  // A web build runs in any browser — including inside the desktop/Android shells.
  if (list.includes('web')) return true;
  // The store normalizes the old "andriod" typo on read; tolerate it here too.
  if (runtimePlatform === 'android' && list.includes('andriod')) return true;
  return false;
}

export function classifyLibraryApp(input: ClassifyInput): LibraryClassification {
  const { app, thisDevice, installations, currentDeviceId, runtimePlatform } = input;

  const mine = installations.filter((i) => i.appSlug === app.slug && i.deviceId !== currentDeviceId);
  const otherInstalled = mine.filter((i) => ['installed', 'update_available', 'installing', 'updating'].includes(i.status));
  const allRecords = installations.filter((i) => i.appSlug === app.slug);

  return {
    thisDevice: !!thisDevice.installed,
    thisDeviceUpdate: !!thisDevice.updateAvailable,
    otherDeviceIds: [...new Set(otherInstalled.map((i) => i.deviceId))],
    otherDeviceUpdate: mine.some((i) => i.status === 'update_available' || i.status === 'update_failed'),
    previouslyInstalled: !thisDevice.installed && allRecords.length > 0 && allRecords.every((i) => ['not_installed', 'install_failed', 'uninstall_failed', 'uninstalling'].includes(i.status)),
    supportedOnThisPlatform: appSupportsPlatform(app.platforms, runtimePlatform),
  };
}

// ---------------------------------------------------------------------------
// First-launch eligibility (PURE — unit-tested)
// ---------------------------------------------------------------------------

export interface RestoreCandidate {
  slug: string;
  name: string;
  icon?: string;
  gradient?: string;
  version?: string;
  /** Factual signals only. */
  deviceCount: number;
  previouslyInstalled: boolean;
  /** Real usage data (user's download events), when it exists. */
  userDownloads?: number;
}

export interface FirstLaunchInput {
  signedIn: boolean;
  offline: boolean;
  catalogLoaded: boolean;
  /** Marker already recorded for this user+device (done before). */
  alreadyDone: boolean;
  /** Apps with another-device installation or prior history, supported here. */
  candidates: RestoreCandidate[];
}

/**
 * Should the "Your apps, ready to go" first-launch screen show?
 * Only when there is something REAL to restore and we can act honestly:
 * signed in, online, catalog ready, not done before, and at least one
 * restorable app. A brand-new user with no history sees nothing (honest).
 */
export function shouldShowFirstLaunch(input: FirstLaunchInput): boolean {
  if (!input.signedIn) return false;
  if (input.offline) return false; // never promise installs we can't start
  if (!input.catalogLoaded) return false;
  if (input.alreadyDone) return false;
  return input.candidates.length > 0;
}

/**
 * Order restore candidates by FACTUAL usage signals only: apps installed on
 * more of the user's devices first, then by the user's real download count
 * (when such data exists). Stable by name after that.
 */
export function orderRestoreCandidates<T extends RestoreCandidate>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => {
    const devices = (b.deviceCount || 0) - (a.deviceCount || 0);
    if (devices !== 0) return devices;
    const downloads = (b.userDownloads || 0) - (a.userDownloads || 0);
    if (downloads !== 0) return downloads;
    return String(a.name).localeCompare(String(b.name));
  });
}

/**
 * Does enough real usage data exist to justify a "Most used" label?
 * (Factual threshold: at least one candidate with real download history.)
 */
export function hasRealUsageData(candidates: RestoreCandidate[]): boolean {
  return candidates.some((c) => (c.userDownloads || 0) > 0);
}
