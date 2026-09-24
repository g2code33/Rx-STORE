/**
 * Profile section navigation — deterministic, URL-driven.
 *
 * Every account section is directly addressable:
 *   /profile?tab=profile        Personal details (name / email)
 *   /profile?tab=apps           My Applications
 *   /profile?tab=devices        My Devices
 *   /profile?tab=purchases      Purchases
 *   /profile?tab=subscriptions  Subscriptions
 *   /profile?tab=notifications  Notifications
 *   /profile?tab=trash          Recycle Bin
 *   /profile?tab=settings       Settings
 *
 * `/profile` with no (or unknown) tab falls back to the default section, so
 * existing links — e.g. the mobile Account tab — keep working. The URL is the
 * single source of truth: clicking a section updates the query string and
 * browser back/forward therefore restores the section.
 */

export const PROFILE_TABS = [
  'profile',
  'apps',
  'devices',
  'purchases',
  'subscriptions',
  'notifications',
  'trash',
  'settings',
] as const;

export type ProfileTab = (typeof PROFILE_TABS)[number];

/** The section shown for a bare `/profile` visit (previous default behaviour). */
export const DEFAULT_PROFILE_TAB: ProfileTab = 'apps';

export function isProfileTab(value: unknown): value is ProfileTab {
  return typeof value === 'string' && (PROFILE_TABS as readonly string[]).includes(value);
}

/** Map a raw ?tab= value to a valid tab (unknown/missing → default). */
export function normalizeProfileTab(value: string | null | undefined): ProfileTab {
  return isProfileTab(value) ? value : DEFAULT_PROFILE_TAB;
}

/** The href that opens a profile section directly. */
export function profileTabHref(tab: ProfileTab): string {
  return `/profile?tab=${tab}`;
}

/**
 * A safe post-login redirect target. Only same-app paths are allowed (must
 * start with a single '/'), which blocks open-redirects via ?redirect=//evil.
 */
export function safeRedirectTarget(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}
