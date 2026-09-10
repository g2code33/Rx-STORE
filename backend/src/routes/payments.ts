/**
 * Payment Routes — DEVELOPMENT/TEST ONLY.
 *
 * SECURITY / HONESTY: none of the payment providers below are integrated. The
 * previous implementation fabricated a successful payment (`success: true`)
 * with a synthetic transaction id and then created an ACTIVE subscription —
 * i.e. it granted paid-app access for free.
 *
 * This version:
 *   - refuses to grant access in production (`PAYMENTS_NOT_ENABLED`, HTTP 501)
 *   - only simulates success when `ENVIRONMENT !== 'production'` (local/dev/testing)
 *   - clearly marks simulated subscriptions so they can never be mistaken for real
 *
 * Do not enable paid-app access based on these stubs in production.
 */

import { apiErrorBody, statusForCode } from '../services/errors.ts';
import { validateId } from '../utils/validation.ts';

/** True only for non-production environments. */
function paymentsEnabled(env: any): boolean {
  return String(env?.ENVIRONMENT || '').toLowerCase() !== 'production';
}

export const paymentsRoutes = {
  async subscribe(request: Request, env: any) {
    const userId = (request as any).user?.userId;
    if (!paymentsEnabled(env)) {
      // No provider is integrated: never grant paid access.
      return {
        code: 'PAYMENTS_NOT_ENABLED',
        message: 'Payments are not enabled. No payment provider is connected in this deployment.',
        details: apiErrorBody('PAYMENTS_NOT_ENABLED', 'Payments are not enabled.').error,
      };
    }

    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const { appId, plan, paymentMethod } = body || {};
    if (!validateId(appId)) return { code: 'VALIDATION_ERROR', message: 'A valid appId is required' };
    if (!validateId(paymentMethod)) return { code: 'VALIDATION_ERROR', message: 'A valid paymentMethod is required' };

    const app: any = await env.DB.prepare('SELECT id, name, price_amount FROM applications WHERE id = ?').bind(appId).first().catch(() => null);
    if (!app) return { code: 'NOT_FOUND', message: 'Application not found' };

    // DEV/TEST ONLY — a simulated subscription, explicitly marked as such.
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, user_id, app_id, plan, status, amount, start_date, created_at)
       VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))`
    ).bind(subscriptionId, userId, appId, String(plan || 'dev-test').slice(0, 40), 'test', app.price_amount ?? 0).run().catch(() => {});

    await env.DB.prepare(
      `INSERT INTO payments (id, user_id, subscription_id, amount, provider, provider_transaction_id, status, metadata, created_at)
       VALUES (?,?,?,?,?,?,?,?,datetime('now'))`
    ).bind(
      `pay_${crypto.randomUUID()}`, userId, subscriptionId, app.price_amount ?? 0,
      String(paymentMethod).slice(0, 30), `sim_${Date.now()}`, 'simulated',
      JSON.stringify({ simulated: true, note: 'DEV/TEST ONLY — no real payment was processed' }),
    ).run().catch(() => {});

    return {
      subscription: { id: subscriptionId, status: 'test', appId },
      payment: { status: 'simulated' },
      simulated: true,
      warning: 'DEV/TEST ONLY — this subscription is simulated and grants no real entitlement.',
    };
  },

  async history(request: Request, env: any) {
    const userId = (request as any).user?.userId;
    const payments: any = await env.DB.prepare(
      `SELECT p.id, p.amount, p.provider, p.status, p.created_at FROM payments p WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT 100`
    ).bind(userId).all().catch(() => ({ results: [] }));
    return payments.results || [];
  },
};

export { statusForCode };
