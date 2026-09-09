/**
 * RX Store — device identity.
 *
 * Each RX Store install (Electron desktop, Android Capacitor, web/PWA) owns a
 * stable, unique device_id that:
 *   - survives RX Store restarts
 *   - survives login/logout
 *   - is unique per installation/device
 *   - never relies on IP
 *   - never exposes unnecessary hardware identifiers
 *
 * It is persisted in the browser's localStorage, which is stable per origin:
 *   - Electron: app:// origin persists in the app's userData dir across restarts
 *   - Android Capacitor: WebView localStorage persists across relaunches
 *   - web/PWA: localStorage persists per origin in the browser
 *
 * The web/PWA uses a browser-scoped identity but NEVER claims native detection.
 */
import { Capacitor } from '@capacitor/core';
import { isDesktopShell } from '../platform/nativeInstaller';

const DEVICE_ID_KEY = 'rx-store-device-id';
const DEVICE_NAME_KEY = 'rx-store-device-name';

export type RuntimePlatform = 'windows' | 'linux' | 'android' | 'web';

function randomId(): string {
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) return crypto.randomUUID();
  return `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Read (or lazily create) the stable device id for this install. */
export function getDeviceId(): string {
  if (typeof window === 'undefined') return randomId();
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = randomId();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return randomId();
  }
}

/** Persist a user-friendly device name (editable by the user, defaults set below). */
export function setDeviceName(name: string): void {
  try { localStorage.setItem(DEVICE_NAME_KEY, name); } catch { /* ignore */ }
}

export function getDeviceName(): string {
  try { return localStorage.getItem(DEVICE_NAME_KEY) || ''; } catch { return ''; }
}

export function clearDeviceIdentity(): void {
  try { localStorage.removeItem(DEVICE_NAME_KEY); } catch { /* ignore */ }
}

/** Resolve the current runtime platform without claiming native detection on web. */
export function getRuntimePlatform(): RuntimePlatform {
  if (isAndroidShellPlatform()) return 'android';
  if (isDesktopShell()) {
    const ua = (navigator.userAgent || '').toLowerCase();
    if (/windows/.test(ua)) return 'windows';
    if (/linux|x11/.test(ua)) return 'linux';
    return 'windows';
  }
  return 'web';
}

function isAndroidShellPlatform(): boolean {
  try { return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'; } catch { return false; }
}

function detectDeviceType(platform: RuntimePlatform): 'phone' | 'tablet' | 'desktop' | 'pwa' {
  if (platform === 'android') {
    const ua = navigator.userAgent || '';
    const w = Math.max(window.screen?.width || 0, window.screen?.height || 0);
    return w >= 600 || /tablet|ipad/i.test(ua) ? 'tablet' : 'phone';
  }
  if (platform === 'web') return 'pwa';
  return 'desktop';
}

/** Guess the OS version string from the user agent (best-effort, no hardware IDs). */
function detectOsVersion(platform: RuntimePlatform): string {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (platform === 'android') return (ua.match(/android (\d+\.?\d*)/) || [])[1] || '';
  if (platform === 'windows') return (ua.match(/windows nt (\d+\.\d+)/) || [])[1] || '';
  if (platform === 'linux') return 'linux';
  return '';
}

/** A default, human-friendly device name. */
function defaultDeviceName(platform: RuntimePlatform): string {
  switch (platform) {
    case 'android': return 'Android Phone';
    case 'windows': return 'Windows PC';
    case 'linux': return 'Linux PC';
    default: return 'Web / PWA';
  }
}

/**
 * Build the device record for the current install. `rxStoreVersion` is the app's
 * own version (used for heartbeat / diagnostics).
 */
export function buildDeviceRecord(rxStoreVersion?: string): {
  deviceId: string;
  deviceName: string;
  platform: RuntimePlatform;
  deviceType: 'phone' | 'tablet' | 'desktop' | 'pwa';
  osVersion: string;
  rxStoreVersion: string;
} {
  const platform = getRuntimePlatform();
  return {
    deviceId: getDeviceId(),
    deviceName: getDeviceName() || defaultDeviceName(platform),
    platform,
    deviceType: detectDeviceType(platform),
    osVersion: detectOsVersion(platform),
    rxStoreVersion: rxStoreVersion || '',
  };
}
