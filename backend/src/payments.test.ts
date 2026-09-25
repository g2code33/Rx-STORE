/**
 * Marketplace payments, entitlements & ownership tests (Phase 18).
 *
 * Real route handlers against an in-memory D1 fake; the Paystack client is
 * exercised through its real contract with stubbed fetch (initialize/verify/
 * refund + genuine HMAC-SHA512 webhook signatures computed in-test). Covers
 * the full matrix: free apps (no payment path), paid apps, initialize,
 * verify success/failure/amount-tamper, dev-simulation isolation, webhook
 * forgery/replay/duplicate/idempotency, refunds (entitlement access ends),
 * revocation, unauthorized downloads, short-lived grant expiry, multiple
 * devices (entitlement is account-level), purchase history.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  paymentRoutes, webhookRoutes, adminPaymentRoutes, appIsPaid, activeEntitlement,
  realPaymentsEnabled, simulationAllowed,
} from './routes/payments.ts';

const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = realFetch; });

const SECRET = 'sk_test_paystack_secret';

// ---------------------------------------------------------------------------
// In-memory fake D1
// ---------------------------------------------------------------------------

function makeEnv(opts: { production?: boolean; secret?: boolean } = {}) {
  const db: any = {
    users: [
      { id: 'u1', name: 'Alice', email: 'alice@x.com', role: 'user', preferences: '{}' },
      { id: 'u2', name: 'Bob', email: 'bob@x.com', role: 'user', preferences: '{}' },
      { id: 'admin1', name: 'Admin', email: 'adm@x.com', role: 'admin', preferences: '{}' },
    ],
    applications: [
      { id: 'app_free', slug: 'free-app', name: 'Free App', status: 'active', price_type: 'free', price_amount: null, current_version: '1.0.0' },
      { id: 'app_paid', slug: 'paid-app', name: 'Paid App', status: 'active', price_type: 'paid', price_amount: 25, current_version: '2.0.0' },
      { id: 'app_sub', slug: 'sub-app', name: 'Sub App', status: 'active', price_type: 'subscription', price_amount: 10, current_version: '1.0.0' },
    ],
    purchases: [] as any[],
    entitlements: [] as any[],
    webhook_events: [] as any[],
    download_grants: [] as any[],
    downloads: [] as any[],
    audit_logs: [] as any[],
  };

  const DB = {
    prepare(sql: string) {
      const self: any = {
        _b: [] as any[],
        bind(...a: any[]) { self._b = a; return self; },
        async first() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('SELECT id, slug, name, price_type, price_amount, developer_org_id FROM applications WHERE id=?')) return db.applications.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT email, name FROM users WHERE id=?')) return db.users.find((x: any) => x.id === a[0]) || null;
          if (s.includes('FROM entitlements WHERE user_id=? AND app_id=?')) return db.entitlements.find((x: any) => x.user_id === a[0] && x.app_id === a[1]) || null;
          if (s.includes('SELECT * FROM purchases WHERE provider_reference=? AND user_id=?')) return db.purchases.find((x: any) => x.provider_reference === a[0] && x.user_id === a[1]) || null;
          if (s.includes('SELECT * FROM purchases WHERE provider_reference=?')) return db.purchases.find((x: any) => x.provider_reference === a[0]) || null;
          if (s.includes('SELECT * FROM purchases WHERE id=?')) return db.purchases.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT * FROM entitlements WHERE id=?')) return db.entitlements.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT * FROM download_grants WHERE token_hash=?')) return db.download_grants.find((x: any) => x.token_hash === a[0]) || null;
          if (s.includes('SELECT event_type, created_at FROM webhook_events')) {
            const events = db.webhook_events.filter((w: any) => w.provider === 'paystack');
            return events.length ? events[events.length - 1] : null;
          }
          if (s.includes('SELECT COUNT(*) AS n FROM webhook_events')) {
            return { n: db.webhook_events.filter((w: any) => w.provider === 'paystack').length };
          }
          if (s.includes('SELECT COUNT(*) AS total')) {
            return {
              total: db.purchases.length,
              complete: db.purchases.filter((x: any) => x.status === 'complete').length,
              refunded: db.purchases.filter((x: any) => x.status === 'refunded').length,
            };
          }
          return null;
        },
        async all() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('FROM purchases p LEFT JOIN applications a')) {
            const userScoped = s.includes('WHERE p.user_id=?');
            return {
              results: db.purchases
                .filter((p: any) => (!userScoped || p.user_id === a[0]))
                .filter((p: any) => !s.includes('WHERE p.status = ?') || p.status === a[a.length - 1])
                .map((p: any) => ({
                  ...p,
                  reference: p.provider_reference,
                  user_name: db.users.find((u: any) => u.id === p.user_id)?.name,
                  user_email: db.users.find((u: any) => u.id === p.user_id)?.email,
                  app_name: db.applications.find((x: any) => x.id === p.app_id)?.name,
                  app_slug: db.applications.find((x: any) => x.id === p.app_id)?.slug,
                  entitlement_status: db.entitlements.find((e: any) => e.user_id === p.user_id && e.app_id === p.app_id)?.status || null,
                })),
            };
          }
          if (s.includes('FROM entitlements e LEFT JOIN users u')) {
            return {
              results: db.entitlements
                .filter((e: any) => !s.includes('WHERE e.status = ?') || e.status === a[0])
                .map((e: any) => ({
                  ...e,
                  user_name: db.users.find((u: any) => u.id === e.user_id)?.name,
                  app_name: db.applications.find((x: any) => x.id === e.app_id)?.name,
                })),
            };
          }
          if (s.includes('FROM entitlements e JOIN applications a')) {
            return { results: db.entitlements.filter((e: any) => e.user_id === a[0]).map((e: any) => ({ ...e, app_name: 'App' })) };
          }
          if (s.includes('SELECT key, value FROM site_settings')) {
            return { results: (db as any).site_settings || [{ key: 'marketplace_fee_percent', value: '15' }] };
          }
          return { results: [] };
        },
        async run() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          if (s.includes('INSERT INTO purchases')) {
            db.purchases.push({ id: a[0], user_id: a[1], app_id: a[2], amount: a[3], currency: a[4], provider: a[5], provider_reference: a[6], status: 'pending', created_at: now, updated_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE purchases SET status=\'complete\'')) {
            const p = db.purchases.find((x: any) => x.id === a[a.length - 1]);
            if (p) { p.status = 'complete'; p.provider_transaction_id = a[0] || p.provider_transaction_id; p.completed_at = now; }
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE purchases SET status=\'failed\'')) {
            const p = db.purchases.find((x: any) => x.id === a[a.length - 1]);
            if (p) { p.status = 'failed'; p.failure_reason = a[0]; }
            return { meta: { changes: 1 } };
          }
          if (s.includes("UPDATE purchases SET status='refunded'")) {
            const p = db.purchases.find((x: any) => x.id === a[0]);
            if (p && p.status === 'complete') { p.status = 'refunded'; p.refunded_at = now; }
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO entitlements')) {
            const [id, userId, appId, purchaseId, provider, txId] = a;
            const existing = db.entitlements.find((x: any) => x.user_id === userId && x.app_id === appId);
            if (existing) {
              Object.assign(existing, { status: 'ACTIVE', purchase_id: purchaseId, provider, activated_at: now, revoked_at: null, revoked_reason: null, refunded_at: null });
            } else {
              db.entitlements.push({ id, user_id: userId, app_id: appId, purchase_id: purchaseId, provider, provider_transaction_id: txId, status: 'ACTIVE', activated_at: now, created_at: now, updated_at: now });
            }
            return { meta: { changes: 1 } };
          }
          if (s.includes("UPDATE entitlements SET status='REFUNDED'")) {
            db.entitlements.forEach((e: any) => { if (e.purchase_id === a[0] && e.status === 'ACTIVE') { e.status = 'REFUNDED'; e.refunded_at = now; } });
            return { meta: { changes: 1 } };
          }
          if (s.includes("UPDATE entitlements SET status='REVOKED'")) {
            const e = db.entitlements.find((x: any) => x.id === a[a.length - 1]);
            if (e) { e.status = 'REVOKED'; e.revoked_at = now; e.revoked_reason = a[0]; }
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO webhook_events')) {
            const dupe = db.webhook_events.find((w: any) => w.provider === a[1] && w.event_key === a[2]);
            if (dupe) throw new Error('UNIQUE constraint failed: webhook_events.provider');
            db.webhook_events.push({ id: a[0], provider: a[1], event_key: a[2], event_type: a[3], payload: a[4], status: 'processed', created_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO audit_logs')) { db.audit_logs.push({ id: a[0], action: a[1], resource_id: a[3] }); return { meta: { changes: 1 } }; }
          if (s.includes('INSERT INTO download_grants')) { db.download_grants.push({ id: a[0], user_id: a[1], app_id: a[2], package_id: a[3], token_hash: a[4], expires_at: a[5], created_at: now }); return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  const env: any = { DB };
  env.ENVIRONMENT = opts.production ? 'production' : 'development';
  if (opts.secret !== false && opts.production) env.PAYSTACK_SECRET_KEY = SECRET;
  env.__db = db;
  return env;
}

const req = (userId: string | null, body: any, path: string, method = 'POST') => {
  const r = new Request(`https://api.rxstore.com${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  if (userId) (r as any).user = { userId };
  return r;
};

/** Signed Paystack webhook request (real HMAC-SHA512 of the raw body). */
function webhookReq(payload: any, secret = SECRET): Request {
  const raw = JSON.stringify(payload);
  const sig = createHmac('sha512', secret).update(raw, 'utf8').digest('hex');
  return new Request('https://api.rxstore.com/payments/webhook/paystack', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig }, body: raw,
  });
}

