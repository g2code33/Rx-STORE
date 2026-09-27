/**
 * Password policy tests — the production PBKDF2 iteration cap.
 *
 * WHY THIS FILE EXISTS (production incident, 2026-09-27):
 *   Sign-up (and every password reset / set-password path) returned
 *   500 INTERNAL in PRODUCTION while the entire test suite was green.
 *   Root cause: the Cloudflare Workers runtime (workerd) hard-caps PBKDF2 at
 *   100 000 iterations per crypto.subtle.deriveBits() call and throws
 *   `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *   supported (requested 600000)`. The password module asked for 600 000 (the
 *   OWASP recommendation). Node and `wrangler dev` do NOT enforce the cap, so
 *   every local test passed — the cap is platform policy, not API surface.
 *
 * These tests simulate the capped runtime FAITHFULLY (a WebCrypto whose
 * deriveBits refuses iteration counts above a ceiling, exactly like workerd)
 * and pin the module's behaviour under it:
 *   - the configured work factor never exceeds the runtime ceiling
 *   - hashPassword succeeds under the capped runtime and stores a
 *     self-describing, at-or-below-ceiling iteration count
 *   - verifyPassword round-trips under the capped runtime
 *   - an over-cap REQUEST throws under the simulated runtime (this is the
 *     production failure mode — proving the simulation reproduces the incident)
 *   - an over-cap STORED hash fails closed (wrong password) instead of 500ing
 *   - hashPassword adapts if a future runtime lowers the ceiling further
 *   - legacy static-salt SHA-256 hashes still verify and flag for rehash
 *
 * Run: node --experimental-strip-types --test backend/src/passwordPolicy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword,
  verifyPassword,
  needsRehash,
  isCurrentHash,
  isLegacyHash,
  legacySha256,
  PASSWORD_HASH_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
} from './services/password.ts';

/**
 * Install a WebCrypto whose deriveBits refuses PBKDF2 iteration counts above
 * `cap` — the exact workerd behaviour (same error name and message shape).
 * Everything else delegates to the real Node WebCrypto.
 */
function withCappedPbkdf2<T>(cap: number, fn: () => Promise<T>): Promise<T> {
  const realSubtle = crypto.subtle;
  // Re-bind every real SubtleCrypto method as an OWN property bound to the
  // real object (native methods brand-check `this`), then override only
  // deriveBits with the workerd-style policy check. Node's `crypto.subtle` is
  // a prototype getter — an own property on the instance cleanly shadows it
  // and is removed afterwards.
  const fake: any = {};
  const proto = Object.getPrototypeOf(realSubtle);
  for (const name of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (d && typeof d.value === 'function' && name !== 'deriveBits') {
      fake[name] = (d.value as any).bind(realSubtle);
    }
  }
  fake.deriveBits = async (algorithm: any, key: any, length?: number) => {
    const iters = Number(algorithm?.iterations ?? 0);
    if (String(algorithm?.name) === 'PBKDF2' && iters > cap) {
      throw new DOMException(
        `Pbkdf2 failed: iteration counts above ${cap} are not supported (requested ${iters}).`,
        'NotSupportedError',
      );
    }
    return realSubtle.deriveBits(algorithm, key, length);
  };
  const hadOwn = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  Object.defineProperty(globalThis.crypto, 'subtle', { value: fake, configurable: true });
  return fn().finally(() => {
    if (hadOwn) Object.defineProperty(globalThis.crypto, 'subtle', hadOwn);
    else delete (globalThis.crypto as any).subtle;
  });
}

test('the configured password work factor never exceeds the Workers runtime ceiling', () => {
  assert.ok(PBKDF2_MAX_ITERATIONS === 100_000, 'workerd caps PBKDF2 at 100000 iterations');
  assert.ok(PASSWORD_HASH_ITERATIONS <= PBKDF2_MAX_ITERATIONS,
    `PBKDF2_ITERATIONS (${PASSWORD_HASH_ITERATIONS}) must stay <= the runtime ceiling (${PBKDF2_MAX_ITERATIONS}), or every register/reset 500s in production`);
});

test('the simulation reproduces the production incident: an over-cap request throws', async () => {
  await withCappedPbkdf2(100_000, async () => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('x'), 'PBKDF2', false, ['deriveBits']);
    await assert.rejects(
      crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations: 600_000 }, key, 256),
      (e: any) => e?.name === 'NotSupportedError' && /iteration counts above 100000/.test(String(e?.message)),
      'if this fails the simulation no longer models workerd — fix the simulation, not the code',
    );
  });
});

