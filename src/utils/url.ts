/** URL helpers — pure, harness-testable. */

/**
 * Normalize a user/admin-typed website address into a safe absolute http(s)
 * URL. Accepts "example.com" (https:// is assumed). Returns '' for anything
 * that isn't a valid http(s) URL — never returns javascript:/data:/etc.
 */
export function normalizeWebsiteUrl(raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    if (!u.hostname.includes('.')) return '';
    return u.toString();
  } catch {
    return '';
  }
}
