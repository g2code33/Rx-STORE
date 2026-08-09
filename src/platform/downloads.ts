/**
 * Device-aware "Get the RX Store app" — detection + download registry.
 * Pure module, harness-testable.
 *
 * Downloads point at GitHub Releases' /releases/latest/download/<asset> —
 * they always serve the CURRENT release. Asset file names carry the version,
 * so bump APP_DOWNLOAD_VERSION + the map below together with a new release.
 */

export type DeviceKind = 'windows' | 'android' | 'ios' | 'linux' | 'mac' | 'unknown';

export interface DownloadOption {
  id: 'windows' | 'deb' | 'appimage' | 'android';
  /** Human platform name ("Windows", "Ubuntu / Debian") */
  platform: string;
  file: string;
  ext: string;
  size: string;
  url: string;
  icon: string;
  /** Short install hint shown under the button */
  note: string;
}

export const APP_DOWNLOAD_VERSION = '1.0.0';

const REL = `https://github.com/g2code33/Rx-STORE/releases/latest/download`;

export const DOWNLOAD_OPTIONS: Record<DownloadOption['id'], DownloadOption> = {
  windows: {
    id: 'windows',
    platform: 'Windows',
    file: `RXStore-Setup-${APP_DOWNLOAD_VERSION}.exe`,
    ext: '.exe',
    size: '105 MB',
    url: `${REL}/RXStore-Setup-${APP_DOWNLOAD_VERSION}.exe`,
    icon: '🪟',
    note: 'Windows 10/11 · per-user install, auto-updates. SmartScreen: click "More info → Run anyway" (new app, building reputation).',
  },
  deb: {
    id: 'deb',
    platform: 'Ubuntu / Debian',
    file: `RX-Store-${APP_DOWNLOAD_VERSION}.deb`,
    ext: '.deb',
    size: '104 MB',
    url: `${REL}/RX-Store-${APP_DOWNLOAD_VERSION}.deb`,
    icon: '🐧',
    note: 'Install: sudo dpkg -i ' + `RX-Store-${APP_DOWNLOAD_VERSION}.deb` + ' (then the RX Store launcher appears in your apps).',
  },
  appimage: {
    id: 'appimage',
    platform: 'Other Linux',
    file: `RX-Store-${APP_DOWNLOAD_VERSION}.AppImage`,
    ext: '.AppImage',
    size: '135 MB',
    url: `${REL}/RX-Store-${APP_DOWNLOAD_VERSION}.AppImage`,
    icon: '📦',
    note: 'chmod +x the file and run it — no install, no root. Auto-updates itself like the rest.',
  },
  android: {
    id: 'android',
    platform: 'Android',
    file: `rx-store-${APP_DOWNLOAD_VERSION}.apk`,
    ext: '.apk',
    size: '5.7 MB',
    url: `${REL}/rx-store-${APP_DOWNLOAD_VERSION}.apk`,
    icon: '🤖',
    note: 'Android 8+ · tap the file and allow "Install unknown apps" for your browser when asked — one-time step.',
  },
};

/**
 * Detect the visitor's device from the user agent (+ touch points for iPadOS,
 * which pretends to be a Mac). iOS is checked BEFORE android/linux/mac.
 */
export function detectDevice(userAgent: string, opts?: { maxTouchPoints?: number }): DeviceKind {
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) return 'unknown';
  const touch = opts?.maxTouchPoints ?? 0;
  if (/iphone|ipod|ipad/.test(ua)) return 'ios';
  // iPadOS 13+ reports "Macintosh" — distinguish by touch
  if (/macintosh|mac os x/.test(ua) && touch > 1) return 'ios';
  if (/android/.test(ua)) return 'android';
  if (/windows nt|win64|win32|wow64/.test(ua)) return 'windows';
  if (/ubuntu|linux|x11|debian|fedora|arch/.test(ua)) return 'linux';
  if (/macintosh|mac os x/.test(ua)) return 'mac';
  return 'unknown';
}

/** Ordered download options to OFFER for a device (iOS/mac → PWA instead). */
export function downloadsFor(device: DeviceKind): DownloadOption[] {
  switch (device) {
    case 'windows': return [DOWNLOAD_OPTIONS.windows];
    case 'linux': return [DOWNLOAD_OPTIONS.deb, DOWNLOAD_OPTIONS.appimage];
    case 'android': return [DOWNLOAD_OPTIONS.android];
    case 'ios':
    case 'mac': return []; // PWA path — no native build yet
    default: return [DOWNLOAD_OPTIONS.windows, DOWNLOAD_OPTIONS.deb, DOWNLOAD_OPTIONS.appimage, DOWNLOAD_OPTIONS.android];
  }
}

/** One-line "we detected you're on X" label. */
export function deviceLabel(device: DeviceKind): string {
  switch (device) {
    case 'windows': return 'Windows';
    case 'android': return 'Android';
    case 'ios': return 'iPhone / iPad';
    case 'linux': return 'Linux';
    case 'mac': return 'macOS';
    default: return 'this device';
  }
}

/** Short action copy per device for the banner. */
export function bannerPitch(device: DeviceKind): string {
  switch (device) {
    case 'windows': return 'Native app with auto-updates and offline shell.';
    case 'linux': return 'Native .deb / AppImage with auto-updates.';
    case 'android': return 'Install the APK for a faster, app-store feel.';
    case 'ios': return 'Add it to your Home Screen — full app experience, no store needed.';
    case 'mac': return 'Install it as a web app until the Mac build lands.';
    default: return 'Get the native app for your device.';
  }
}
