/**
 * Authentication primitives for Cloudflare Workers (Web Crypto, no Node dependency).
 *
 * JWT hardening:
 *   - only HS256 is accepted (the `alg` header is verified, never trusted)
 *   - `iss` (issuer) and `aud` (audience) are validated
 *   - `tokenType` distinguishes access vs refresh tokens, so a refresh token
 *     cannot be replayed as an access token and vice-versa
 *   - `exp` is enforced; `iat`/`jti` are included for traceability
 *
 * Password hashing lives in ./password (Argon2id/bcrypt are unavailable in the
 * Workers runtime; see that module for the rationale).
 */
export { hashPassword, verifyPassword, needsRehash } from './password.ts';

const ISSUER = 'rx-store-api';
const AUDIENCE = 'rx-store';
const ALG = 'HS256';

export type TokenType = 'access' | 'refresh';

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

async function signToken(payload: any, secret: string, lifetimeSeconds: number, type: TokenType): Promise<string> {
  const header = b64url(JSON.stringify({ alg: ALG, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({
    ...payload,
    iss: ISSUER,
    aud: AUDIENCE,
    tokenType: type,
    iat: now,
    jti: payload?.jti || crypto.randomUUID(),
    exp: now + lifetimeSeconds,
  }));
  const input = `${header}.${body}`;
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(secret), new TextEncoder().encode(input)));
  return `${input}.${b64url(signature)}`;
}

export const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;      // 1 day
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export const generateToken = (payload: any, secret: string) => signToken(payload, secret, ACCESS_TOKEN_TTL_SECONDS, 'access');
export const generateRefreshToken = (payload: any, secret: string) => signToken(payload, secret, REFRESH_TOKEN_TTL_SECONDS, 'refresh');

/** Verify a token and (optionally) assert its type. Throws a coded error on failure. */
async function verifyJwt(token: string, secret: string, expectedType?: TokenType): Promise<any> {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('MALFORMED');
  // Reject any algorithm other than HS256 — never trust the header blindly.
  let header: any;
  try { header = JSON.parse(decodePart(parts[0])); } catch { throw new Error('MALFORMED'); }
  if (header?.alg !== ALG) throw new Error('BAD_ALG');
  if (header?.typ && header.typ !== 'JWT') throw new Error('BAD_TYP');

  let signature: Uint8Array;
  try { signature = Uint8Array.from(decodePart(parts[2]), (c) => c.charCodeAt(0)); } catch { throw new Error('MALFORMED'); }
  const valid = await crypto.subtle.verify('HMAC', await signingKey(secret), signature as unknown as BufferSource, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error('INVALID_SIGNATURE');

  let payload: any;
  try { payload = JSON.parse(decodePart(parts[1])); } catch { throw new Error('MALFORMED'); }
  // `aud` may be a string or array; `iss` must match exactly.
  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(AUDIENCE) : aud === AUDIENCE;
  if (!audOk) throw new Error('BAD_AUDIENCE');
  if (payload.iss !== ISSUER) throw new Error('BAD_ISSUER');
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) throw new Error('EXPIRED');
  if (expectedType && payload.tokenType && payload.tokenType !== expectedType) throw new Error('WRONG_TYPE');
  return payload;
}

/** Verify only an access token (used by the auth middleware). */
export const verifyAccessToken = (token: string, secret: string) => verifyJwt(token, secret, 'access');
/** Verify only a refresh token. */
export const verifyRefreshToken = (token: string, secret: string) => verifyJwt(token, secret, 'refresh');

/**
 * Backwards-compatible alias. Historically `verifyToken` accepted any signed
 * token; callers used it to authenticate requests. It now verifies an ACCESS
 * token specifically, so a refresh token can no longer be replayed as an access
 * credential on protected routes.
 */
export const verifyToken = (token: string, secret: string) => verifyAccessToken(token, secret);
