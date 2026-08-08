/**
 * CORS Middleware — allow RX Store Pages + local dev.
 */
export async function corsMiddleware(request: Request) {
  const origin = request.headers.get('Origin') || '';

  const isAllowed =
    !origin ||
    origin === 'null' ||
    origin.includes('rx-store-web.pages.dev') ||
    origin.endsWith('.rx-store-web.pages.dev') ||
    origin.endsWith('.pages.dev') ||
    origin.includes('localhost:') ||
    origin.endsWith('rxstore.com');

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': isAllowed ? origin || '*' : '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  return null;
}

export function corsHeaders(origin: string) {
  const isAllowed =
    !origin ||
    origin.includes('rx-store-web.pages.dev') ||
    origin.endsWith('.pages.dev') ||
    origin.includes('localhost:') ||
    origin.endsWith('rxstore.com');
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin || '*' : '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}
