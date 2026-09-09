/**
 * Shared device / installation types.
 *
 * These are the canonical string-literal unions for the account-aware,
 * multi-device installation model. Both the frontend state layer and the UI
 * consume these so we never scatter raw strings around the codebase.
 */

/** The platform an RX Store install runs on. */
export type DevicePlatform = 'windows' | 'linux' | 'android' | 'web';

/** The kind of device. */
export type DeviceType = 'phone' | 'tablet' | 'desktop' | 'pwa';

/** Lifecycle status of a device on an account. */
export type DeviceStatus = 'active' | 'revoked';

/** A single device on the user's account (clean, frontend-safe shape). */
export interface Device {
  /** Internal device row id (backend). */
  id: string;
  /** Stable per-install client device id (survives restart/login/logout). */
  deviceId: string;
  deviceName: string;
  platform: DevicePlatform;
  deviceType: DeviceType;
  osVersion?: string;
  rxStoreVersion?: string;
  lastSeenAt: string;
  createdAt: string;
  status: DeviceStatus;
  /** Whether this is the device the current request originated from. */
  isCurrentDevice?: boolean;
}

/** Installation state for an application on a device (backend statuses). */
export type InstallationStatus =
  | 'installed'
  | 'not_installed'
  | 'update_available'
  | 'installing'
  | 'updating'
  | 'uninstalling'
  | 'install_failed'
  | 'update_failed'
  | 'uninstall_failed'
  | 'unknown';

/** Where a detection/installation result came from on the local device. */
export type DetectionSource =
  | 'registry'
  | 'executable'
  | 'desktop'
  | 'package'
  | 'package-manager'
  | 'appimage'
  | 'appimage_owned'
  | 'flatpak'
  | 'unconfigured'
  | 'none'
  | 'error'
  | 'unknown';

/** A single application installation record (cloud last-known state). */
export interface AppInstallation {
  deviceId: string;
  appSlug: string;
  appName?: string;
  platform?: DevicePlatform;
  installedVersion?: string;
  status: InstallationStatus;
  detectionSource?: DetectionSource | string;
  deviceName?: string;
  lastDetectedAt?: string;
  updatedAt?: string;
}
