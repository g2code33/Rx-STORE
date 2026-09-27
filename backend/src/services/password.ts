/**
 * RX Store — password hashing.
 *
 * History: the original implementation used a single unsalted-round SHA-256 with
 * a STATIC application salt — unsuitable for passwords. This module replaces it
 * with a versioned, per-user-salted, deliberately slow KDF and keeps backwards
 * compatibility so existing users are never locked out.
 *
 * RUNTIME CONSTRAINT (CRITICAL — this broke EVERY sign-up in production once):
 *   Cloudflare Workers cannot run native modules, so `argon2` and native
 *   `bcrypt` bindings are unavailable, and pure-JS bcrypt at a sane cost
 *   exceeds the Worker CPU budget. The strongest KDF available in the Workers
 *   WebCrypto runtime is **PBKDF2-HMAC-SHA256** — BUT the runtime (workerd)
 *   hard-caps it at **100 000 iterations per deriveBits() call** and THROWS
 *   `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *   supported` above that. OWASP recommends >= 600 000 iterations for
 *   PBKDF2-SHA256; asking for that on Workers 500s every register / password
 *   reset / set-password request. Node and `wrangler dev` do NOT enforce the
 *   cap, which is exactly why the test suite stayed green (682/682) while
 *   production sign-up was broken — the cap is platform POLICY, not API
 *   surface, and local emulation does not reproduce it. It is therefore:
 *     - pinned by unit tests that SIMULATE the capped runtime
 *       (backend/src/passwordPolicy.test.ts), and
 *     - verified against production by a live probe
 *       (scripts/probe-live-signup.mjs, .github/workflows/probe-signup.yml).
 *   The stored format is self-describing (`pbkdf2$sha256$<iterations>$…`), so
 *   if workerd ever raises the ceiling, PBKDF2_ITERATIONS can be raised with
 *   it and `needsRehash` transparently upgrades existing hashes on login.
 *
 * Stored formats:
 *   pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>   (current)
 *   <64 hex chars>                                    (legacy static-salt SHA-256)
 */

/**
 * The workerd hard ceiling. NEVER request more iterations than this — the
 * runtime refuses the call outright (this is not a performance cliff, it is
 * a hard policy error).
 */
export const PBKDF2_MAX_ITERATIONS = 100_000;

/** Work factor for NEW hashes. Capped at the runtime ceiling above. */
const PBKDF2_ITERATIONS = 100_000;

/** Adaptive-hashing floor: if a future runtime refuses even this, we fail loudly. */
const PBKDF2_MIN_ITERATIONS = 10_000;

const SALT_BYTES = 16;
const KEY_BITS = 256;
const LEGACY_STATIC_SALT = 'rx-store-salt';

/** Whether an error looks like a runtime iteration-policy refusal (workerd). */
function isIterationPolicyError(e: any): boolean {
  return Boolean(e) && (e?.name === 'NotSupportedError' || /iteration/i.test(String(e?.message || e)));
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison (avoids early-exit timing leaks). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const A = new TextEncoder().encode(a);
  const B = new TextEncoder().encode(b);
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Legacy static-salt SHA-256 (kept ONLY to verify + upgrade existing hashes). */
export async function legacySha256(password: string): Promise<string> {
  const data = new TextEncoder().encode(password + LEGACY_STATIC_SALT);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

/** Hash a password with the current scheme (PBKDF2-HMAC-SHA256, per-user salt). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  // Never ask the runtime for more than its documented ceiling, and never let
  // an iteration-policy refusal 500 an auth endpoint: halve the cost and
  // retry, recording the count ACTUALLY used in the self-describing hash so
  // verification (which replays the stored count) always agrees.
  let iterations = Math.min(PBKDF2_ITERATIONS, PBKDF2_MAX_ITERATIONS);
  for (;;) {
    try {
      const hash = await pbkdf2(password, salt, iterations);
      return `pbkdf2$sha256$${iterations}$${toB64(salt)}$${toB64(hash)}`;
    } catch (e: any) {
      if (isIterationPolicyError(e) && iterations > PBKDF2_MIN_ITERATIONS) {
        iterations = Math.max(PBKDF2_MIN_ITERATIONS, Math.floor(iterations / 2));
        continue;
      }
      throw e;
    }
  }
}

/** True when a stored hash uses the legacy static-salt SHA-256 format. */
export function isLegacyHash(stored: string): boolean {
  return /^[a-f0-9]{64}$/i.test(String(stored || ''));
}

/** True when a stored hash uses the current PBKDF2 format. */
export function isCurrentHash(stored: string): boolean {
  return String(stored || '').startsWith('pbkdf2$sha256$');
}

/**
 * Verify a password against a stored hash, supporting both the current PBKDF2
 * format and the legacy static-salt SHA-256 (so existing users can still sign in).
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const hash = String(stored || '');
  if (!hash) return false;

  if (isCurrentHash(hash)) {
    const parts = hash.split('$');
    // pbkdf2$sha256$<iterations>$<salt>$<digest>
    if (parts.length !== 5) return false;
    const iterations = parseInt(parts[2], 10);
    if (!iterations || iterations < 1) return false;
    // A stored cost above the runtime ceiling can never be derived on Workers
    // (deriveBits throws before doing any work). Fail CLOSED — "wrong
    // password" — instead of letting the throw surface as a 500; the account
    // is recoverable through the password-reset flow, which now works.
    if (iterations > PBKDF2_MAX_ITERATIONS) {
      console.warn('[auth] stored password hash exceeds the runtime PBKDF2 ceiling; failing closed — this account needs a password reset');
      return false;
    }
    try {
      const salt = fromB64(parts[3]);
      const expected = parts[4];
      const actual = toB64(await pbkdf2(password, salt, iterations));
      return timingSafeEqualStr(actual, expected);
    } catch {
      return false;
    }
  }

  if (isLegacyHash(hash)) {
    const computed = await legacySha256(password);
    return timingSafeEqualStr(computed, hash.toLowerCase());
  }

  return false;
}

/**
 * Whether a verified hash should be transparently re-hashed with the current
 * scheme on successful login (legacy SHA-256, or a PBKDF2 hash below the current
 * iteration count).
 */
export function needsRehash(stored: string): boolean {
  const hash = String(stored || '');
  if (!hash) return false;
  if (isLegacyHash(hash)) return true;
  if (isCurrentHash(hash)) {
    const iterations = parseInt(hash.split('$')[2] || '0', 10);
    return iterations < PBKDF2_ITERATIONS;
  }
  return true;
}

export const PASSWORD_HASH_ITERATIONS = PBKDF2_ITERATIONS;
