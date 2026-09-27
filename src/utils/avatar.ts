/**
 * Avatar decision logic — the SINGLE source of truth for how a user avatar is
 * rendered, shared by every avatar render site (Header, Profile, …).
 *
 * WHY this exists (production bug, 2026-09-27): accounts created via Google /
 * GitHub sign-in carry the PROVIDER's picture as a URL string
 * (`https://avatars.githubusercontent.com/…`, `https://lh3.googleusercontent.com/…`)
 * while password-registered accounts carry an emoji ('👤'). The UI rendered
 * the value as TEXT everywhere, so social sign-in showed a raw URL crammed
 * into a 32px box instead of the picture. Rendering must branch on the VALUE.
 */

/** True when the avatar value is an image to load (remote URL or data URL). */
export function isImageAvatar(avatar: unknown): boolean {
  const s = String(avatar ?? '').trim();
  if (!s || s.length > 2048) return false; // sanity cap — never feed junk to <img src>
  return /^https?:\/\//i.test(s) || /^data:image\//i.test(s);
}

/** The text to show when no image applies (never a URL, never empty). */
export function avatarFallbackText(avatar: unknown): string {
  const s = String(avatar ?? '').trim();
  if (!s) return '👤';
  // A URL that failed to load (or was blocked) must never be printed as text.
  return isImageAvatar(s) ? '👤' : s;
}
