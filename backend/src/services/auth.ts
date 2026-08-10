/** Authentication primitives for Cloudflare Workers (Web Crypto, no Node dependency). */

export async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password + 'rx-store-salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computedHash = await hashPassword(password);
  return computedHash === hash;
}

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function decodePart(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
}
async function signingKey(secret: string) {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signToken(payload: any, secret: string, lifetimeSeconds: number): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + lifetimeSeconds }));
  const input = `${header}.${body}`;
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(secret), new TextEncoder().encode(input)));
  return `${input}.${b64url(signature)}`;
}

// One-day access token keeps installed apps usable; the signature and expiry are enforced.
export const generateToken = (payload: any, secret: string) => signToken(payload, secret, 24 * 60 * 60);
export const generateRefreshToken = (payload: any, secret: string) => signToken({ ...payload, type: 'refresh' }, secret, 7 * 24 * 60 * 60);

export async function verifyToken(token: string, secret: string): Promise<any> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const sigBinary = decodePart(parts[2]);
  const signature = Uint8Array.from(sigBinary, c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', await signingKey(secret), signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error('Invalid signature');
  const payload = JSON.parse(decodePart(parts[1]));
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return payload;
}
