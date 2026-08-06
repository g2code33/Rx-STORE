/**
 * Rate Limiting Middleware
 * 
 * Implements sliding window rate limiting using KV store.
 * Different limits for public, authenticated, and admin endpoints.
 */
export async function rateLimiter(request: Request, env: any) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const path = new URL(request.url).pathname;
  
  const limits: Record<string, number> = {
    '/auth': 5,        // 5 requests/minute for auth
    '/ai': 30,         // 30 requests/minute for AI
    '/admin': 500,     // 500 requests/minute for admin
    default: 100,      // 100 requests/minute default
  };

  const endpoint = Object.keys(limits).find(k => path.startsWith(k)) || 'default';
  const maxRequests = limits[endpoint];
  const key = `ratelimit:${ip}:${endpoint}`;

  // Check KV for current count
  const current = await env.CACHE?.get(key);
  const count = current ? parseInt(current) : 0;

  if (count >= maxRequests) {
    return new Response(JSON.stringify({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' }
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '60',
        'X-RateLimit-Limit': String(maxRequests),
        'X-RateLimit-Remaining': '0',
      }
    });
  }

  // Increment counter
  await env.CACHE?.put(key, String(count + 1), { expirationTtl: 60 });
  
  return null; // Continue
}
