/**
 * Authentication Service
 */

export async function hashPassword(password: string): Promise<string> {
  // Use bcrypt in production
  // return bcrypt.hash(password, 12);
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'rx-store-salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computedHash = await hashPassword(password);
  return computedHash === hash;
}

export function generateToken(payload: any, secret: string): string {
  // Use jose library in production for proper JWT
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify({ ...payload, exp: Date.now() + 15 * 60 * 1000 }));
  return `${header}.${body}.signature`;
}

export function generateRefreshToken(payload: any, secret: string): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify({ ...payload, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }));
  return `${header}.${body}.refresh-signature`;
}
