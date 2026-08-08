export type DeviceType = 'iphone' | 'ipad' | 'android_phone' | 'android_tablet' | 'windows' | 'macos' | 'linux' | 'unknown';

export function detectDevice(): { device: DeviceType; label: string; emoji: string; recommended: string } {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  const platform = typeof navigator !== 'undefined' ? (navigator.platform || '').toLowerCase() : '';
  const isStandalone = typeof window !== 'undefined' && ((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (window as any).navigator?.standalone);

  if (isStandalone) {
    return { device: 'unknown', label: 'PWA installed', emoji: '✅', recommended: 'web' };
  }

  const isIPhone = /iphone/.test(ua) && !/ipad/.test(ua);
  const isIPad = /ipad/.test(ua) || (platform.includes('mac') && 'ontouchend' in document);
  const isAndroid = /android/.test(ua);
  const isAndroidTablet = isAndroid && !/mobile/.test(ua);
  const isAndroidPhone = isAndroid && /mobile/.test(ua);
  const isWindows = /windows/.test(ua) || platform.includes('win');
  const isMac = /mac/.test(ua) && !isIPad && !isIPhone;
  const isLinux = /linux/.test(ua) && !isAndroid;

  if (isIPhone) return { device: 'iphone', label: 'iPhone detected', emoji: '📱', recommended: 'ios' };
  if (isIPad) return { device: 'ipad', label: 'iPad detected', emoji: '📱', recommended: 'ios' };
  if (isAndroidPhone) return { device: 'android_phone', label: 'Android phone detected', emoji: '🤖', recommended: 'android' };
  if (isAndroidTablet) return { device: 'android_tablet', label: 'Android tablet detected', emoji: '🤖', recommended: 'android' };
  if (isWindows) return { device: 'windows', label: 'Windows detected', emoji: '💻', recommended: 'windows' };
  if (isMac) return { device: 'macos', label: 'macOS detected', emoji: '🍎', recommended: 'macos' };
  if (isLinux) return { device: 'linux', label: 'Linux detected', emoji: '🐧', recommended: 'linux_deb' };

  return { device: 'unknown', label: 'Device not detected', emoji: '🌐', recommended: 'web' };
}

export function isPWADisplayStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches || (window as any).navigator?.standalone === true;
}
