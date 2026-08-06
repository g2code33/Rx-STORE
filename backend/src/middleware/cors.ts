/**
 * CORS Middleware
 * Handles Cross-Origin Resource Sharing for the API.
 */
export async function corsMiddleware(request: Request) {
  const origin = request.headers.get('Origin') || '*';
  
  const allowedOrigins = [
    'https://rxstore.com',
    'https://www.rxstore.com',
    'http://localhost:5173',
    'http://localhost:3000',
  ];

  const isAllowed = allowedOrigins.includes(origin) || origin === 'null';

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': isAllowed ? origin : '',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  return null; // Continue to next handler
}
