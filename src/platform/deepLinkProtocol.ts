/**
 * RX Store deep-link protocol — the ONE canonical definition of rxstore://
 * links, shared by the Electron main process, the web renderer, the Android
 * bridge and the unit tests. Deliberately FRAMEWORK-FREE and DOM-FREE (no
 * React, no Capacitor, no window/document/Electron imports) so every runtime
 * can import it safely; esbuild bundles it into the Electron main process.
 *
 * Canonical formats:
 *   Deep link:   rxstore://app/{slug}     → opens RX Store directly on /app/{slug}
 *   Web fallback: {webBase}/app/{slug}    → always works, no RX Store required
 *
 * SECURITY: parsing is strict allowlist-only. A deep link may address exactly
 * one destination shape (app/{slug}). Anything else — other hosts, extra path
 * segments, query strings, javascript:/file:/data: schemes, non-slug
 * characters — is rejected. The main process validates BEFORE forwarding to
 * the renderer and never executes URL content.
 */

export const RXSTORE_SCHEME = 'rxstore';

/**
 * Marketplace slugs: lowercase kebab-case, 1–64 chars, must start alphanumeric.
 * Rejects dots, slashes, "..", spaces, unicode, and anything that could be
 * mistaken for a path or an executable target.
 */
export const APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Valid destinations RX Store will restore from a pending link (?pending=). */
export const PENDING_DESTINATION_PATTERN = /^\/app\/[a-z0-9][a-z0-9-]{0,63}$/;

export interface ParsedAppDeepLink {
  kind: 'app';
  slug: string;
}

/**
 * Parse an incoming rxstore:// URI. Returns null for anything that is not
 * EXACTLY `rxstore://app/{valid-slug}` (optionally with a trailing slash).
 * The scheme comparison is case-insensitive (RFC 3986); everything else must
 * match the canonical shape precisely.
 */
export function parseDeepLink(uri: unknown): ParsedAppDeepLink | null {
  if (typeof uri !== 'string') return null;
  const trimmed = uri.trim();
  if (!trimmed || trimmed.length > 512) return null;

  // Split scheme from the rest. Only the canonical scheme is accepted.
  const sep = trimmed.indexOf(':');
  if (sep <= 0) return null;
  const scheme = trimmed.slice(0, sep).toLowerCase();
  if (scheme !== RXSTORE_SCHEME) return null; // javascript:, file:, data:, https:… all rejected here

  // Opaque (scheme:foo) or empty authority — require "rxstore://" form.
  let rest = trimmed.slice(sep + 1);
  if (!rest.startsWith('//')) return null;
  rest = rest.slice(2);

  // Strip a single optional trailing slash, then split host/path.
  if (rest.endsWith('/')) rest = rest.slice(0, -1);
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash + 1);

  if (host !== 'app') return null;          // only rxstore://app/... exists today
  if (path.includes('/')) return null;      // exactly one path segment
  if (path.includes('?') || path.includes('#')) return null; // no query/fragment
  if (!APP_SLUG_PATTERN.test(path)) return null;

  return { kind: 'app', slug: path };
}

/** URL-encode a slug safely for both link formats. */
export function encodeSlug(slug: string): string {
  return encodeURIComponent(String(slug || ''));
}

/** Build rxstore://app/{slug}. The slug is validated — never interpolated raw. */
export function buildDeepLink(slug: string): string | null {
  if (!APP_SLUG_PATTERN.test(String(slug || ''))) return null;
  return `${RXSTORE_SCHEME}://app/${encodeSlug(slug)}`;
}

/** Build the HTTPS web fallback {webBase}/app/{slug} (works without RX Store). */
export function buildStoreUrl(webBaseUrl: string, slug: string): string | null {
  if (!APP_SLUG_PATTERN.test(String(slug || ''))) return null;
  const base = String(webBaseUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base)) return null;
  return `${base}/app/${encodeSlug(slug)}`;
}

/**
 * A safe in-app destination for the pending/continuation flow. Only
 * /app/{slug} is ever accepted — this is what `?pending=` may carry and what
 * gets restored after RX Store is installed/launched.
 */
export function validatePendingDestination(dest: unknown): string | null {
  if (typeof dest !== 'string') return null;
  const trimmed = dest.trim();
  if (trimmed.length > 100) return null;
  return PENDING_DESTINATION_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Extract a rxstore:// link from a process argv array (Electron cold start on
 * Windows/Linux and the `second-instance` event payload). Returns the first
 * well-formed link — argv can contain anything; nothing is executed.
 */
export function extractDeepLinkFromArgv(argv: readonly string[]): string | null {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    const candidate = arg.trim();
    if (/^rxstore:\/\//i.test(candidate) && parseDeepLink(candidate)) return candidate;
  }
  return null;
}

/** sessionStorage key + TTL for the short-lived pending destination. */
export const PENDING_DEST_KEY = 'rx-pending-dest';
export const PENDING_DEST_TTL_MS = 15 * 60 * 1000; // 15 minutes — deliberately short-lived