test('hashPassword works under the capped runtime and stores an at-or-below-ceiling cost', async () => {
  const stored = await withCappedPbkdf2(100_000, () => hashPassword('Sup3rSecret!'));
  assert.ok(isCurrentHash(stored), `expected pbkdf2 format, got: ${stored.slice(0, 40)}…`);
  const iterations = parseInt(stored.split('$')[2], 10);
  assert.ok(iterations > 0 && iterations <= 100_000, `stored iterations ${iterations} must be within the runtime ceiling`);
});

test('verifyPassword round-trips under the capped runtime', async () => {
  const stored = await withCappedPbkdf2(100_000, () => hashPassword('Sup3rSecret!'));
  const ok = await withCappedPbkdf2(100_000, () => verifyPassword('Sup3rSecret!', stored));
  assert.equal(ok, true, 'the just-hashed password must verify under the capped runtime');
  const bad = await withCappedPbkdf2(100_000, () => verifyPassword('WrongPassword1!', stored));
  assert.equal(bad, false);
});

test('a stored hash above the ceiling fails CLOSED (wrong password), never a 500', async () => {
  // A legacy over-cap record (cannot exist today — register always failed —
  // but the guard must hold anyway). Build a syntactically valid hash with an
  // impossible cost; verification must return false, not throw.
  const saltB64 = btoa('0123456789abcdef');
  const digestB64 = btoa('fedcba9876543210');
  const overCap = `pbkdf2$sha256$600000$${saltB64}$${digestB64}`;
  const result = await withCappedPbkdf2(100_000, () => verifyPassword('anything123', overCap));
  assert.equal(result, false, 'over-cap stored hash must fail closed, not throw');
});

test('hashPassword adapts if a future runtime lowers the ceiling below ours', async () => {
  // Simulate a stricter runtime (cap 25 000): hashing must still succeed and
  // record the count it actually used, and that hash must then verify.
  const stored = await withCappedPbkdf2(25_000, () => hashPassword('AdaptivePass1!'));
  assert.ok(isCurrentHash(stored));
  const iterations = parseInt(stored.split('$')[2], 10);
  assert.ok(iterations > 0 && iterations <= 25_000, `adapted iterations ${iterations} must respect the stricter cap`);
  const ok = await withCappedPbkdf2(25_000, () => verifyPassword('AdaptivePass1!', stored));
  assert.equal(ok, true);
});

test('legacy static-salt SHA-256 hashes still verify and request a rehash', async () => {
  const legacy = await legacySha256('OldPass123!');
  assert.ok(isLegacyHash(legacy));
  assert.equal(await verifyPassword('OldPass123!', legacy), true);
  assert.equal(await verifyPassword('WrongPass123!', legacy), false);
  assert.equal(needsRehash(legacy), true, 'legacy hashes must be upgraded on next successful login');
});

test('needsRehash upgrades below-cost pbkdf2 hashes and leaves current ones alone', async () => {
  const stored = await hashPassword('Sup3rSecret!');
  assert.equal(needsRehash(stored), false, 'a hash at the current cost must not be rehashed every login');
  const [scheme, algo, , salt, digest] = stored.split('$');
  const cheap = [scheme, algo, 50_000, salt, digest].join('$');
  assert.equal(needsRehash(cheap), true, 'a below-cost hash must be transparently upgraded on login');
});

test('the auth register route can hash under the capped runtime (route-level regression)', async () => {
  // Drive the REAL route handler (not just the KDF) under the simulated
  // production runtime, so the incident cannot recur silently.
  const { authRoutes } = await import('./routes/auth.ts');
  const inserted: any[] = [];
  const env: any = {
    DB: {
      prepare(sql: string) {
        return {
          _binds: [] as any[],
          bind(...args: any[]) { this._binds = args; return this; },
          async first() { return null; },
          async run() { inserted.push({ sql, binds: (this as any)._binds }); return {}; },
          async all() { return { results: [] }; },
        };
      },
    },
    JWT_SECRET: 'test-secret-for-route-regression',
  };
  const request = new Request('https://api.example.com/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Probe User', email: 'probe@example.com', password: 'ProbePass123!' }),
  });
  const out = await withCappedPbkdf2(100_000, () => authRoutes.register(request as any, env));
  assert.ok(!out?.code && !out?.error, `register must succeed under the capped runtime, got: ${JSON.stringify(out).slice(0, 200)}`);
  assert.ok(out?.token, 'register must return a session token');
  const insert = inserted.find((i) => i.sql.includes('INSERT INTO users'));
  assert.ok(insert, 'the user row must be inserted');
  const storedHash = String(insert.binds[4] ?? '');
  assert.ok(isCurrentHash(storedHash), `stored hash must be pbkdf2 format, got: ${storedHash.slice(0, 40)}…`);
});
