/**
 * Validation Utilities
 *
 * Server-side validation only — frontend validation is a UX convenience and is
 * never trusted. All validators are pure and unit-tested.
 */

export function validateEmail(email: unknown): boolean {
  const s = String(email ?? '').trim();
  if (s.length < 5 || s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

/**
 * Password policy: at least 8 chars and at most 200 (bcrypt/PBKDF2 DoS guard).
 * Requires a mix of letters and digits OR a long passphrase.
 */
export function validatePassword(password: unknown): boolean {
  const s = String(password ?? '');
  if (s.length < 8 || s.length > 200) return false;
  const hasLetter = /[A-Za-z]/.test(s);
  const hasNumberOrSymbol = /[\d\W]/.test(s);
  if (s.length >= 12) return hasLetter; // long passphrases are fine on their own
  return hasLetter && hasNumberOrSymbol;
}

/** Human-readable password requirement (for clients). */
export const PASSWORD_REQUIREMENT = 'At least 8 characters, including a letter and a number or symbol (or a 12+ character passphrase).';

export function validateSlug(slug: unknown): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug ?? ''));
}

/** A safe opaque identifier (user ids, device ids, session ids, app ids). */
export function validateId(id: unknown, maxLen = 128): boolean {
  const s = String(id ?? '');
  if (!s || s.length > maxLen) return false;
  return /^[A-Za-z0-9._:\-]+$/.test(s);
}

/** UUID (v4-ish, CASE-insensitive, dash-separated). */
export function validateUuid(id: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id ?? ''));
}

/** Package/release platform ids accepted by the store. */
export const PLATFORMS = ['web', 'pwa', 'windows', 'linux', 'linux_deb', 'linux_appimage', 'flatpak', 'android', 'ios', 'macos'] as const;
export function validatePlatform(p: unknown): boolean {
  return (PLATFORMS as readonly string[]).includes(String(p ?? '').toLowerCase());
}

/** Architectures accepted for a package. */
export const ARCHITECTURES = ['x64', 'x86', 'arm64', 'arm', 'universal'] as const;
export function validateArchitecture(a: unknown): boolean {
  return (ARCHITECTURES as readonly string[]).includes(String(a ?? '').toLowerCase());
}

/** A version string (semver-ish; allows prerelease/build metadata). */
export function validateVersion(v: unknown): boolean {
  return /^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(String(v ?? '').trim());
}

/** A SHA-256 checksum (64 hex chars). */
export function validateSha256(s: unknown): boolean {
  return /^[a-f0-9]{64}$/i.test(String(s ?? ''));
}

/** Device platform/type for the device registry. */
export const DEVICE_PLATFORMS = ['windows', 'linux', 'android', 'web'] as const;
export const DEVICE_TYPES = ['phone', 'tablet', 'desktop', 'pwa'] as const;
export function validateDevicePlatform(p: unknown): boolean {
  return (DEVICE_PLATFORMS as readonly string[]).includes(String(p ?? '').toLowerCase());
}
export function validateDeviceType(t: unknown): boolean {
  return (DEVICE_TYPES as readonly string[]).includes(String(t ?? '').toLowerCase());
}

/** E.164-ish phone with optional leading +. */
export function validatePhone(p: unknown): boolean {
  return /^\+?[0-9]{8,15}$/.test(String(p ?? '').replace(/\s+/g, ''));
}

export function sanitizeInput(input: string): string {
  return String(input ?? '').replace(/[<>"'&]/g, '');
}

/**
 * Reject payloads containing keys outside `allowed`. Prevents clients from
 * smuggling unexpected fields (e.g. role, user_id) into update payloads.
 * Returns the offending keys, or an empty array when clean.
 */
export function unexpectedFields(body: any, allowed: string[]): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const allow = new Set(allowed);
  return Object.keys(body).filter((k) => !allow.has(k));
}

/** Clamp a string length (defence against oversized payload fields). */
export function clampString(v: unknown, max = 500): string {
  return String(v ?? '').slice(0, max);
}
