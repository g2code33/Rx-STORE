/**
 * Marketplace payments, entitlements & ownership (Phase 18).
 *
 * REAL provider integration: Paystack (Paystack hosts all card/mobile-money
 * authorization on their checkout page; RX Store never sees credentials).
 *
 * Honest environment split:
 *   - production + PAYSTACK_SECRET_KEY → real Paystack initialize/verify/
 *     refund/webhooks. NO simulation is possible in production.
 *   - non-production WITHOUT a secret key → the explicitly-marked DEV
 *     simulation (grants a test entitlement labelled simulated) — unchanged
 *     from the old behaviour, still impossible in production.
 *
 * Security model:
 *   - purchases: amount stored in minor units from the APP record, verified
 *     against the provider's verify response before completing.
 *   - entitlements: server-side, UNIQUE(user_id, app_id) — one per app per
 *     user; states PENDING/ACTIVE/REFUNDED/REVOKED/EXPIRED. ALL the user's
 *     devices share the entitlement (ownership is account-level).
 *   - webhooks: HMAC-SHA512 signature verification on the raw body, replay +
 *     duplicate protection via the webhook_events ledger (UNIQUE(provider,
 *     event_key)), idempotent processing (re-processing a charge.success for
 *     an already-complete purchase is a no-op).
 *   - paid downloads: never a permanent URL — an entitlement check issues a
 *     short-lived (10 min) single-purpose download grant; the grant token is
 *     stored hashed and is served through the authenticated /downloads/:token
 *     proxy. Free apps bypass payment entirely.
 *   - refunds: provider refund request + entitlement REFUNDED (paid access
 *     ends immediately); refund.processed webhooks also update state.
 */

import {
  initializeTransaction, verifyTransaction, createRefund, verifyWebhookSignature,
} from '../services/paystack.ts';
import { getSetting } from '../services/settings.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

async function bodyOf(request: Request): Promise<any> {
  return await request.json().catch(() => ({}));
}

async function globalAudit(env: any, action: string, resourceId: string, details: Record<string, unknown> = {}) {
  await env.DB.prepare('INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?,?,?)')
    .bind(rid('log'), action, 'payment', resourceId, JSON.stringify(details)).run().catch(() => {});
}

/** Real provider payments require production + secret. */
export function realPaymentsEnabled(env: any): boolean {
  return String(env?.ENVIRONMENT || '').toLowerCase() === 'production' && !!env?.PAYSTACK_SECRET_KEY;
}

/** Dev simulation: ONLY outside production AND without a provider secret. */
export function simulationAllowed(env: any): boolean {
  return String(env?.ENVIRONMENT || '').toLowerCase() !== 'production' && !env?.PAYSTACK_SECRET_KEY;
}

/** Is this app paid? (price_type paid/subscription with a positive amount) */
export function appIsPaid(app: any): boolean {
  return ['paid', 'subscription'].includes(String(app?.price_type || 'free')) && Number(app?.price_amount) > 0;
}

/** Price in minor units (provider currencies use 100x minor units). */
function priceMinor(app: any): number {
  return Math.round(Number(app?.price_amount || 0) * 100);
}

/** The user's effective entitlement for an app (ACTIVE or EXPIRED-check). */
export async function activeEntitlement(env: any, userId: string, appId: string): Promise<any | null> {
  const row: any = await env.DB.prepare(
    `SELECT * FROM entitlements WHERE user_id=? AND app_id=? LIMIT 1`
  ).bind(userId, appId).first().catch(() => null);
  if (!row) return null;
  if (row.status !== 'ACTIVE') return null;
  return row;
}

