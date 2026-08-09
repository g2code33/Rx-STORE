/**
 * Site-wide icon registry — every icon the admin can change from
 * Admin → Icons. Pure module, harness-testable.
 *
 * Values live in site content under `icon.<id>` and are either an emoji
 * (e.g. "🪟") or an image URL (uploaded PNG). Empty/missing → the fallback.
 */

export interface IconSlot {
  /** content key suffix: icon.<id> */
  id: string;
  label: string;
  /** Where this icon shows up, so the admin knows what they're changing */
  usedIn: string;
  fallback: string;
  kind: 'platform' | 'brand';
  /** brand slots are images only (favicon etc.) — no emoji option */
  imageOnly?: boolean;
}

/** Emoji fallbacks per platform id (also used when a value is cleared). */
export const PLATFORM_ICON_FALLBACKS: Record<string, string> = {
  web: '🌐',
  windows: '🪟',
  linux: '🐧',
  android: '🤖',
  ios: '🍎',
  macos: '💻',
};

export const ICON_SLOTS: IconSlot[] = [
  { id: 'platform.web', label: 'Web', usedIn: 'Platform filters · download dialog · Get App', fallback: PLATFORM_ICON_FALLBACKS.web, kind: 'platform' },
  { id: 'platform.windows', label: 'Windows', usedIn: 'Platform filters · download dialog · Get App', fallback: PLATFORM_ICON_FALLBACKS.windows, kind: 'platform' },
  { id: 'platform.linux', label: 'Linux', usedIn: 'Platform filters · download dialog · Get App', fallback: PLATFORM_ICON_FALLBACKS.linux, kind: 'platform' },
  { id: 'platform.android', label: 'Android', usedIn: 'Platform filters · download dialog · Get App', fallback: PLATFORM_ICON_FALLBACKS.android, kind: 'platform' },
  { id: 'platform.ios', label: 'Apple / iOS', usedIn: 'Platform filters · download dialog · Get App', fallback: PLATFORM_ICON_FALLBACKS.ios, kind: 'platform' },
  { id: 'platform.macos', label: 'macOS', usedIn: 'Download dialog', fallback: PLATFORM_ICON_FALLBACKS.macos, kind: 'platform' },
  { id: 'brand.logo', label: 'Header logo', usedIn: 'Top-left of every page', fallback: '/v1.png', kind: 'brand', imageOnly: true },
  { id: 'brand.favicon', label: 'Browser tab icon (favicon)', usedIn: 'Browser tabs · bookmarks', fallback: '/favicon.png', kind: 'brand', imageOnly: true },
  { id: 'brand.appleTouch', label: 'Apple home-screen icon', usedIn: 'iPhone/iPad "Add to Home Screen"', fallback: '/icon-192.png', kind: 'brand', imageOnly: true },
];

/** The content key a slot is stored under. */
export function iconContentKey(slotId: string): string {
  return `icon.${slotId}`;
}

/** True when the value is an image (uploaded PNG/URL) rather than an emoji. */
export function isImageIcon(v: unknown): boolean {
  const s = String(v ?? '').trim();
  return s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/') || s.startsWith('data:');
}

/** What to render: the stored value if non-empty, else the slot fallback. */
export function resolveIcon(stored: unknown, slotId: string): string {
  const s = String(stored ?? '').trim();
  if (s) return s;
  const slot = ICON_SLOTS.find((x) => x.id === slotId);
  return slot?.fallback ?? PLATFORM_ICON_FALLBACKS[slotId] ?? '📦';
}
