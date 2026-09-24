/**
 * Developer analytics, revenue & payouts (Phase 19).
 *
 * All numbers come from REAL marketplace data: the downloads ledger (kind
 * install/update, platform, version, country), app_installations (device
 * detections — active installs), reviews (ratings), and Phase 18 purchases.
 *
 * Privacy rules:
 *   - Analytics are AGGREGATED ONLY: no customer names, emails, transaction
 *     references or per-user rows are ever returned to developers.
 *   - Financial detail (payouts, billing settings, per-payout amounts) is
 *     restricted to billing.manage (OWNER + ADMIN). DEVELOPER / ANALYST /
 *     SUPPORT get the analytics surface only — server-enforced, tested.
 *   - Payout destinations are stored as masked labels; nothing resembling an
 *     account number is accepted.
 *
 * Revenue math (all minor units):
 *   gross     = Σ completed purchases (complete + refunded statuses)
 *   refunds   = Σ refunded purchases
 *   fee_bps   = admin setting marketplace_fee_percent (default 15%)
 *   fees      = fee_bps × (gross − refunds)            [fees apply to retained sales]
 *   net       = gross − refunds − fees
 *   paid      = Σ PAID payouts
 *   pending   = max(0, net − paid − Σ non-cancelled/failed outstanding payouts)
 */

import { getSetting } from '../services/settings.ts';
import { resolveMembership, requirePermission, auditDev } from './developers.ts';

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
    .bind(rid('log'), action, 'payout', resourceId, JSON.stringify(details)).run().catch(() => {});
}

/** Apps belonging to the org (id, slug, name). */
async function orgApps(env: any, developerId: string): Promise<any[]> {
  const rows: any = await env.DB.prepare(
    'SELECT id, slug, name FROM applications WHERE developer_org_id=?'
  ).bind(developerId).all().catch(() => ({ results: [] }));
  return rows?.results || [];
}

function inPlaceholders(ids: string[]): string {
  return ids.length ? ids.map(() => '?').join(',') : "''";
}

/** Fee basis points from the admin setting (percent, 0–50). */
export async function feeBps(env: any): Promise<number> {
  const pct = Number(await getSetting(env, 'marketplace_fee_percent', '15'));
  if (!Number.isFinite(pct) || pct < 0 || pct > 50) return 1500;
  return Math.round(pct * 100);
}

// ---------------------------------------------------------------------------
// Revenue computation (shared by developer + admin views)
// ---------------------------------------------------------------------------

export interface RevenueSummary {
  grossMinor: number;
  refundsMinor: number;
  feesMinor: number;
  netMinor: number;
  paidMinor: number;          // Σ PAID payouts
  pendingMinor: number;       // net − paid − outstanding payouts (floored at 0)
  outstandingPayoutMinor: number; // Σ PENDING+PROCESSING+HELD payouts
  currency: string;
  feePercent: number;
}

export async function revenueForApps(env: any, appIds: string[]): Promise<RevenueSummary> {
  const bps = await feeBps(env);
  let gross = 0, refunded = 0;
  if (appIds.length) {
    const ph = inPlaceholders(appIds);
    const rows: any = await env.DB.prepare(
      `SELECT status, SUM(amount) AS total FROM purchases WHERE app_id IN (${ph}) AND status IN ('complete','refunded') GROUP BY status`
    ).bind(...appIds).all().catch(() => ({ results: [] }));
    for (const r of rows?.results || []) {
      // Gross = ALL completed sales (complete + refunded) — refunds are a
      // separate deduction line, never double-subtracted.
      if (r.status === 'complete' || r.status === 'refunded') gross += Number(r.total) || 0;
      if (r.status === 'refunded') refunded += Number(r.total) || 0;
    }
  }
  const fees = Math.round(((gross - refunded) * bps) / 10000);
  return {
    grossMinor: gross,
    refundsMinor: refunded,
    feesMinor: fees,
    netMinor: gross - refunded - fees,
    paidMinor: 0,
    pendingMinor: 0,
    outstandingPayoutMinor: 0,
    currency: 'GHS',
    feePercent: bps / 100,
  };
}