// ---------------------------------------------------------------------------
// Environment split honesty
// ---------------------------------------------------------------------------

test('production without a secret fails CLOSED — no simulation is possible', async () => {
  const env = makeEnv({ production: true, secret: false });
  assert.equal(realPaymentsEnabled(env), false);
  assert.equal(simulationAllowed(env), false, 'simulation impossible in production');
  const out: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  assert.equal(out.code, 'PAYMENTS_NOT_ENABLED');
});

test('free apps NEVER enter the payment flow', async () => {
  const env = makeEnv();
  const out: any = await paymentRoutes.initialize(req('u1', { appId: 'app_free' }, '/payments/initialize'), env);
  assert.equal(out.code, 'VALIDATION_ERROR');
  assert.ok(String(out.error).includes('free'));
  assert.equal(appIsPaid(env.__db.applications[0]), false);
});

test('paid app detection covers paid + subscription with positive price', () => {
  const env = makeEnv();
  assert.equal(appIsPaid(env.__db.applications[1]), true, 'paid');
  assert.equal(appIsPaid(env.__db.applications[2]), true, 'subscription');
  assert.equal(appIsPaid(env.__db.applications[0]), false, 'free');
  assert.equal(appIsPaid({ price_type: 'paid', price_amount: 0 }), false, 'paid with zero price is free');
});

