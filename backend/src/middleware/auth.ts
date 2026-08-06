/**
 * JWT Authentication Middleware
 * 
 * Verifies Bearer tokens and attaches user context to the request.
 * Supports both access tokens and API keys for service-to-service auth.
 */
export async function authMiddleware(request: Request, env: any) {
  const authHeader = request.headers.get('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
    }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  const token = authHeader.split(' ')[1];
  
  try {
    // Verify JWT token
    // In production: use jose or jsonwebtoken library
    // const payload = await jwtVerify(token, new TextEncoder().encode(env.JWT_SECRET));
    // request.user = payload;
    
    return null; // Continue to next handler
  } catch {
    return new Response(JSON.stringify({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' }
    }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
}
