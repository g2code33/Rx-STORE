import { verifyToken } from '../services/auth';

/** Verify the HMAC signature + expiry and attach the authenticated payload. */
export async function authMiddleware(request: Request, env: any) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  try {
    (request as any).user = await verifyToken(authHeader.slice(7), env.JWT_SECRET);
    return null;
  } catch {
    return new Response(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
}
