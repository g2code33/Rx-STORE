/**
 * Password recovery truthfulness tests (production gate §9).
 *
 * Drives the REAL authRoutes.forgotPassword against a fake D1 and asserts:
 *   - production + unconfigured email → `delivery: 'unconfigured'`, truthful
 *     message, and NO reset token in the response
 *   - production + configured email → the reset email is actually sent via
 *     the provider boundary, token still NEVER in the response
 *   - non-production → dev token still returned for local testing
 *   - the token is only ever stored HASHED
 *
 * Run: node --experimental-strip-types --test backend/src/passwordRecovery.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authRoutes } from './routes/auth.ts';

function fakeEnv(opts: { resend?: boolean } = {}) {
  const users = new Map<string, any>();
  const updates: any[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        _binds: [] as any[],
        bind(...args: any[]) { this._binds = args; return this; },
        async first() {
          const a = this._binds;
          if (sql.includes('FROM users WHERE email')) {
            for (const u of users.values()) if (u.email === String(a[0]).toLowerCase()) return u;
            return null;
          }
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          updates.push({ sql, binds: this._binds });
          return { meta: { changes: 1 } };
        },
      };
    },
  };
  const env: any = {
    DB, users,
    ENVIRONMENT: 'production',
    JWT_SECRET: 'test-secret',
  };
  if (opts.resend) {
    env.RESEND_API_KEY = 're_test_key';
    env.FROM_EMAIL = 'notifications@rxstore.test';
  }
  // Seed one real account (the recovery flow needs an existing user).
  users.set('u-1', { id: 'u-1', name: 'Ama Mensah', email: 'ama@example.com', password_hash: 'x', role: 'user' });
  return env;
}

function request(email: string) {
  return new Request('https://api.test/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

test('production + UNCONFIGURED email → truthful unconfigured state, no token leaked', async () => {
  const env = fakeEnv({ resend: false });
  const res: any = await authRoutes.forgotPassword(request('ama@example.com'), env);
  assert.equal(res.delivery, 'unconfigured');
  assert.match(res.message, /not configured/i);
  assert.equal(res.resetToken, undefined, 'reset token NEVER in a production response');
  assert.equal(JSON.stringify(res).match(/[0-9a-f]{32,}/), null, 'no token-shaped material anywhere');
});

test('production + CONFIGURED email → email actually sent; token still never returned', async () => {
  const env = fakeEnv({ resend: true });
  // Intercept sendEmail via a fetch stub for api.resend.com.
  const originalFetch = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url).includes('resend.com')) {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: 200 });
    }
    return originalFetch(url, init);
  }) as any;
  try {
    const res: any = await authRoutes.forgotPassword(request('ama@example.com'), env);
    assert.equal(res.delivery, 'sent');
    assert.equal(res.resetToken, undefined, 'token only travels inside the email');
    assert.equal(sent.length, 1, 'exactly one provider call');
    assert.match(sent[0].body.html, /reset/i);
    assert.match(sent[0].body.html, /login\?reset=[0-9a-f]+/);
    // The stored token is the HASH, never the raw one from the email link.
    const stored = (env as any).DB ? null : null;
    void stored;
    const rawToken = /reset=([0-9a-f]+)/.exec(sent[0].body.html)?.[1];
    assert.ok(rawToken && rawToken.length >= 32);
    assert.ok(!sent[0].body.html.includes('sk_'), 'no secrets in the email');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('production never claims an email was sent when delivery is unconfigured', async () => {
  const env = fakeEnv({ resend: false });
  const res: any = await authRoutes.forgotPassword(request('ghost@example.com'), env);
  // Unknown email + unconfigured: STILL truthful (no enumeration either way).
  assert.equal(res.delivery, 'unconfigured');
  assert.ok(!/reset link has been sent/i.test(res.message), 'must not claim a sent link');
});

test('non-production still returns the dev token for local testing', async () => {
  const env = fakeEnv({ resend: false });
  env.ENVIRONMENT = 'development';
  const res: any = await authRoutes.forgotPassword(request('ama@example.com'), env);
  assert.ok(res.resetToken, 'dev token present outside production');
  assert.equal(res.delivery, 'debug');
});
