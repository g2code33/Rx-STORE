/**
 * Rate limiting — a REAL sliding window over KV.
 *
 * The previous implementation was a fixed-window counter (single KV key with a
 * 60s TTL) that the docs described as "sliding window". This version stores the
 * request timestamps of the current window in KV and counts only those within
 * the trailing window, which is a genuine sliding window (bursts at a window
 * boundary are no longer doubled).
 *
 * Limits are per-route-group and per-identity (authenticated user id when
 * available, else client IP). Auth-sensitive routes are intentionally strict;
 * ordinary browsing is generous so the storefront stays usable.
 */
import { apiErrorBody, statusForCode } from '../services/errors.ts';

export interface RateLimitRule {
  /** Requests allowed within the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/** Per-route-group rules. Order matters — first matching prefix wins. */
export const RATE_LIMIT_RULES: Array<{ prefix: string; rule: RateLimitRule }> = [
  { prefix: '/auth/login', rule: { limit: 10, windowSeconds: 60 } },
  { prefix: '/auth/register', rule: { limit: 5, windowSeconds: 300 } },
  { prefix: '/auth/forgot-password', rule: { limit: 5, windowSeconds: 900 } },
  { prefix: '/auth/reset-password', rule: { limit: 10, windowSeconds: 900 } },
  { prefix: '/auth/refresh', rule: { limit: 60, windowSeconds: 60 } },
  { prefix: '/auth', rule: { limit: 20, windowSeconds: 60 } },
  { prefix: '/devices/register', rule: { limit: 30, windowSeconds: 300 } },
  { prefix: '/devices', rule: { limit: 120, windowSeconds: 60 } },
  { prefix: '/admin', rule: { limit: 500, windowSeconds: 60 } },
  { prefix: '/ai', rule: { limit: 30, windowSeconds: 60 } },
  { prefix: '/apps', rule: { limit: 300, windowSeconds: 60 } },
  { prefix: '/payments', rule: { limit: 20, windowSeconds: 60 } },
  { prefix: '/', rule: { limit: 300, windowSeconds: 60 } },
];

/** A resolved rule including the matched prefix (used for the KV key). */
export interface ResolvedRule extends RateLimitRule {
  /** The matched route prefix (stable bucket key). */
  prefix: string;
}

/** Resolve the rule for a path. */
export function ruleForPath(path: string): ResolvedRule {
  const match = RATE_LIMIT_RULES.find((r) => r.prefix === '/' || path.startsWith(r.prefix));
  if (match) return { ...match.rule, prefix: match.prefix };
  return { limit: 300, windowSeconds: 60, prefix: 'default' };
}

/** Identity for rate limiting: authenticated user id when present, else IP. */
export function rateLimitIdentity(request: Request): string {
  const userId = (request as any)?.user?.userId;
  if (userId) return `u:${userId}`;
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  return `ip:${String(ip).split(',')[0].trim()}`;
}

/**
 * Evaluate the sliding window from a list of prior timestamps.
 * Pure + unit-testable. Returns the timestamps still inside the window and
 * whether the request is allowed.
 */
export function evaluateWindow(prior: number[], now: number, rule: RateLimitRule): { allowed: boolean; remaining: number; hits: number[] } {
  const windowMs = rule.windowSeconds * 1000;
  const hits = prior.filter((t) => typeof t === 'number' && now - t < windowMs);
  const allowed = hits.length < rule.limit;
  const remaining = Math.max(0, rule.limit - hits.length - (allowed ? 1 : 0));
  return { allowed, remaining, hits };
}

export async function rateLimiter(request: Request, env: any) {
  const path = new URL(request.url).pathname;
  const rule = ruleForPath(path);
  const identity = rateLimitIdentity(request);
  const key = `ratelimit:v2:${identity}:${rule.prefix}`;
  const now = Date.now();

  // Best-effort: if KV is unavailable, allow the request (don't take the API down).
  let prior: number[] = [];
  try {
    const raw = await env?.CACHE?.get(key);
    if (raw) { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) prior = parsed.filter((n: any) => typeof n === 'number'); }
  } catch { prior = []; }

  const { allowed, remaining, hits } = evaluateWindow(prior, now, rule);

  if (!allowed) {
    const retryAfter = Math.max(1, Math.ceil(rule.windowSeconds - (now - (hits[0] ?? now)) / 1000));
    return new Response(JSON.stringify(apiErrorBody('RATE_LIMITED', 'Too many requests. Please slow down and try again shortly.')), {
      status: statusForCode('RATE_LIMITED'),
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(rule.limit),
        'X-RateLimit-Remaining': '0',
      },
    });
  }

  // Record this request inside the window.
  try {
    const next = [...hits, now];
    await env?.CACHE?.put(key, JSON.stringify(next), { expirationTtl: rule.windowSeconds + 5 });
  } catch { /* KV write failure must not break the request */ }

  return null;
}
