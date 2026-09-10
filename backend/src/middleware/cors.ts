/**
 * CORS — explicit allowlist only.
 *
 * SECURITY: the previous implementation used substring/suffix checks
 * (`origin.endsWith('rxstore.com')`, `origin.includes('localhost')`,
 * `origin.endsWith('.pages.dev')`). Those can be satisfied by attacker-controlled
 * origins (e.g. `evilrxstore.com`, `localhost.evil.com`, `attacker.pages.dev`)
 * and effectively reflected an arbitrary Origin with credentials enabled — a
 * serious CORS misconfiguration.
 *
 * This version matches the Origin against an EXPLICIT allowlist:
 *   - fixed first-party origins (prod RX Store web/desktop/Android shells)
 *   - the configured `CORS_ALLOWED_ORIGINS` (comma-separated, env/wrangler var)
 *   - localhost / 127.0.0.1 dev origins ONLY when not running in production
 *     (or when explicitly added to the allowlist for staging)
 *
 * Non-matching origins are NOT reflected: the request may still be served, but
 * without an `Access-Control-Allow-Origin` header the browser blocks the
 * credentialed read. Native shells send `Origin: app://…` / `capacitor://…`
 * which are matched exactly, not by substring.
 */

/** First-party origins that are always allowed. */
const FIRST_PARTY_ORIGINS = [
  'https://rxstore.com',
  'https://www.rxstore.com',
  'https://api.rxstore.com',
  // Electron desktop shell uses a privileged custom scheme.
  'app://rxstore',
  // Capacitor Android/iOS WebView origins.
  'https://localhost',
  'capacitor://localhost',
  'http://localhost',
];

/** Local development origins (only honored outside production). */
const DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export interface CorsConfig {
  /** Additional exact-match origins (from CORS_ALLOWED_ORIGINS). */
  allowedOrigins?: string[];
  /** The runtime environment (`production` disables the dev/localhost bypass). */
  environment?: string;
}

/** Parse the configured allowed-origins list into exact origins. */
export function parseAllowedOrigins(raw?: string | null): string[] {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildAllowlist(cfg: CorsConfig = {}): Set<string> {
  const set = new Set<string>(FIRST_PARTY_ORIGINS);
  for (const o of cfg.allowedOrigins || []) set.add(o);
  return set;
}

/** Whether an Origin is allowed. Empty origin (same-origin/native) is allowed. */
export function isOriginAllowed(origin: string, cfg: CorsConfig = {}): boolean {
  const o = String(origin || '');
  if (!o) return true; // same-origin or non-browser client
  if (o === 'null') return false; // opaque origin (sandboxed iframe / file://) — reject
  const allow = buildAllowlist(cfg);
  if (allow.has(o)) return true;
  const isProd = String(cfg.environment || '').toLowerCase() === 'production';
  if (!isProd && DEV_ORIGIN_RE.test(o)) return true;
  return false;
}

function corsHeadersFor(origin: string, cfg: CorsConfig): Record<string, string> {
  const allowed = isOriginAllowed(origin, cfg);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Id',
    'Access-Control-Expose-Headers': 'X-Request-Id',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  // Only reflect an Origin we explicitly allow. Never fall back to '*'.
  if (allowed && origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

/** Preflight handler. Returns null when the request is not an OPTIONS preflight. */
export async function corsMiddleware(request: Request, env?: any) {
  if (request.method !== 'OPTIONS') return null;
  const origin = request.headers.get('Origin') || '';
  const cfg: CorsConfig = {
    allowedOrigins: parseAllowedOrigins(env?.CORS_ALLOWED_ORIGINS),
    environment: env?.ENVIRONMENT,
  };
  // For a disallowed origin we still answer 204 but WITHOUT allow-origin, so the
  // browser blocks the actual request. (No 403 needed; that leaks nothing.)
  return new Response(null, { status: 204, headers: corsHeadersFor(origin, cfg) });
}

/** Response CORS headers for a given origin. */
export function corsHeaders(origin: string, env?: any) {
  const cfg: CorsConfig = {
    allowedOrigins: parseAllowedOrigins(env?.CORS_ALLOWED_ORIGINS),
    environment: env?.ENVIRONMENT,
  };
  return corsHeadersFor(origin, cfg);
}