/** Idempotently complete a purchase + activate the entitlement. */
async function completePurchase(env: any, purchaseId: string, providerTransactionId: string | null, source: 'verify' | 'webhook') {
  const purchase: any = await env.DB.prepare('SELECT * FROM purchases WHERE id=?').bind(purchaseId).first().catch(() => null);
  if (!purchase) return { error: 'Purchase not found', code: 'NOT_FOUND' as const };
  if (purchase.status === 'refunded') return { error: 'This purchase was refunded.', code: 'FORBIDDEN' as const };

  if (purchase.status !== 'complete') {
    await env.DB.prepare(
      `UPDATE purchases SET status='complete', provider_transaction_id=COALESCE(?, provider_transaction_id), completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).bind(providerTransactionId, purchaseId).run();
    await globalAudit(env, 'purchase_completed', purchaseId, { source, userId: purchase.user_id, appId: purchase.app_id });
  }
  // Idempotent entitlement upsert (one row per user+app; a re-purchase of an
  // owned app refreshes the same entitlement rather than duplicating).
  await env.DB.prepare(
    `INSERT INTO entitlements (id, user_id, app_id, purchase_id, provider, provider_transaction_id, status, activated_at)
     VALUES (?,?,?,?,?,?, 'ACTIVE', datetime('now'))
     ON CONFLICT(user_id, app_id) DO UPDATE SET
       status='ACTIVE', purchase_id=excluded.purchase_id, provider=excluded.provider,
       provider_transaction_id=COALESCE(excluded.provider_transaction_id, entitlements.provider_transaction_id),
       activated_at=datetime('now'), revoked_at=NULL, revoked_reason=NULL, refunded_at=NULL, updated_at=datetime('now')`
  ).bind(rid('ent'), purchase.user_id, purchase.app_id, purchaseId, purchase.provider, providerTransactionId).run();
  return { ok: true };
}

/** Mark a purchase refunded + entitlement REFUNDED (paid access ends). */
async function markRefunded(env: any, purchaseId: string, source: string) {
  await env.DB.prepare(
    `UPDATE purchases SET status='refunded', refunded_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='complete'`
  ).bind(purchaseId).run();
  await env.DB.prepare(
    `UPDATE entitlements SET status='REFUNDED', refunded_at=datetime('now'), updated_at=datetime('now')
     WHERE purchase_id=? AND status='ACTIVE'`
  ).bind(purchaseId).run();
  await globalAudit(env, 'purchase_refunded', purchaseId, { source });
}

// ---------------------------------------------------------------------------
// User routes
// ---------------------------------------------------------------------------

export const paymentRoutes = {

  /**
   * POST /payments/initialize {appId}
   * Paid apps only. Creates a PENDING purchase and returns the provider's
   * hosted authorization URL (card/mobile-money details are entered ONLY on
   * the provider's page). Dev simulation (non-production, no secret) returns
   * a clearly-labelled simulated completion instead.
   */
  async initialize(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Sign in to purchase', code: 'UNAUTHORIZED' };

    // FAIL CLOSED FIRST: in production without a provider secret nothing may
    // proceed — not even lookups. (Dev simulation requires non-production.)
    if (!realPaymentsEnabled(env) && !simulationAllowed(env)) {
      return { error: 'Payments are not enabled. No payment provider is connected in this deployment.', code: 'PAYMENTS_NOT_ENABLED' };
    }

    const body = await bodyOf(request);
    const appId = str(body.appId ?? body.appId, 60);
    if (!appId) return { error: 'appId is required', code: 'VALIDATION_ERROR' };
    const app: any = await env.DB.prepare('SELECT id, slug, name, price_type, price_amount, developer_org_id FROM applications WHERE id=?').bind(appId).first().catch(() => null);
    if (!app) return { error: 'Application not found', code: 'NOT_FOUND' };

    // FREE APPS NEVER ENTER THE PAYMENT FLOW.
    if (!appIsPaid(app)) return { error: 'This application is free — no purchase is required.', code: 'VALIDATION_ERROR' };

    // Already owned? Idempotent: return the existing entitlement.
    const owned = await activeEntitlement(env, userId, appId);
    if (owned) return { entitlement: { id: owned.id, status: owned.status }, alreadyOwned: true };

    const user: any = await env.DB.prepare('SELECT email, name FROM users WHERE id=?').bind(userId).first().catch(() => null);
    if (!user?.email) return { error: 'Your account has no email on file — add one to purchase.', code: 'VALIDATION_ERROR' };

    const reference = `rxs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const purchaseId = rid('pur');
    const amountMinor = priceMinor(app);
    const currency = 'GHS';

    // ---- REAL provider path (production + secret) ----
    if (realPaymentsEnabled(env)) {
      const origin = new URL(request.url).origin;
      const init = await initializeTransaction(env, {
        email: String(user.email), amountMinor, currency, reference,
        callbackUrl: `${origin}/payments/callback?reference=${reference}`,
      });
      if (!init.ok) return { error: `Could not start the payment: ${init.error}`, code: 'INTERNAL' };
      await env.DB.prepare(
        `INSERT INTO purchases (id, user_id, app_id, amount, currency, provider, provider_reference, status) VALUES (?,?,?,?,?,?,?, 'pending')`
      ).bind(purchaseId, userId, appId, amountMinor, currency, 'paystack', reference).run();
      await globalAudit(env, 'purchase_initialized', purchaseId, { userId, appId, reference, amountMinor });
      return {
        purchase: { id: purchaseId, reference, status: 'pending', amountMinor, currency },
        provider: 'paystack',
        authorizationUrl: init.authorizationUrl,
      };
    }

    // ---- DEV simulation (non-production, no secret) — clearly labelled ----
    await env.DB.prepare(
      `INSERT INTO purchases (id, user_id, app_id, amount, currency, provider, provider_reference, status) VALUES (?,?,?,?,?,?,?, 'pending')`
    ).bind(purchaseId, userId, appId, amountMinor, currency, 'dev-sim', reference).run();
    // Simulated instant completion (NEVER possible in production).
    await completePurchase(env, purchaseId, `sim_${reference}`, 'verify');
    return {
      purchase: { id: purchaseId, reference, status: 'complete', amountMinor, currency },
      provider: 'dev-sim',
      simulated: true,
      warning: 'DEV/TEST ONLY — no real payment was processed. This is impossible in production.',
    };
  },

  /**
   * GET /payments/verify/:reference — server-side verification with the
   * provider (amount + currency + status), then idempotent completion.
   */
  async verify(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Sign in required', code: 'UNAUTHORIZED' };
    const reference = decodeURIComponent(new URL(request.url).pathname.split('/').pop() || '');
    const purchase: any = await env.DB.prepare('SELECT * FROM purchases WHERE provider_reference=? AND user_id=?')
      .bind(reference, userId).first().catch(() => null);
    if (!purchase) return { error: 'Purchase not found', code: 'NOT_FOUND' };
    if (purchase.status === 'complete' || purchase.status === 'refunded') {
      const ent = await activeEntitlement(env, userId, purchase.app_id);
      return { purchase: { id: purchase.id, status: purchase.status }, entitlement: ent ? { status: ent.status } : null };
    }

    if (purchase.provider !== 'paystack' || !realPaymentsEnabled(env)) {
      return { error: 'This purchase cannot be verified in this deployment.', code: 'FORBIDDEN' };
    }

    const v = await verifyTransaction(env, reference);
    if (!v.ok) return { error: `Verification failed: ${v.error}`, code: 'INTERNAL' };
    if (v.status !== 'success') {
      await env.DB.prepare(`UPDATE purchases SET status='failed', failure_reason=?, updated_at=datetime('now') WHERE id=?`)
        .bind(`provider status: ${v.status}`, purchase.id).run();
      return { purchase: { id: purchase.id, status: 'failed' }, providerStatus: v.status };
    }
    // Amount + currency must match the recorded purchase (anti-tamper).
    if ((v.amountMinor ?? 0) < purchase.amount || (v.currency && v.currency !== purchase.currency)) {
      await env.DB.prepare(`UPDATE purchases SET status='failed', failure_reason=?, updated_at=datetime('now') WHERE id=?`)
        .bind('amount/currency mismatch on verify', purchase.id).run();
      await globalAudit(env, 'purchase_verify_mismatch', purchase.id, { expected: purchase.amount, got: v.amountMinor });
      return { error: 'Payment amount did not match the purchase.', code: 'FORBIDDEN' };
    }
    const done = await completePurchase(env, purchase.id, v.transactionId || null, 'verify');
    if ((done as any)?.error) return done;
    return { purchase: { id: purchase.id, status: 'complete' }, entitlement: { status: 'ACTIVE' } };
  },

  /** GET /payments/history — the user's purchase history (receipts). */
  async history(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Sign in required', code: 'UNAUTHORIZED' };
    const rows: any = await env.DB.prepare(
      `SELECT p.id, p.amount, p.currency, p.provider, p.provider_reference AS reference, p.status,
              p.failure_reason, p.refunded_at, p.created_at, p.completed_at,
              a.name AS app_name, a.slug AS app_slug, a.icon AS app_icon,
              e.status AS entitlement_status
       FROM purchases p
       LEFT JOIN applications a ON a.id = p.app_id
       LEFT JOIN entitlements e ON e.user_id = p.user_id AND e.app_id = p.app_id
       WHERE p.user_id=? ORDER BY p.created_at DESC LIMIT 100`
    ).bind(userId).all().catch(() => ({ results: [] }));
    return {
      purchases: (rows?.results || []).map((p: any) => ({
        id: p.id, app: { name: p.app_name, slug: p.app_slug, icon: p.app_icon },
        date: p.created_at, amountMinor: Number(p.amount) || 0, currency: p.currency,
        provider: p.provider, reference: p.reference, status: p.status,
        refundStatus: p.refunded_at ? 'refunded' : null,
        entitlementStatus: p.entitlement_status || null,
      })),
    };
  },

  /** GET /payments/entitlements — the user's ownership (all their devices). */
  async entitlements(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Sign in required', code: 'UNAUTHORIZED' };
    const rows: any = await env.DB.prepare(
      `SELECT e.id, e.status, e.activated_at, e.revoked_reason, a.name AS app_name, a.slug AS app_slug, a.icon AS app_icon
       FROM entitlements e JOIN applications a ON a.id = e.app_id
       WHERE e.user_id=? ORDER BY e.created_at DESC`
    ).bind(userId).all().catch(() => ({ results: [] }));
    return { entitlements: rows?.results || [] };
  },
};

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export const webhookRoutes = {

  /**
   * POST /payments/webhook/paystack — signature-verified, idempotent.
   * Handles charge.success (complete purchase + activate entitlement) and
   * refund.processed (mark refunded; paid access ends).
   */
  async paystack(request: Request, env: any) {
    if (!realPaymentsEnabled(env)) {
      // No secret configured: nothing can be verified — reject loudly.
      return { error: 'Webhook not enabled (no provider secret configured)', code: 'FORBIDDEN' };
    }
    const raw = await request.text();
    const signature = request.headers.get('x-paystack-signature');
    if (!(await verifyWebhookSignature(raw, signature, String(env.PAYSTACK_SECRET_KEY)))) {
      await globalAudit(env, 'webhook_signature_rejected', 'paystack', {});
      return { error: 'Invalid webhook signature', code: 'FORBIDDEN' };
    }

    let event: any;
    try { event = JSON.parse(raw); } catch { return { error: 'Invalid JSON', code: 'VALIDATION_ERROR' }; }
    const type = String(event?.event || '');
    const data = event?.data || {};

    // Idempotency key: provider event id when present, else type+reference.
    const eventKey = String(event?.id ?? data?.id ?? `${type}:${data?.reference ?? data?.transaction_reference ?? ''}`).slice(0, 120);
    if (!eventKey || eventKey === `${type}:`) return { error: 'Unidentifiable event', code: 'VALIDATION_ERROR' };

    // Replay/duplicate protection: the UNIQUE(provider, event_key) insert
    // fails on a repeat — the event has already been processed.
    try {
      await env.DB.prepare('INSERT INTO webhook_events (id, provider, event_key, event_type, payload, status) VALUES (?,?,?,?,?,\'processed\')')
        .bind(rid('wh'), 'paystack', eventKey, type, safeEventPayload(type, data)).run();
    } catch {
      return { duplicate: true, ignored: true };
    }

    if (type === 'charge.success') {
      const reference = String(data.reference || '');
      const purchase: any = await env.DB.prepare('SELECT * FROM purchases WHERE provider_reference=?').bind(reference).first().catch(() => null);
      if (!purchase) return { ignored: true, reason: 'unknown reference' };
      // Verify the event amounts match the recorded purchase (defense-in-depth
      // even though the signature already authenticates the payload).
      const amountMinor = Number(data.amount) || 0;
      if (amountMinor < purchase.amount) {
        await globalAudit(env, 'webhook_amount_mismatch', purchase.id, { expected: purchase.amount, got: amountMinor });
        return { ignored: true, reason: 'amount mismatch' };
      }
      const done = await completePurchase(env, purchase.id, data.id != null ? String(data.id) : null, 'webhook');
      if ((done as any)?.error) return done;
      return { processed: true };
    }

    if (type === 'refund.processed') {
      const reference = String(data.transaction_reference || data.reference || '');
      const purchase: any = await env.DB.prepare('SELECT * FROM purchases WHERE provider_reference=?').bind(reference).first().catch(() => null);
      if (!purchase) return { ignored: true, reason: 'unknown reference' };
      await markRefunded(env, purchase.id, 'webhook');
      return { processed: true };
    }

    return { ignored: true, reason: `unhandled event type ${type}` };
  },
};

/** Sanitized webhook payload (never persists anything card-related). */
function safeEventPayload(type: string, data: any): string {
  const clean: Record<string, unknown> = {};
  for (const key of ['id', 'reference', 'transaction_reference', 'amount', 'currency', 'status', 'domain', 'channel', 'paid_at', 'created_at', 'reason']) {
    if (data?.[key] !== undefined) clean[key] = data[key];
  }
  return JSON.stringify({ event: type, data: clean });
}

// ---------------------------------------------------------------------------
// Admin routes (admin JWT enforced by index.ts)
// ---------------------------------------------------------------------------

export const adminPaymentRoutes = {

  /**
   * GET /admin/payments/status — the LIVE payment configuration state for the
   * admin panels (Phase: payment wiring audit). Booleans and counters ONLY —
   * never secret values. Tells the admin: is Paystack connected, which webhook
   * URL must be registered in the provider dashboard, whether webhooks have
   * ever arrived, purchase totals and the marketplace fee.
   */
  async status(request: Request, env: any) {
    const origin = new URL(request.url).origin;
    const lastWebhook: any = await env.DB.prepare(
      "SELECT event_type, created_at FROM webhook_events WHERE provider='paystack' ORDER BY created_at DESC LIMIT 1"
    ).first().catch(() => null);
    const webhookCount: any = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM webhook_events WHERE provider='paystack'"
    ).first().catch(() => null);
    const purchaseStats: any = await env.DB.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) AS complete, SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END) AS refunded FROM purchases"
    ).first().catch(() => null);
    return {
      provider: 'paystack',
      configured: realPaymentsEnabled(env),
      environment: String(env?.ENVIRONMENT || ''),
      simulation: simulationAllowed(env),
      currency: 'GHS',
      webhookUrl: `${origin}/payments/webhook/paystack`,
      webhook: {
        events: Number(webhookCount?.n) || 0,
        lastType: lastWebhook?.event_type || null,
        lastAt: lastWebhook?.created_at || null,
      },
      purchases: {
        total: Number(purchaseStats?.total) || 0,
        complete: Number(purchaseStats?.complete) || 0,
        refunded: Number(purchaseStats?.refunded) || 0,
      },
      marketplaceFeePercent: await getSetting(env, 'marketplace_fee_percent', '15'),
    };
  },

  /** GET /admin/payments/transactions?status= */
  async transactions(request: Request, env: any) {
    const status = new URL(request.url).searchParams.get('status') || '';
    const rows: any = await env.DB.prepare(
      `SELECT p.id, p.amount, p.currency, p.provider, p.provider_reference, p.provider_transaction_id,
              p.status, p.failure_reason, p.refunded_at, p.created_at, p.completed_at,
              u.name AS user_name, u.email AS user_email, a.name AS app_name, a.slug AS app_slug
       FROM purchases p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN applications a ON a.id = p.app_id
       ${status ? 'WHERE p.status = ?' : ''}
       ORDER BY p.created_at DESC LIMIT 200`
    ).bind(...(status ? [status] : [])).all().catch(() => ({ results: [] }));
    return {
      transactions: (rows?.results || []).map((t: any) => ({
        ...t, amountMajor: (Number(t.amount) || 0) / 100,
        // No card/payment credentials exist anywhere in this data by design.
      })),
    };
  },

  /** GET /admin/payments/entitlements?status= */
  async entitlements(request: Request, env: any) {
    const status = new URL(request.url).searchParams.get('status') || '';
    const rows: any = await env.DB.prepare(
      `SELECT e.id, e.status, e.provider, e.activated_at, e.revoked_at, e.revoked_reason, e.refunded_at, e.created_at,
              u.name AS user_name, u.email AS user_email, a.name AS app_name, a.slug AS app_slug
       FROM entitlements e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN applications a ON a.id = e.app_id
       ${status ? 'WHERE e.status = ?' : ''}
       ORDER BY e.updated_at DESC LIMIT 200`
    ).bind(...(status ? [status] : [])).all().catch(() => ({ results: [] }));
    return { entitlements: rows?.results || [] };
  },

  /**
   * POST /admin/payments/:purchaseId/refund — requests the provider refund and
   * marks the purchase + entitlement refunded (paid access ends immediately;
   * the provider's refund.processed webhook is also handled idempotently).
   */
  async refund(request: Request, env: any) {
    const purchaseId = decodeURIComponent(new URL(request.url).pathname.split('/')[3] || '');
    const purchase: any = await env.DB.prepare('SELECT * FROM purchases WHERE id=?').bind(purchaseId).first().catch(() => null);
    if (!purchase) return { error: 'Purchase not found', code: 'NOT_FOUND' };
    if (purchase.status !== 'complete') return { error: 'Only completed purchases can be refunded', code: 'VALIDATION_ERROR' };

    if (purchase.provider === 'paystack') {
      if (!realPaymentsEnabled(env)) return { error: 'Provider refunds require the configured production secret.', code: 'FORBIDDEN' };
      const r = await createRefund(env, purchase.provider_reference);
      if (!r.ok) return { error: `Provider refund failed: ${r.error}`, code: 'INTERNAL' };
    }
    await markRefunded(env, purchase.id, 'admin');
    return { purchase: { id: purchase.id, status: 'refunded' } };
  },

  /**
   * POST /admin/payments/entitlements/:id/revoke {reason} — revoke access for
   * abuse/licensing reasons. Reason REQUIRED; fully audited.
   */
  async revoke(request: Request, env: any) {
    const adminId = ((request as any).user as any)?.userId || null;
    const entitlementId = decodeURIComponent(new URL(request.url).pathname.split('/')[4] || '');
    const reason = str((await bodyOf(request)).reason, 1000);
    if (reason.length < 10) return { error: 'A revocation reason of at least 10 characters is required.', code: 'VALIDATION_ERROR' };
    const ent: any = await env.DB.prepare('SELECT * FROM entitlements WHERE id=?').bind(entitlementId).first().catch(() => null);
    if (!ent) return { error: 'Entitlement not found', code: 'NOT_FOUND' };
    if (ent.status !== 'ACTIVE') return { error: 'Only active entitlements can be revoked', code: 'VALIDATION_ERROR' };

    await env.DB.prepare(
      `UPDATE entitlements SET status='REVOKED', revoked_at=datetime('now'), revoked_reason=?, updated_at=datetime('now') WHERE id=?`
    ).bind(reason, entitlementId).run();
    await globalAudit(env, 'entitlement_revoked', entitlementId, { reason, adminId });
    return { entitlement: { id: entitlementId, status: 'REVOKED' } };
  },
};
