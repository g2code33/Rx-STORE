#!/usr/bin/env node
/**
 * LIVE sign-up probe — reproduces the reported "sign up is not working"
 * against the PRODUCTION API from a machine that can reach the internet
 * (GitHub Actions runner; the dev sandbox's egress is TLS-blocked).
 *
 * What it checks, in order:
 *   A. POST /auth/register with an INVALID password
 *      -> expect HTTP 400 VALIDATION_ERROR. Proves routing, CORS, the rate
 *         limiter pass-through and the settings read all work.
 *   B. POST /auth/register with a VALID new account
 *      -> expect HTTP 200 with user+token. Proves the full path including
 *         PBKDF2 hashing (600k iterations) and the D1 INSERT.
 *   C. POST /auth/login with the account created in B
 *      -> expect HTTP 200. Proves verification of a fresh 600k-iteration
 *         hash works too (the same CPU cost as B, from the login side).
 *   D. Local CPU reference: how long 600k-iteration PBKDF2 takes on
 *      comparable hardware (context for the Workers free-plan 10ms CPU cap).
 *
 * Side effect: at most ONE clearly-labelled user row
 * (`ci-signup-probe+<timestamp>@rx-store.invalid`) — safe to delete
 * (`DELETE FROM users WHERE email LIKE 'ci-signup-probe+%'`).
 *
 * Usage: node scripts/probe-live-signup.mjs
 * Env:   PROBE_API_URL  (default: production Worker /v1)
 *        PROBE_ORIGIN   (default: production web origin)
 */

const API = (process.env.PROBE_API_URL || 'https://rx-store-api.calcitoninpay.workers.dev/v1').replace(/\/$/, '');
const ORIGIN = process.env.PROBE_ORIGIN || 'https://rx-store-web.pages.dev';
const stamp = Date.now();
const email = `ci-signup-probe+${stamp}@rx-store.invalid`;
const password = 'ProbePass123!';

function log(...args) {
  console.log('[probe]', ...args);
}

async function call(label, method, path, body) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    log(`--- ${label}`);
    log(`    HTTP ${res.status} in ${ms}ms`);
    log(`    cf-ray=${res.headers.get('cf-ray') || '(none)'} allow-origin=${res.headers.get('access-control-allow-origin') || '(none)'}`);
    log(`    body: ${text.slice(0, 600)}`);
    return { status: res.status, ms, text };
  } catch (e) {
    log(`--- ${label}`);
    log(`    FETCH THREW after ${Date.now() - t0}ms: ${e?.message || e}`);
    return { status: 0, text: String(e?.message || e) };
  }
}

log(`API=${API} origin=${ORIGIN} probe-email=${email}`);

// A) invalid password -> clean 400 expected
await call('A: register INVALID password (expect 400 VALIDATION_ERROR)', 'POST', '/auth/register', {
  name: 'CI Probe',
  email,
  password: 'short',
});

// B) the real thing
const b = await call('B: register VALID new account (expect 200)', 'POST', '/auth/register', {
  name: 'CI Signup Probe (delete me)',
  email,
  password,
  deviceId: `probe-${stamp}`,
});

// C) login with the account from B (same 600k PBKDF2 cost, verify side)
if (b.status === 200) {
  await call('C: login the probe account (expect 200)', 'POST', '/auth/login', {
    email,
    password,
    deviceId: `probe-${stamp}`,
  });
} else {
  await call('C: control — login with unknown creds (expect 401)', 'POST', '/auth/login', {
    email,
    password,
  });
}

// D) CPU reference on comparable hardware
try {
  const t0 = Date.now();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: crypto.getRandomValues(new Uint8Array(16)), iterations: 600_000 },
    key,
    256,
  );
  log(`--- D: local PBKDF2-600000 took ${Date.now() - t0}ms of CPU (Workers FREE plan caps a request at 10ms)`);
} catch (e) {
  log(`--- D: local PBKDF2 reference failed: ${e?.message || e}`);
}

// probe v2: results also committed to the branch
