/**
 * One-tap install decision (Play-Store-style) — the single source of truth
 * for whether tapping GET starts the download IMMEDIATELY or opens the
 * platform picker.
 *
 * WHY (production feedback, 2026-10): RX Store already auto-detects the
 * device, but tapping Get still opened a modal asking the user to choose
 * "Android" again — an extra tap on every install. On a confidently-detected
 * device whose app ships a matching package, the download must start
 * straight away, exactly like an app store.
 *
 * The picker deliberately REMAINS for:
 *   - web / iOS recommendations (iOS needs the Add-to-Home-Screen walkthrough;
 *     web/PWA is just an external link, and the PWA banner may be preferred),
 *   - undetected / standalone-PWA devices (`recommended: 'web'`),
 *   - apps with NO package for the detected device (the picker's fallback
 *     recommendation then points at what IS available, e.g. Web/PWA).
 */

export interface DeviceDetectionLike {
  device: string;
  recommended: string;
}

/**
 * Platform ids that qualify for one-tap when detected with confidence.
 * NOTE: 'web' and 'ios' are intentionally absent (see the module comment).
 */
export const ONE_TAP_PLATFORMS = ['android', 'windows', 'macos', 'linux_deb', 'linux_appimage'] as const;

/**
 * Whether an app ships a package for a platform id. Mirrors the picker's
 * availability rule: an exact match OR a base-platform match (an app that
 * declares 'linux' serves both linux_deb and linux_appimage; the server's
 * selectPackage resolves the actual file).
 */
export function platformAvailableFor(appPlatforms: string[] | null | undefined, platform: string): boolean {
  const available = (Array.isArray(appPlatforms) && appPlatforms.length
    ? appPlatforms
    : ['web']
  ).map((p) => String(p));
  const base = String(platform || '').split('_')[0];
  return available.includes(String(platform)) || available.includes(base);
}

/**
 * Resolve the platform to auto-start for this viewer, or null to show the
 * platform picker.
 */
export function resolveOneTapPlatform(
  detection: DeviceDetectionLike | null | undefined,
  appPlatforms: string[] | null | undefined,
): string | null {
  const rec = String(detection?.recommended || '');
  if (!rec) return null;
  if (!(ONE_TAP_PLATFORMS as readonly string[]).includes(rec)) return null;
  return platformAvailableFor(appPlatforms, rec) ? rec : null;
}

/**
 * The recommendation the PICKER should highlight: the detected platform when
 * the app actually ships it, else the best available fallback (Web/PWA is
 * universally usable, then whatever the app does ship). Used when the picker
 * is shown so an Android user on a web-only app sees "Web / PWA —
 * Recommended" at the top instead of a disabled Android row.
 */
export function effectiveRecommendation(
  detection: DeviceDetectionLike | null | undefined,
  appPlatforms: string[] | null | undefined,
): string {
  const rec = String(detection?.recommended || '');
  if (rec && platformAvailableFor(appPlatforms, rec)) return rec;
  if (platformAvailableFor(appPlatforms, 'web')) return 'web';
  const available = (Array.isArray(appPlatforms) && appPlatforms.length ? appPlatforms : ['web']).map((p) => String(p));
  return available[0] || 'web';
}
