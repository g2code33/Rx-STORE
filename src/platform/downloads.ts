/**
 * Device-aware "Get the RX Store app" — detection + download registry.
 * Pure module, harness-testable.
 *
 * Downloads are served by THE STORE ITSELF — the same pipeline every other app
 * uses: GET /apps/rx-store/download?platform=… returns an R2 URL on our own
 * worker (uploaded by the admin through the Releases flow). No GitHub links.
 */

export type DeviceKind = 'windows' | 'android' | 'ios' | 'linux' | 'mac' | 'unknown';

export const SELF_APP_SLUG = 'rx-store';

/** Platform ids understood by the store's download endpoint. */
export type StorePlatform = 'windows' | 'linux_deb' | 'linux_appimage' | 'android';

export interface DownloadOption {
  id: StorePlatform;
  /** Human platform name ("Windows", "Ubuntu / Debian") */
  platform: string;
  /** Store ?platform= id */
  platformId: StorePlatform;
  ext: string;
  size: string;
  icon: string;
  /** Short install hint shown under the button */
  note: string;
}

export const DOWNLOAD_OPTIONS: Record<StorePlatform, DownloadOption> = {
  windows: {
    id: 'windows',
    platform: 'Windows',
    platformId: 'windows',
    ext: '.exe',
    size: '~105 MB',
    icon: '🪟',
    note: 'Windows 10/11 · per-user install, auto-updates. SmartScreen: click "More info → Run anyway" (new app, building reputation).',
  },
  linux_deb: {
    id: 'linux_deb',
    platform: 'Ubuntu / Debian',
    platformId: 'linux_deb',
    ext: '.deb',
    size: '~104 MB',
    icon: '🐧',
    note: 'Install: sudo dpkg -i <file>.deb — then the RX Store launcher appears in your apps.',
  },
  linux_appimage: {
    id: 'linux_appimage',
    platform: 'Other Linux',
    platformId: 'linux_appimage',
    ext: '.AppImage',
    size: '~135 MB',
    icon: '📦',
    note: 'chmod +x the file and run it — no install, no root. Auto-updates itself like the rest.',
  },
  android: {
    id: 'android',
    platform: 'Android',
    platformId: 'android',
    ext: '.apk',
    size: '~6 MB',
    icon: '🤖',
    note: 'Android 8+ · tap the file and allow "Install unknown apps" for your browser when asked — one-time step.',
  },
};

/** The store's own download path for a platform (prefix with the API origin). */
export function storeDownloadPath(platformId: StorePlatform, slug: string = SELF_APP_SLUG): string {
  return `/apps/${slug}/download?platform=${platformId}`;
}

/** Public listing path — used to check the admin has published it + show version. */
export function selfListingPath(slug: string = SELF_APP_SLUG): string {
  return `/apps/${slug}`;
}

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
    case 'linux': return [DOWNLOAD_OPTIONS.linux_deb, DOWNLOAD_OPTIONS.linux_appimage];
    case 'android': return [DOWNLOAD_OPTIONS.android];
    case 'ios':
    case 'mac': return []; // PWA path — no native build yet
    default: return [DOWNLOAD_OPTIONS.windows, DOWNLOAD_OPTIONS.linux_deb, DOWNLOAD_OPTIONS.linux_appimage, DOWNLOAD_OPTIONS.android];
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