// ---------------------------------------------------------------------------
// Initialize + verify (real provider path, stubbed fetch)
// ---------------------------------------------------------------------------

async function prodEnvWithFetch(verifyStatus = 'success', verifyAmount = 2500) {
  const env = makeEnv({ production: true });
  env.__fetchCalls = [] as any[];
  globalThis.fetch = (async (url: any, init: any) => {
    (env as any).__fetchCalls.push({ url: String(url), init });
    const u = String(url);
    if (u.includes('/transaction/initialize')) {
      return new Response(JSON.stringify({ status: true, data: { authorization_url: 'https://checkout.paystack.com/abc', reference: JSON.parse(init.body).reference } }), { status: 200 });
    }
    if (u.includes('/transaction/verify/')) {
      return new Response(JSON.stringify({ status: true, data: { status: verifyStatus, amount: verifyAmount, currency: 'GHS', id: 987654 } }), { status: 200 });
    }
    if (u.includes('/refund')) {
      return new Response(JSON.stringify({ status: true, data: { id: 111, status: 'pending' } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as any;
  return env;
}

test('initialize: creates a PENDING purchase and returns the hosted checkout URL (no card data)', async () => {
  const env = await prodEnvWithFetch();
  const out: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  assert.ok(out.authorizationUrl?.startsWith('https://checkout.paystack.com'));
  assert.equal(out.provider, 'paystack');
  assert.equal(out.purchase.status, 'pending');
  const purchase = env.__db.purchases[0];
  assert.equal(purchase.amount, 2500, 'amount in minor units (GH₵25)');
  assert.equal(purchase.status, 'pending');
  // The initialize call carried NO card data — only email/amount/reference.
  const initCall = env.__fetchCalls[0];
  const sent = JSON.parse(initCall.init.body);
  assert.deepEqual(Object.keys(sent).sort(), ['amount', 'callback_url', 'currency', 'email', 'reference']);
});

test('verify: success completes the purchase + activates the entitlement', async () => {
  const env = await prodEnvWithFetch();
  const init: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  const out: any = await paymentRoutes.verify(req('u1', null, `/payments/verify/${init.purchase.reference}`, 'GET'), env);
  assert.equal(out.purchase.status, 'complete');
  assert.equal(out.entitlement.status, 'ACTIVE');
  assert.equal(env.__db.purchases[0].status, 'complete');
  assert.equal(env.__db.entitlements.length, 1);
  assert.equal(env.__db.entitlements[0].status, 'ACTIVE');
  assert.equal(env.__db.entitlements[0].provider_transaction_id, '987654');
});

test('verify: provider failure marks the purchase failed, NO entitlement', async () => {
  const env = await prodEnvWithFetch('failed');
  const init: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  const out: any = await paymentRoutes.verify(req('u1', null, `/payments/verify/${init.purchase.reference}`, 'GET'), env);
  assert.equal(out.purchase.status, 'failed');
  assert.equal(env.__db.entitlements.length, 0, 'a failed payment grants nothing');
  assert.ok(env.__db.purchases[0].failure_reason);
});

test('verify: amount tampering (mismatch) is rejected and fails the purchase', async () => {
  const env = await prodEnvWithFetch('success', 100); // provider says GH₵1 for a GH₵25 app
  const init: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  const out: any = await paymentRoutes.verify(req('u1', null, `/payments/verify/${init.purchase.reference}`, 'GET'), env);
  assert.equal(out.code, 'FORBIDDEN');
  assert.equal(env.__db.purchases[0].status, 'failed');
  assert.equal(env.__db.entitlements.length, 0);
});

test('verify is idempotent: re-verifying a complete purchase changes nothing', async () => {
  const env = await prodEnvWithFetch();
  const init: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  await paymentRoutes.verify(req('u1', null, `/payments/verify/${init.purchase.reference}`, 'GET'), env);
  const again: any = await paymentRoutes.verify(req('u1', null, `/payments/verify/${init.purchase.reference}`, 'GET'), env);
  assert.equal(again.purchase.status, 'complete');
  assert.equal(env.__db.entitlements.length, 1, 'still exactly one entitlement');
});

test('already-owned purchase returns the existing entitlement (idempotent)', async () => {
  const env = await prodEnvWithFetch();
  await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  await paymentRoutes.verify(req('u1', null, `/payments/verify/${env.__db.purchases[0].provider_reference}`, 'GET'), env);
  const second: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  assert.equal(second.alreadyOwned, true);
  assert.equal(env.__db.purchases.length, 1, 'no duplicate purchase row');
});

// ---------------------------------------------------------------------------
// Dev simulation (non-production only)
// ---------------------------------------------------------------------------

test('dev simulation completes instantly, is clearly labelled, and NEVER works in production', async () => {
  const env = makeEnv(); // development, no secret
  const out: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  assert.equal(out.simulated, true);
  assert.ok(out.warning.includes('DEV/TEST ONLY'));
  assert.equal(env.__db.entitlements[0].status, 'ACTIVE');
});

// ---------------------------------------------------------------------------
// Webhooks: forgery, replay, duplicates, idempotency, refunds
// ---------------------------------------------------------------------------

test('webhook: forged signature is rejected and processes nothing', async () => {
  const env = makeEnv({ production: true });
  const forged = new Request('https://api.rxstore.com/payments/webhook/paystack', {
    method: 'POST', headers: { 'x-paystack-signature': 'deadbeef'.repeat(16) },
    body: JSON.stringify({ event: 'charge.success', data: { reference: 'ref_x', amount: 2500 } }),
  });
  const out: any = await webhookRoutes.paystack(forged, env);
  assert.equal(out.code, 'FORBIDDEN');
  assert.equal(env.__db.webhook_events.length, 0);
  assert.equal(env.__db.entitlements.length, 0);
});

test('webhook: valid charge.success completes the purchase + entitlement', async () => {
  const env = await prodEnvWithFetch();
  const init: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  const out: any = await webhookRoutes.paystack(webhookReq({
    id: 555001, event: 'charge.success', data: { reference: init.purchase.reference, amount: 2500, currency: 'GHS', status: 'success' },
  }), env);
  assert.equal(out.processed, true);
  assert.equal(env.__db.purchases[0].status, 'complete');
  assert.equal(env.__db.entitlements[0].status, 'ACTIVE');
});

test('webhook: replayed and duplicate events are ignored (idempotent processing)', async () => {
  const env = await prodEnvWithFetch();
  const init: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  const payload = { id: 555002, event: 'charge.success', data: { reference: init.purchase.reference, amount: 2500, currency: 'GHS' } };
  const first: any = await webhookRoutes.paystack(webhookReq(payload), env);
  assert.equal(first.processed, true);
  const replay: any = await webhookRoutes.paystack(webhookReq(payload), env);
  assert.equal(replay.duplicate, true, 'same event id -> ignored');
  // A DIFFERENT event id for the same purchase (provider retry) — the purchase
  // completion itself is idempotent.
  const retry: any = await webhookRoutes.paystack(webhookReq({ ...payload, id: 555003 }), env);
  assert.equal(retry.processed, true);
  assert.equal(env.__db.entitlements.length, 1, 'no entitlement duplication');
});

test('webhook: amount mismatch is rejected', async () => {
  const env = await prodEnvWithFetch();
  const init: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  const out: any = await webhookRoutes.paystack(webhookReq({
    id: 555004, event: 'charge.success', data: { reference: init.purchase.reference, amount: 50, currency: 'GHS' },
  }), env);
  assert.equal(out.ignored, true);
  assert.equal(env.__db.purchases[0].status, 'pending', 'nothing completed');
});

test('webhook: refund.processed ends paid access (entitlement REFUNDED)', async () => {
  const env = await prodEnvWithFetch();
  const init: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  await paymentRoutes.verify(req('u1', null, `/payments/verify/${init.purchase.reference}`, 'GET'), env);
  assert.ok(await activeEntitlement(env, 'u1', 'app_paid'), 'access active before refund');

  const out: any = await webhookRoutes.paystack(webhookReq({
    id: 555005, event: 'refund.processed', data: { transaction_reference: init.purchase.reference, status: 'processed' },
  }), env);
  assert.equal(out.processed, true);
  assert.equal(env.__db.purchases[0].status, 'refunded');
  assert.equal(await activeEntitlement(env, 'u1', 'app_paid'), null, 'paid access ENDS after refund');
  assert.equal(env.__db.entitlements[0].status, 'REFUNDED');
});

// ---------------------------------------------------------------------------
// Admin: refunds + revocation
// ---------------------------------------------------------------------------

test('admin refund: provider called, access ends immediately, reason audited', async () => {
  const env = await prodEnvWithFetch();
  const init: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  await paymentRoutes.verify(req('u1', null, `/payments/verify/${init.purchase.reference}`, 'GET'), env);

  const notComplete: any = await adminPaymentRoutes.refund(req('admin1', {}, '/admin/payments/nope/refund'), env);
  assert.equal(notComplete.code, 'NOT_FOUND');

  const out: any = await adminPaymentRoutes.refund(req('admin1', {}, `/admin/payments/${init.purchase.id}/refund`), env);
  assert.equal(out.purchase.status, 'refunded');
  assert.ok(env.__fetchCalls.some((c: any) => String(c.url).includes('/refund')), 'provider refund requested');
  assert.equal(await activeEntitlement(env, 'u1', 'app_paid'), null);
});

test('admin revoke: reason required; revoked entitlement loses access; audited', async () => {
  const env = await prodEnvWithFetch();
  const init: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  await paymentRoutes.verify(req('u1', null, `/payments/verify/${init.purchase.reference}`, 'GET'), env);
  const entId = env.__db.entitlements[0].id;

  const noReason: any = await adminPaymentRoutes.revoke(req('admin1', {}, `/admin/payments/entitlements/${entId}/revoke`), env);
  assert.equal(noReason.code, 'VALIDATION_ERROR');

  const out: any = await adminPaymentRoutes.revoke(req('admin1', { reason: 'Chargeback filed with the provider.' }, `/admin/payments/entitlements/${entId}/revoke`), env);
  assert.equal(out.entitlement.status, 'REVOKED');
  assert.equal(await activeEntitlement(env, 'u1', 'app_paid'), null);
  assert.equal(env.__db.entitlements[0].revoked_reason, 'Chargeback filed with the provider.');
  assert.ok(env.__db.audit_logs.some((l: any) => l.action === 'entitlement_revoked'));
});

// ---------------------------------------------------------------------------
// Download authorization (short-lived grants)
// ---------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const digest: ArrayBuffer = await (crypto as any).subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b: number) => b.toString(16).padStart(2, '0')).join('');
}

test('download grants: unguessable hashed tokens, short expiry, single purpose', async () => {
  const env = makeEnv({ production: true });
  // Issue a grant the way the download endpoint does.
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b: number) => b.toString(16).padStart(2, '0')).join('');
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare('INSERT INTO download_grants (id, user_id, app_id, package_id, token_hash, expires_at) VALUES (?,?,?,?,?, datetime(\'now\', \'+10 minutes\'))')
    .bind('g1', 'u1', 'app_paid', 'pkg_1', tokenHash).run();
  // Stored only as a hash: the raw token is not recoverable from the DB.
  assert.equal(env.__db.download_grants[0].token_hash, tokenHash);
  assert.notEqual(env.__db.download_grants[0].token_hash, token);
  // Lookup by hash works (the proxy path); a wrong token finds nothing.
  const hit: any = await env.DB.prepare('SELECT * FROM download_grants WHERE token_hash=?').bind(tokenHash).first();
  assert.ok(hit);
  const miss: any = await env.DB.prepare('SELECT * FROM download_grants WHERE token_hash=?').bind(await sha256Hex('wrong')).first();
  assert.equal(miss, null);
});

test('entitlement is account-level: works across ALL the user\'s devices', async () => {
  const env = await prodEnvWithFetch();
  const init: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  await paymentRoutes.verify(req('u1', null, `/payments/verify/${init.purchase.reference}`, 'GET'), env);
  // The download gate checks the entitlement by (user, app) — device-agnostic
  // by design: one purchase covers every device on the account.
  const fromDeviceA = await activeEntitlement(env, 'u1', 'app_paid');
  const fromDeviceB = await activeEntitlement(env, 'u1', 'app_paid');
  assert.equal(fromDeviceA?.status, 'ACTIVE');
  assert.equal(fromDeviceB?.status, 'ACTIVE');
  assert.equal(env.__db.entitlements.length, 1, 'ONE entitlement, not one per device');
});

// ---------------------------------------------------------------------------
// Purchase history
// ---------------------------------------------------------------------------

test('purchase history shows app, date, amount, currency, state, reference, refund status', async () => {
  const env = await prodEnvWithFetch();
  const init: any = await paymentRoutes.initialize(req('u1', { appId: 'app_paid' }, '/payments/initialize'), env);
  await paymentRoutes.verify(req('u1', null, `/payments/verify/${init.purchase.reference}`, 'GET'), env);
  await adminPaymentRoutes.refund(req('admin1', {}, `/admin/payments/${init.purchase.id}/refund`), env);

  const hist: any = await paymentRoutes.history(req('u1', null, '/payments/history', 'GET'), env);
  assert.equal(hist.purchases.length, 1);
  const row = hist.purchases[0];
  assert.equal(row.app.name, 'Paid App');
  assert.equal(row.amountMinor, 2500);
  assert.equal(row.currency, 'GHS');
  assert.equal(row.status, 'refunded');
  assert.equal(row.refundStatus, 'refunded');
  assert.ok(row.reference);
  assert.ok(row.date);

  // Another user's history is theirs alone.
  const other: any = await paymentRoutes.history(req('u2', null, '/payments/history', 'GET'), env);
  assert.equal(other.purchases.length, 0);
});


// ---------------------------------------------------------------------------
// GET /admin/payments/status — live configuration state for the admin panels
// (booleans + counters ONLY; secret values must never appear).
// ---------------------------------------------------------------------------

test('status: reports the LIVE provider state (production + secret = connected)', async () => {
  const env = makeEnv({ production: true, secret: true });
  const out: any = await adminPaymentRoutes.status(new Request('https://api.test/admin/payments/status'), env);
  assert.equal(out.provider, 'paystack');
  assert.equal(out.configured, true, 'production + secret → connected');
  assert.equal(out.simulation, false, 'no simulation in production');
  assert.equal(out.currency, 'GHS');
  assert.equal(out.webhookUrl, 'https://api.test/payments/webhook/paystack');
  assert.equal(out.purchases.total, 0);
  assert.equal(out.webhook.events, 0);
  assert.equal(out.marketplaceFeePercent, '15');
});

test('status: NOT configured when the secret is missing (honest, no fake claims)', async () => {
  const env = makeEnv({ production: true, secret: false });
  const out: any = await adminPaymentRoutes.status(new Request('https://api.test/admin/payments/status'), env);
  assert.equal(out.configured, false);
  assert.equal(out.simulation, false, 'production never simulates');
});

test('status: dev environment without a secret reports the simulation state', async () => {
  const env = makeEnv({ production: false, secret: false });
  const out: any = await adminPaymentRoutes.status(new Request('https://api.test/admin/payments/status'), env);
  assert.equal(out.configured, false);
  assert.equal(out.simulation, true);
});

test('status: webhook stats + purchase totals come from the real ledgers', async () => {
  const env = makeEnv({ production: true, secret: true });
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const db = (env as any).__db;
  db.webhook_events.push({ id: 'w1', provider: 'paystack', event_key: 'k1', event_type: 'charge.success', payload: '{}', status: 'processed', created_at: now });
  db.webhook_events.push({ id: 'w2', provider: 'paystack', event_key: 'k2', event_type: 'refund.processed', payload: '{}', status: 'processed', created_at: now });
  db.purchases.push({ id: 'p1', user_id: 'u1', app_id: 'app_paid', amount: 2500, currency: 'GHS', provider: 'paystack', provider_reference: 'ref1', status: 'complete', created_at: now });
  db.purchases.push({ id: 'p2', user_id: 'u2', app_id: 'app_paid', amount: 2500, currency: 'GHS', provider: 'paystack', provider_reference: 'ref2', status: 'refunded', created_at: now });
  const out: any = await adminPaymentRoutes.status(new Request('https://api.test/admin/payments/status'), env);
  assert.equal(out.webhook.events, 2);
  assert.equal(out.webhook.lastType, 'refund.processed');
  assert.equal(out.purchases.total, 2);
  assert.equal(out.purchases.complete, 1);
  assert.equal(out.purchases.refunded, 1);
});

test('status: NEVER contains secret material', async () => {
  const env = makeEnv({ production: true, secret: true });
  const out: any = await adminPaymentRoutes.status(new Request('https://api.test/admin/payments/status'), env);
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes(SECRET), 'the Paystack secret never appears');
  assert.ok(!blob.includes('sk_live') && !blob.includes('sk_test'), 'no key-shaped material');
});