/** Fill payout aggregates into a revenue summary for a developer org. */
export async function withPayouts(env: any, developerId: string, summary: RevenueSummary): Promise<RevenueSummary> {
  const rows: any = await env.DB.prepare(
    `SELECT status, SUM(amount_minor) AS total FROM developer_payouts WHERE developer_id=? GROUP BY status`
  ).bind(developerId).all().catch(() => ({ results: [] }));
  let paid = 0, outstanding = 0;
  for (const r of rows?.results || []) {
    const t = Number(r.total) || 0;
    if (r.status === 'PAID') paid += t;
    if (['PENDING', 'PROCESSING', 'HELD'].includes(r.status)) outstanding += t;
  }
  summary.paidMinor = paid;
  summary.outstandingPayoutMinor = outstanding;
  summary.pendingMinor = Math.max(0, summary.netMinor - paid - outstanding);
  return summary;
}

// ---------------------------------------------------------------------------
// Analytics (aggregated; analytics.view)
// ---------------------------------------------------------------------------

async function appAnalytics(env: any, app: any): Promise<any> {
  const appId = app.id;
  // Downloads: installs vs updates (kind derived at download time) + platform
  // + country (aggregated; unknown when the ledger row predates geo capture).
  const dlRows: any = await env.DB.prepare(
    `SELECT kind, platform, country, COUNT(*) AS c FROM downloads WHERE app_id=? GROUP BY kind, platform, country`
  ).bind(appId).all().catch(() => ({ results: [] }));
  let downloads = 0, installs = 0, updates = 0;
  const byPlatform: Record<string, number> = {};
  const byCountry: Record<string, number> = {};
  for (const r of dlRows?.results || []) {
    const c = Number(r.c) || 0;
    downloads += c;
    if (r.kind === 'update') updates += c; else installs += c;
    if (r.platform) byPlatform[r.platform] = (byPlatform[r.platform] || 0) + c;
    const cc = r.country || 'unknown';
    byCountry[cc] = (byCountry[cc] || 0) + c;
  }
  // Active installations: real device detections (installed/update_available).
  const activeRows: any = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM app_installations WHERE application_id=? AND status IN ('installed','update_available')`
  ).bind(appId).first().catch(() => ({ c: 0 }));
  // Version distribution: from installed_version on device installations.
  const verRows: any = await env.DB.prepare(
    `SELECT installed_version AS v, COUNT(*) AS c FROM app_installations WHERE application_id=? AND status IN ('installed','update_available') AND installed_version IS NOT NULL AND installed_version != '' GROUP BY installed_version ORDER BY c DESC LIMIT 10`
  ).bind(appId).all().catch(() => ({ results: [] }));
  // Reviews + rating (applications columns are the canonical aggregate).
  const appRow: any = await env.DB.prepare('SELECT rating, review_count FROM applications WHERE id=?').bind(appId).first().catch(() => null);

  return {
    appId, slug: app.slug, name: app.name,
    downloads, installs, updates,
    activeInstallations: Number(activeRows?.c) || 0,
    platformDistribution: byPlatform,
    versionDistribution: (verRows?.results || []).map((r: any) => ({ version: r.v, count: Number(r.c) || 0 })),
    countryDistribution: byCountry,
    rating: Number(appRow?.rating) || 0,
    reviewCount: Number(appRow?.review_count) || 0,
  };
}

// ---------------------------------------------------------------------------
// Developer routes
// ---------------------------------------------------------------------------

export const developerFinanceRoutes = {

  /**
   * GET /developers/analytics — org-level aggregated analytics + revenue
   * summary. analytics.view. Aggregated only: zero customer-identifying data.
   */
  async analytics(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'analytics.view');
    if ('error' in guard && (guard as any).error) return guard;
    const ms = (guard as any).ms;
    const apps = await orgApps(env, ms.developer.id);
    const perApp = [];
    for (const app of apps) perApp.push(await appAnalytics(env, app));

    // Totals across the org.
    const totals = perApp.reduce((acc: any, a: any) => ({
      downloads: acc.downloads + a.downloads,
      installs: acc.installs + a.installs,
      updates: acc.updates + a.updates,
      activeInstallations: acc.activeInstallations + a.activeInstallations,
      reviewCount: acc.reviewCount + a.reviewCount,
    }), { downloads: 0, installs: 0, updates: 0, activeInstallations: 0, reviewCount: 0 });
    const platformDistribution: Record<string, number> = {};
    for (const a of perApp) for (const [p, c] of Object.entries(a.platformDistribution) as Array<[string, number]>) platformDistribution[p] = (platformDistribution[p] || 0) + c;

    // Revenue summary is aggregated (gross/refunds/fees/net) — analytics-view
    // roles see the NUMBERS; payout detail stays behind billing.manage.
    const revenue = await withPayouts(env, ms.developer.id, await revenueForApps(env, apps.map((a: any) => a.id)));

    return { totals: { ...totals, platformDistribution }, apps: perApp, revenue };
  },

  /**
   * GET /developers/revenue — financial detail: revenue lines + payout records
   * + billing settings. billing.manage ONLY (OWNER/ADMIN); DEVELOPER, ANALYST
   * and SUPPORT are refused (tested).
   */
  async revenue(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'billing.manage');
    if ('error' in guard && (guard as any).error) return guard;
    const ms = (guard as any).ms;
    const apps = await orgApps(env, ms.developer.id);
    const summary = await withPayouts(env, ms.developer.id, await revenueForApps(env, apps.map((a: any) => a.id)));

    // Per-app revenue (aggregated purchase sums — never customer rows).
    const perAppRevenue = [];
    for (const app of apps) {
      const r = await revenueForApps(env, [app.id]);
      perAppRevenue.push({ appId: app.id, name: app.name, slug: app.slug, ...r });
    }

    const payouts: any = await env.DB.prepare(
      'SELECT id, amount_minor, currency, status, period_start, period_end, processor_reference, failure_reason, paid_at, created_at, updated_at FROM developer_payouts WHERE developer_id=? ORDER BY created_at DESC LIMIT 100'
    ).bind(ms.developer.id).all().catch(() => ({ results: [] }));

    const billing: any = await env.DB.prepare(
      'SELECT payout_destination, payout_notes, min_payout_minor, updated_at FROM developer_billing WHERE developer_id=?'
    ).bind(ms.developer.id).first().catch(() => null);

    return {
      revenue: summary,
      perAppRevenue,
      payouts: payouts?.results || [],
      billing: billing ? {
        payoutDestination: billing.payout_destination,
        payoutNotes: billing.payout_notes,
        minPayoutMinor: Number(billing.min_payout_minor) || 0,
      } : null,
    };
  },

  /**
   * POST /developers/payouts/request — create a PENDING payout request for
   * the payable balance (net − paid − outstanding), respecting the org's
   * minimum payout. billing.manage ONLY.
   */
  async requestPayout(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'billing.manage');
    if ('error' in guard && (guard as any).error) return guard;
    const ms = (guard as any).ms;

    const apps = await orgApps(env, ms.developer.id);
    const summary = await withPayouts(env, ms.developer.id, await revenueForApps(env, apps.map((a: any) => a.id)));
    if (summary.pendingMinor <= 0) {
      return { error: 'There is no payable balance right now.', code: 'VALIDATION_ERROR' };
    }
    const billing: any = await env.DB.prepare('SELECT min_payout_minor FROM developer_billing WHERE developer_id=?').bind(ms.developer.id).first().catch(() => null);
    const minPayout = Number(billing?.min_payout_minor) || 10000;
    if (summary.pendingMinor < minPayout) {
      return { error: `The minimum payout is GH₵${(minPayout / 100).toFixed(2)} — your payable balance is GH₵${(summary.pendingMinor / 100).toFixed(2)}.`, code: 'VALIDATION_ERROR' };
    }

    const body = await bodyOf(request);
    void body;
    const id = rid('pay');
    await env.DB.prepare(
      `INSERT INTO developer_payouts (id, developer_id, amount_minor, currency, status, period_start, period_end, requested_by)
       VALUES (?,?,?,?, 'PENDING', ?, ?, ?)`
    ).bind(id, ms.developer.id, summary.pendingMinor, summary.currency,
      str(body.periodStart, 30) || null, str(body.periodEnd, 30) || null, userId).run();
    await auditDev(env, ms.developer.id, userId, 'payout_created', { payoutId: id, amountMinor: summary.pendingMinor });
    await globalAudit(env, 'payout_created', id, { developerId: ms.developer.id, amountMinor: summary.pendingMinor });
    return { payout: { id, amountMinor: summary.pendingMinor, status: 'PENDING' } };
  },

  /**
   * PATCH /developers/billing — payout destination (masked label only) and
   * minimum payout. billing.manage ONLY; audited as billing_settings_changed.
   */
  async updateBilling(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'billing.manage');
    if ('error' in guard && (guard as any).error) return guard;
    const ms = (guard as any).ms;

    const body = await bodyOf(request);
    const destination = str(body.payoutDestination, 120);
    const notes = str(body.payoutNotes, 300);
    // Masked-label policy: reject anything that looks like a raw account
    // number (long digit runs). The label is for humans, not for payouts.
    if (destination && /\d{10,}/.test(destination.replace(/\s/g, ''))) {
      return { error: 'Do not enter account numbers — store a masked label (e.g. “Mobile Money ••1234”). RX Store staff never need your full account details in this field.', code: 'VALIDATION_ERROR' };
    }
    // Preserve the saved minimum unless explicitly changed.
    const existing: any = await env.DB.prepare('SELECT min_payout_minor FROM developer_billing WHERE developer_id=?').bind(ms.developer.id).first().catch(() => null);
    let minPayout = Number(existing?.min_payout_minor) || 10000;
    if (body.minPayoutMinor !== undefined) {
      minPayout = Math.trunc(Number(body.minPayoutMinor));
      if (!Number.isFinite(minPayout) || minPayout < 0 || minPayout > 100_000_000) {
        return { error: 'Invalid minimum payout amount.', code: 'VALIDATION_ERROR' };
      }
    }

    await env.DB.prepare(
      `INSERT INTO developer_billing (developer_id, payout_destination, payout_notes, min_payout_minor, updated_at)
       VALUES (?,?,?,?, datetime('now'))
       ON CONFLICT(developer_id) DO UPDATE SET
         payout_destination=excluded.payout_destination, payout_notes=excluded.payout_notes,
         min_payout_minor=excluded.min_payout_minor, updated_at=datetime('now')`
    ).bind(ms.developer.id, destination || null, notes || null, minPayout).run();
    await auditDev(env, ms.developer.id, userId, 'billing_settings_changed', { destination: destination || null, minPayoutMinor: minPayout });
    await globalAudit(env, 'billing_settings_changed', ms.developer.id, { developerId: ms.developer.id });
    return { billing: { payoutDestination: destination || null, payoutNotes: notes || null, minPayoutMinor: minPayout } };
  },
};

// ---------------------------------------------------------------------------
// Admin routes (admin JWT enforced by index.ts)
// ---------------------------------------------------------------------------

export const adminFinanceRoutes = {

  /** GET /admin/finance/developers — revenue by developer org (reconciliation input). */
  async developerRevenue(request: Request, env: any) {
    const bps = await feeBps(env);
    const orgs: any = await env.DB.prepare(
      `SELECT d.id, p.publisher_name FROM developers d LEFT JOIN developer_profiles p ON p.developer_id=d.id ORDER BY d.created_at ASC LIMIT 200`
    ).all().catch(() => ({ results: [] }));
    const out = [];
    for (const org of orgs?.results || []) {
      const apps = await orgApps(env, org.id);
      const summary = await withPayouts(env, org.id, await revenueForApps(env, apps.map((a: any) => a.id)));
      out.push({ developerId: org.id, publisherName: org.publisher_name, appCount: apps.length, ...summary });
    }
    return { feePercent: bps / 100, developers: out };
  },

  /** GET /admin/finance/payouts?status= — payout requests + state. */
  async payouts(request: Request, env: any) {
    const status = new URL(request.url).searchParams.get('status') || '';
    const rows: any = await env.DB.prepare(
      `SELECT po.*, p.publisher_name, u.name AS requested_by_name
       FROM developer_payouts po
       LEFT JOIN developer_profiles p ON p.developer_id = po.developer_id
       LEFT JOIN users u ON u.id = po.requested_by
       ${status ? 'WHERE po.status = ?' : ''}
       ORDER BY po.created_at DESC LIMIT 200`
    ).bind(...(status ? [status] : [])).all().catch(() => ({ results: [] }));
    return {
      payouts: (rows?.results || []).map((p: any) => ({
        id: p.id, developerId: p.developer_id, publisherName: p.publisher_name,
        amountMinor: Number(p.amount_minor) || 0, currency: p.currency, status: p.status,
        periodStart: p.period_start, periodEnd: p.period_end,
        requestedBy: p.requested_by_name || p.requested_by, processorReference: p.processor_reference,
        failureReason: p.failure_reason, paidAt: p.paid_at, createdAt: p.created_at,
      })),
    };
  },

  /**
   * POST /admin/finance/payouts/:id/process {status: PROCESSING|PAID|FAILED|HELD|CANCELLED, reason?, reference?}
   * State machine + full audit (payout_updated / payout_processed /
   * payout_failed). FAILED requires a reason; PAID records the reference.
   */
  async processPayout(request: Request, env: any) {
    const adminId = ((request as any).user as any)?.userId || null;
    if (!adminId) return { error: 'Admin identity required', code: 'UNAUTHORIZED' };
    const id = decodeURIComponent(new URL(request.url).pathname.split('/')[4] || '');
    const body = await bodyOf(request);
    const status = str(body.status, 20).toUpperCase();
    if (!['PROCESSING', 'PAID', 'FAILED', 'HELD', 'CANCELLED'].includes(status)) {
      return { error: 'status must be PROCESSING, PAID, FAILED, HELD or CANCELLED', code: 'VALIDATION_ERROR' };
    }
    const payout: any = await env.DB.prepare('SELECT * FROM developer_payouts WHERE id=?').bind(id).first().catch(() => null);
    if (!payout) return { error: 'Payout not found', code: 'NOT_FOUND' };

    // State machine: PENDING -> PROCESSING -> PAID|FAILED; HELD from
    // PENDING/PROCESSING; CANCELLED only from PENDING/HELD; PAID only from
    // PROCESSING (or PENDING for simple processors).
    const allowed: Record<string, string[]> = {
      PROCESSING: ['PENDING'],
      PAID: ['PENDING', 'PROCESSING'],
      FAILED: ['PROCESSING', 'PENDING'],
      HELD: ['PENDING', 'PROCESSING'],
      CANCELLED: ['PENDING', 'HELD'],
    };
    if (!(allowed[status] || []).includes(payout.status)) {
      return { error: `A ${payout.status} payout cannot move to ${status}.`, code: 'VALIDATION_ERROR' };
    }
    const reason = str(body.reason, 1000);
    const reference = str(body.reference, 120);
    if (status === 'FAILED' && reason.length < 10) {
      return { error: 'A failure reason of at least 10 characters is required.', code: 'VALIDATION_ERROR' };
    }
    if (status === 'PAID' && !reference) {
      return { error: 'A processor reference is required to mark a payout PAID (reconciliation).', code: 'VALIDATION_ERROR' };
    }

    await env.DB.prepare(
      `UPDATE developer_payouts SET status=?, processor_reference=COALESCE(?, processor_reference),
         failure_reason=?, processed_by=?, paid_at=CASE WHEN ?='PAID' THEN datetime('now') ELSE paid_at END,
         updated_at=datetime('now') WHERE id=?`
    ).bind(status, reference || null, status === 'FAILED' ? reason : null, adminId, status, id).run();

    const action = status === 'PAID' ? 'payout_processed' : status === 'FAILED' ? 'payout_failed' : 'payout_updated';
    await globalAudit(env, action, id, { status, reason: reason || null, reference: reference || null, adminId, amountMinor: payout.amount_minor });
    await auditDev(env, payout.developer_id, adminId, action, { payoutId: id, status }).catch(() => {});
    return { payout: { id, status } };
  },

  /**
   * GET /admin/finance/reconciliation — marketplace money movement:
   * gross / refunds / fees / net / payouts(paid, outstanding) per org + total,
   * plus the purchase ledger counts backing each number.
   */
  async reconciliation(request: Request, env: any) {
    const bps = await feeBps(env);
    const orgs: any = await env.DB.prepare('SELECT id FROM developers LIMIT 200').all().catch(() => ({ results: [] }));
    const rows = [];
    let tGross = 0, tRefunds = 0, tFees = 0, tNet = 0, tPaid = 0, tOutstanding = 0;
    for (const org of orgs?.results || []) {
      const apps = await orgApps(env, org.id);
      const s = await withPayouts(env, org.id, await revenueForApps(env, apps.map((a: any) => a.id)));
      rows.push({ developerId: org.id, ...s });
      tGross += s.grossMinor; tRefunds += s.refundsMinor; tFees += s.feesMinor;
      tNet += s.netMinor; tPaid += s.paidMinor; tOutstanding += s.outstandingPayoutMinor;
    }
    const ledger: any = await env.DB.prepare(
      `SELECT status, COUNT(*) AS c, SUM(amount) AS total FROM purchases GROUP BY status`
    ).all().catch(() => ({ results: [] }));
    return {
      feePercent: bps / 100,
      totals: { grossMinor: tGross, refundsMinor: tRefunds, feesMinor: tFees, netMinor: tNet, paidMinor: tPaid, outstandingPayoutMinor: tOutstanding },
      developers: rows,
      purchaseLedger: (ledger?.results || []).map((l: any) => ({ status: l.status, count: Number(l.c) || 0, totalMinor: Number(l.total) || 0 })),
    };
  },
};
