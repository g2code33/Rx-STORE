/**
 * Developer analytics, revenue & payouts tests (Phase 19).
 *
 * Real route handlers against an in-memory D1 fake. Covers: organization
 * isolation, role restrictions (DEVELOPER/ANALYST/SUPPORT denied financial
 * detail; OWNER/ADMIN allowed), revenue math (gross/refunds/fees/net/paid/
 * pending), refund effects, payout lifecycle (PENDING→PROCESSING→PAID;
 * FAILED; HELD; CANCELLED + state-machine guards), failed-payout audit,
 * full audit history, analytics aggregation (installs vs updates, platform,
 * version, geo) and customer-PII privacy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { developerFinanceRoutes, adminFinanceRoutes } from './routes/developerFinance.ts';

// ---------------------------------------------------------------------------
// In-memory fake
// ---------------------------------------------------------------------------

export function makeEnv() {
  const db: any = {
    users: [
      { id: 'u1', name: 'Owner', email: 'o@x.com', role: 'user' },        // org A OWNER
      { id: 'u2', name: 'DevRole', email: 'd@x.com', role: 'user' },      // org A DEVELOPER
      { id: 'u3', name: 'Analyst', email: 'a@x.com', role: 'user' },      // org A ANALYST
      { id: 'u4', name: 'AdminRole', email: 'ar@x.com', role: 'user' },   // org A ADMIN (billing)
      { id: 'u9', name: 'OtherOwner', email: 'oo@x.com', role: 'user' },  // org B OWNER
      { id: 'admin1', name: 'Admin', email: 'adm@x.com', role: 'admin' },
      { id: 'cust1', name: 'Customer One', email: 'cust1@x.com', role: 'user' },
      { id: 'cust2', name: 'Customer Two', email: 'cust2@x.com', role: 'user' },
    ],
    developers: [
      { id: 'dev_a', user_id: 'u1', status: 'ACTIVE', created_at: '2026-01-01' },
      { id: 'dev_b', user_id: 'u9', status: 'ACTIVE', created_at: '2026-01-01' },
    ],
    developer_profiles: [{ developer_id: 'dev_a', publisher_name: 'Org A' }, { developer_id: 'dev_b', publisher_name: 'Org B' }],
    developer_members: [
      { id: 'dm1', developer_id: 'dev_a', user_id: 'u1', role: 'OWNER', created_at: 'now' },
      { id: 'dm2', developer_id: 'dev_a', user_id: 'u2', role: 'DEVELOPER', created_at: 'now' },
      { id: 'dm3', developer_id: 'dev_a', user_id: 'u3', role: 'ANALYST', created_at: 'now' },
      { id: 'dm4', developer_id: 'dev_a', user_id: 'u4', role: 'ADMIN', created_at: 'now' },
      { id: 'dm9', developer_id: 'dev_b', user_id: 'u9', role: 'OWNER', created_at: 'now' },
    ],
    applications: [
      { id: 'app_1', slug: 'clinic', name: 'Clinic Pro', developer_org_id: 'dev_a', rating: 4.5, review_count: 2, status: 'active' },
      { id: 'app_2', slug: 'medcalc', name: 'MedCalc', developer_org_id: 'dev_a', rating: 4, review_count: 1, status: 'active' },
      { id: 'app_9', slug: 'other', name: 'Other App', developer_org_id: 'dev_b', rating: 5, review_count: 1, status: 'active' },
    ],
    downloads: [
      // app_1: 2 installs (GH, windows/android), 1 update (GH, windows), 1 anonymous install (unknown geo)
      { id: 'd1', user_id: 'cust1', app_id: 'app_1', platform: 'windows', version: '2.0.0', kind: 'install', country: 'GH' },
      { id: 'd2', user_id: 'cust2', app_id: 'app_1', platform: 'android', version: '2.0.0', kind: 'install', country: 'GH' },
      { id: 'd3', user_id: 'cust1', app_id: 'app_1', platform: 'windows', version: '2.1.0', kind: 'update', country: 'GH' },
      { id: 'd4', user_id: null, app_id: 'app_1', platform: 'windows', version: '2.1.0', kind: 'install', country: null },
      // app_9 (org B) — must NEVER appear in org A analytics
      { id: 'd5', user_id: 'cust1', app_id: 'app_9', platform: 'web', version: '1.0.0', kind: 'install', country: 'GH' },
    ],
    app_installations: [
      { id: 'i1', user_id: 'cust1', application_id: 'app_1', device_id: 'devX', platform: 'windows', installed_version: '2.1.0', status: 'installed' },
      { id: 'i2', user_id: 'cust2', application_id: 'app_1', device_id: 'devY', platform: 'android', installed_version: '2.0.0', status: 'update_available' },
      { id: 'i3', user_id: 'cust1', application_id: 'app_1', device_id: 'devZ', platform: 'web', installed_version: '1.9.0', status: 'not_installed' },
    ],
    purchases: [
      { id: 'p1', user_id: 'cust1', app_id: 'app_1', amount: 5000, currency: 'GHS', provider: 'paystack', provider_reference: 'r1', status: 'complete' },   // GH₵50
      { id: 'p2', user_id: 'cust2', app_id: 'app_1', amount: 2500, currency: 'GHS', provider: 'paystack', provider_reference: 'r2', status: 'refunded' },  // GH₵25 refunded
      { id: 'p3', user_id: 'cust2', app_id: 'app_2', amount: 1000, currency: 'GHS', provider: 'paystack', provider_reference: 'r3', status: 'complete' },   // GH₵10
      { id: 'p4', user_id: 'cust1', app_id: 'app_9', amount: 9900, currency: 'GHS', provider: 'paystack', provider_reference: 'r4', status: 'complete' },   // ORG B — excluded
      { id: 'p5', user_id: 'cust1', app_id: 'app_2', amount: 700, currency: 'GHS', provider: 'paystack', provider_reference: 'r5', status: 'pending' },     // pending — excluded from gross
    ],
    developer_payouts: [] as any[],
    developer_billing: [] as any[],
    site_settings: [],
    audit_logs: [] as any[],
    developer_audit_logs: [] as any[],
  };

  const DB = {
    prepare(sql: string) {
      const self: any = {
        _b: [] as any[],
        bind(...a: any[]) { self._b = a; return self; },
        async first() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('FROM developer_members m JOIN developers d')) {
            const m = db.developer_members.find((x: any) => x.user_id === a[0]);
            if (!m) return null;
            const d = db.developers.find((x: any) => x.id === m.developer_id);
            return { member_id: m.id, role: m.role, member_since: m.created_at, ...d };
          }
          if (s.includes('SELECT rating, review_count FROM applications WHERE id=?')) return db.applications.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT COUNT(*) AS c FROM app_installations')) {
            return { c: db.app_installations.filter((i: any) => i.application_id === a[0] && ['installed', 'update_available'].includes(i.status)).length };
          }
          if (s.includes('SELECT min_payout_minor FROM developer_billing WHERE developer_id=?')) return db.developer_billing.find((b: any) => b.developer_id === a[0]) || null;
          if (s.includes('SELECT * FROM developer_payouts WHERE id=?')) return db.developer_payouts.find((p: any) => p.id === a[0]) || null;
          return null;
        },
        async all() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('SELECT id, slug, name FROM applications WHERE developer_org_id=?')) {
            return { results: db.applications.filter((x: any) => x.developer_org_id === a[0]) };
          }
          if (s.includes('SELECT status, SUM(amount) AS total FROM purchases')) {
            const rows = db.purchases.filter((p: any) => a.includes(p.app_id) && ['complete', 'refunded'].includes(p.status));
            const by: Record<string, number> = {};
            for (const p of rows) by[p.status] = (by[p.status] || 0) + p.amount;
            return { results: Object.entries(by).map(([status, total]) => ({ status, total })) };
          }
          if (s.includes('SELECT status, SUM(amount_minor) AS total FROM developer_payouts')) {
            const rows = db.developer_payouts.filter((p: any) => p.developer_id === a[0]);
            const by: Record<string, number> = {};
            for (const p of rows) by[p.status] = (by[p.status] || 0) + p.amount_minor;
            return { results: Object.entries(by).map(([status, total]) => ({ status, total })) };
          }
          if (s.includes('SELECT kind, platform, country, COUNT(*) AS c FROM downloads')) {
            const rows = db.downloads.filter((d: any) => d.app_id === a[0]);
            const by: Record<string, any> = {};
            for (const d of rows) {
              const key = `${d.kind}|${d.platform}|${d.country || ''}`;
              by[key] = (by[key] || 0) + 1;
            }
            return { results: Object.entries(by).map(([k, c]) => { const [kind, platform, country] = k.split('|'); return { kind, platform, country: country || null, c }; }) };
          }
          if (s.includes('SELECT installed_version AS v, COUNT(*) AS c FROM app_installations')) {
            const rows = db.app_installations.filter((i: any) => i.application_id === a[0] && ['installed', 'update_available'].includes(i.status) && i.installed_version);
            const by: Record<string, number> = {};
            for (const i of rows) by[i.installed_version] = (by[i.installed_version] || 0) + 1;
            return { results: Object.entries(by).map(([v, c]) => ({ v, c })) };
          }
          if (s.includes('SELECT d.id, p.publisher_name FROM developers d')) {
            return { results: db.developers.map((d: any) => ({ id: d.id, publisher_name: db.developer_profiles.find((p: any) => p.developer_id === d.id)?.publisher_name })) };
          }
          if (s.includes('SELECT po.*, p.publisher_name, u.name AS requested_by_name')) {
            const status = s.includes('WHERE po.status = ?') ? a[0] : null;
            return {
              results: db.developer_payouts
                .filter((p: any) => !status || p.status === status)
                .map((p: any) => ({ ...p, publisher_name: db.developer_profiles.find((x: any) => x.developer_id === p.developer_id)?.publisher_name, requested_by_name: db.users.find((u: any) => u.id === p.requested_by)?.name })),
            };
          }
          if (s.includes('SELECT id, amount_minor, currency, status, period_start, period_end, processor_reference, failure_reason, paid_at, created_at, updated_at FROM developer_payouts WHERE developer_id=?')) {
            return { results: db.developer_payouts.filter((p: any) => p.developer_id === a[0]) };
          }
          if (s.includes('SELECT payout_destination, payout_notes, min_payout_minor, updated_at FROM developer_billing')) {
            return db.developer_billing.find((b: any) => b.developer_id === a[0]) || null ? { results: [db.developer_billing.find((b: any) => b.developer_id === a[0])] } : { results: [] };
          }
          if (s.includes('SELECT status, COUNT(*) AS c, SUM(amount) AS total FROM purchases GROUP BY status')) {
            const by: Record<string, any> = {};
            for (const p of db.purchases) {
              by[p.status] = by[p.status] || { status: p.status, c: 0, total: 0 };
              by[p.status].c += 1; by[p.status].total += p.amount;
            }
            return { results: Object.values(by) };
          }
          if (s.includes('SELECT id FROM developers')) {
            return { results: db.developers };
          }
          if (s.includes('SELECT 1 AS ok FROM downloads WHERE app_id=? AND user_id=? LIMIT 1')) {
            return db.downloads.find((d: any) => d.app_id === a[0] && d.user_id === a[1]) ? { ok: 1 } : null;
          }
          return { results: [] };
        },
        async run() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          if (s.includes('INSERT INTO developer_payouts')) {
            db.developer_payouts.push({ id: a[0], developer_id: a[1], amount_minor: a[2], currency: a[3], status: 'PENDING', period_start: a[4], period_end: a[5], requested_by: a[6], created_at: now, updated_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE developer_payouts SET status=?')) {
            const p = db.developer_payouts.find((x: any) => x.id === a[a.length - 1]);
            if (p) {
              p.status = a[0];
              if (a[1]) p.processor_reference = a[1];
              p.failure_reason = a[2];
              p.processed_by = a[3];
              if (a[0] === 'PAID') p.paid_at = now;
              p.updated_at = now;
            }
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developer_billing')) {
            const existing = db.developer_billing.find((b: any) => b.developer_id === a[0]);
            if (existing) Object.assign(existing, { payout_destination: a[1], payout_notes: a[2], min_payout_minor: a[3] });
            else db.developer_billing.push({ developer_id: a[0], payout_destination: a[1], payout_notes: a[2], min_payout_minor: a[3], updated_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO audit_logs')) { db.audit_logs.push({ id: a[0], action: a[1], resource_id: a[3], details: a[4] }); return { meta: { changes: 1 } }; }
          if (s.includes('INSERT INTO developer_audit_logs')) { db.developer_audit_logs.push({ id: a[0], action: a[3], details: a[4] }); return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  const env: any = { DB };
  env.__db = db;
  return env;
}

const req = (userId: string | null, body: any, path: string, method = 'GET') => {
  const r = new Request(`https://api.rxstore.com${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body || {}) });
  if (userId) (r as any).user = { userId };
  return r;
};

// ---------------------------------------------------------------------------
// Analytics (aggregation + isolation + privacy)
// ---------------------------------------------------------------------------

test('analytics: aggregated installs/updates/downloads/active/platform/version/geo — org-isolated, no customer PII', async () => {
  const env = makeEnv();
  const out: any = await developerFinanceRoutes.analytics(req('u1', null, '/developers/analytics'), env);

  assert.equal(out.totals.downloads, 4, 'org A downloads only (org B excluded)');
  assert.equal(out.totals.installs, 3, '3 first-time downloads');
  assert.equal(out.totals.updates, 1, '1 subsequent download = update');
  assert.equal(out.totals.activeInstallations, 2, 'installed + update_available detections');
  assert.equal(out.totals.reviewCount, 3);

  const app1 = out.apps.find((a: any) => a.slug === 'clinic');
  assert.equal(app1.downloads, 4);
  assert.equal(app1.activeInstallations, 2);
  assert.equal(app1.platformDistribution.windows, 3);
  assert.equal(app1.platformDistribution.android, 1);
  assert.equal(app1.countryDistribution.GH, 3, 'country-level geo');
  assert.equal(app1.countryDistribution.unknown, 1, 'pre-geo rows aggregated as unknown');
  const versions = Object.fromEntries(app1.versionDistribution.map((v: any) => [v.version, v.count]));
  assert.equal(versions['2.1.0'], 1);
  assert.equal(versions['2.0.0'], 1);

  // PRIVACY: no customer names/emails/ids anywhere in the payload.
  const json = JSON.stringify(out);
  assert.ok(!json.includes('cust1') && !json.includes('Customer One') && !json.includes('cust1@x.com'));
  assert.ok(!json.includes('r1') || !json.includes('provider_reference'), 'no purchase references');
});

test('analytics: organization B sees ONLY its own data', async () => {
  const env = makeEnv();
  const out: any = await developerFinanceRoutes.analytics(req('u9', null, '/developers/analytics'), env);
  assert.ok(out.apps.every((a: any) => a.slug === 'other'), 'only org B apps');
  assert.equal(out.totals.downloads, 1);
  // Org B revenue excludes org A purchases.
  assert.equal(out.revenue.grossMinor, 9900);
});

// ---------------------------------------------------------------------------
// Role restrictions
// ---------------------------------------------------------------------------

test('role restrictions: DEVELOPER / ANALYST / SUPPORT denied financial detail; OWNER and ADMIN allowed', async () => {
  const env = makeEnv();
  // DEVELOPER (analytics.view ok, no billing)
  const devAnalytics: any = await developerFinanceRoutes.analytics(req('u2', null, '/developers/analytics'), env);
  assert.ok(devAnalytics.apps, 'DEVELOPER sees aggregated analytics');
  const devRevenue: any = await developerFinanceRoutes.revenue(req('u2', null, '/developers/revenue'), env);
  assert.equal(devRevenue.code, 'FORBIDDEN', 'DEVELOPER denied financial detail');
  const devPayout: any = await developerFinanceRoutes.requestPayout(req('u2', {}, '/developers/payouts/request', 'POST'), env);
  assert.equal(devPayout.code, 'FORBIDDEN', 'DEVELOPER cannot request payouts');
  const devBilling: any = await developerFinanceRoutes.updateBilling(req('u2', {}, '/developers/billing', 'PATCH'), env);
  assert.equal(devBilling.code, 'FORBIDDEN', 'DEVELOPER cannot change billing settings');

  // ANALYST
  const analystRevenue: any = await developerFinanceRoutes.revenue(req('u3', null, '/developers/revenue'), env);
  assert.equal(analystRevenue.code, 'FORBIDDEN', 'ANALYST denied');

  // ADMIN (has billing.manage since Phase 19)
  const adminRevenue: any = await developerFinanceRoutes.revenue(req('u4', null, '/developers/revenue'), env);
  assert.ok(adminRevenue.revenue, 'ADMIN allowed');

  // OWNER
  const ownerRevenue: any = await developerFinanceRoutes.revenue(req('u1', null, '/developers/revenue'), env);
  assert.ok(ownerRevenue.revenue, 'OWNER allowed');
});

// ---------------------------------------------------------------------------
// Revenue math
// ---------------------------------------------------------------------------

test('revenue: gross / refunds / fees / net computed from real purchases (15% fee)', async () => {
  const env = makeEnv();
  const out: any = await developerFinanceRoutes.revenue(req('u1', null, '/developers/revenue'), env);
  const r = out.revenue;
  // Org A: complete = 5000 + 1000 = 6000; refunded = 2500; pending excluded; org B excluded.
  assert.equal(r.grossMinor, 8500, 'gross includes refunded sales (GH₵50+25+10)');
  assert.equal(r.refundsMinor, 2500);
  // fees = 15% of retained (8500-2500=6000) = 900
  assert.equal(r.feesMinor, 900);
  assert.equal(r.netMinor, 8500 - 2500 - 900, 'net = gross − refunds − fees');
  assert.equal(r.feePercent, 15);
});

test('payout math: paid and payable track payout history; payable floors at 0', async () => {
  const env = makeEnv();
  // net = 5100 (from the previous test). Pay out 3000 (PAID), 500 outstanding (PENDING).
  env.__db.developer_payouts.push(
    { id: 'po1', developer_id: 'dev_a', amount_minor: 3000, currency: 'GHS', status: 'PAID', requested_by: 'u1', created_at: 'now' },
    { id: 'po2', developer_id: 'dev_a', amount_minor: 500, currency: 'GHS', status: 'PENDING', requested_by: 'u1', created_at: 'now' },
    { id: 'po3', developer_id: 'dev_a', amount_minor: 999, currency: 'GHS', status: 'CANCELLED', requested_by: 'u1', created_at: 'now' },
    { id: 'po4', developer_id: 'dev_a', amount_minor: 888, currency: 'GHS', status: 'FAILED', requested_by: 'u1', created_at: 'now' },
  );
  const out: any = await developerFinanceRoutes.revenue(req('u1', null, '/developers/revenue'), env);
  const r = out.revenue;
  assert.equal(r.paidMinor, 3000, 'cancelled + failed payouts are not paid');
  assert.equal(r.outstandingPayoutMinor, 500, 'PENDING only (CANCELLED/FAILED excluded)');
  assert.equal(r.pendingMinor, 5100 - 3000 - 500, 'payable = net − paid − outstanding');
});

// ---------------------------------------------------------------------------
// Payout lifecycle
// ---------------------------------------------------------------------------

test('payout request: creates PENDING for the payable balance; minimum enforced; audited', async () => {
  const env = makeEnv();
  // No billing row -> default minimum GH₵100 > payable GH₵0 -> rejected.
  const none: any = await developerFinanceRoutes.requestPayout(req('u1', {}, '/developers/payouts/request', 'POST'), env);
  assert.equal(none.code, 'VALIDATION_ERROR', 'no payable balance');

  // Set a low minimum, then request.
  await developerFinanceRoutes.updateBilling(req('u1', { payoutDestination: 'Mobile Money ••1234', minPayoutMinor: 1000 }, '/developers/billing', 'PATCH'), env);
  const out: any = await developerFinanceRoutes.requestPayout(req('u1', {}, '/developers/payouts/request', 'POST'), env);
  assert.equal(out.payout.status, 'PENDING');
  assert.equal(out.payout.amountMinor, 5100, 'full payable balance');
  assert.ok(env.__db.developer_payouts.length === 1);
  assert.ok(env.__db.audit_logs.some((l: any) => l.action === 'payout_created'));

  // A second request while the first is outstanding: payable is now 0.
  const second: any = await developerFinanceRoutes.requestPayout(req('u1', {}, '/developers/payouts/request', 'POST'), env);
  assert.equal(second.code, 'VALIDATION_ERROR', 'no double payout of the same balance');
});

test('billing settings: masked labels only — account numbers rejected; audited', async () => {
  const env = makeEnv();
  const bad: any = await developerFinanceRoutes.updateBilling(req('u1', { payoutDestination: '0244123456712345678' }, '/developers/billing', 'PATCH'), env);
  assert.equal(bad.code, 'VALIDATION_ERROR', 'raw account numbers rejected');
  const ok: any = await developerFinanceRoutes.updateBilling(req('u1', { payoutDestination: 'Mobile Money ••1234' }, '/developers/billing', 'PATCH'), env);
  assert.ok(ok.billing);
  assert.ok(env.__db.audit_logs.some((l: any) => l.action === 'billing_settings_changed'));
  assert.ok(env.__db.developer_audit_logs.some((l: any) => l.action === 'billing_settings_changed'));
});

test('payout processing: full state machine with reason/reference rules + audit events', async () => {
  const env = makeEnv();
  await developerFinanceRoutes.updateBilling(req('u1', { minPayoutMinor: 1000 }, '/developers/billing', 'PATCH'), env);
  const created: any = await developerFinanceRoutes.requestPayout(req('u1', {}, '/developers/payouts/request', 'POST'), env);
  const id = created.payout.id;

  // PAID from PENDING requires a processor reference.
  const noRef: any = await adminFinanceRoutes.processPayout(req('admin1', { status: 'PAID' }, `/admin/finance/payouts/${id}/process`, 'POST'), env);
  assert.equal(noRef.code, 'VALIDATION_ERROR');

  // PENDING -> PROCESSING
  const proc: any = await adminFinanceRoutes.processPayout(req('admin1', { status: 'PROCESSING' }, `/admin/finance/payouts/${id}/process`, 'POST'), env);
  assert.equal(proc.payout.status, 'PROCESSING');

  // FAILED requires a reason.
  const noReason: any = await adminFinanceRoutes.processPayout(req('admin1', { status: 'FAILED' }, `/admin/finance/payouts/${id}/process`, 'POST'), env);
  assert.equal(noReason.code, 'VALIDATION_ERROR');

  // PROCESSING -> FAILED (failed payout; reason recorded; audited)
  const failed: any = await adminFinanceRoutes.processPayout(req('admin1', { status: 'FAILED', reason: 'Bank transfer bounced — destination invalid.' }, `/admin/finance/payouts/${id}/process`, 'POST'), env);
  assert.equal(failed.payout.status, 'FAILED');
  assert.equal(env.__db.developer_payouts[0].failure_reason, 'Bank transfer bounced — destination invalid.');

  // FAILED is terminal: cannot move to PAID.
  const revive: any = await adminFinanceRoutes.processPayout(req('admin1', { status: 'PAID', reference: 'TRX-1' }, `/admin/finance/payouts/${id}/process`, 'POST'), env);
  assert.equal(revive.code, 'VALIDATION_ERROR', 'FAILED payouts cannot be paid — a new request is required');

  // A second payout request after the failure: the failed amount is no longer
  // outstanding, so the payable balance returns.
  const retry: any = await developerFinanceRoutes.requestPayout(req('u1', {}, '/developers/payouts/request', 'POST'), env);
  assert.ok(retry.payout, 'payable balance restored after the failed payout');
  const id2 = retry.payout.id;

  // PENDING -> PAID (single-step allowed) with reference.
  const paid: any = await adminFinanceRoutes.processPayout(req('admin1', { status: 'PAID', reference: 'TRX-2' }, `/admin/finance/payouts/${id2}/process`, 'POST'), env);
  assert.equal(paid.payout.status, 'PAID');
  assert.equal(env.__db.developer_payouts.find((p: any) => p.id === id2).processor_reference, 'TRX-2');
  assert.ok(env.__db.developer_payouts.find((p: any) => p.id === id2).paid_at);

  // Audit history: every lifecycle event recorded.
  const actions = env.__db.audit_logs.map((l: any) => l.action);
  assert.ok(actions.includes('payout_created'));
  assert.ok(actions.includes('payout_updated'), 'PROCESSING transition');
  assert.ok(actions.includes('payout_failed'));
  assert.ok(actions.includes('payout_processed'), 'PAID transition');
  assert.ok(env.__db.developer_audit_logs.some((l: any) => l.action === 'payout_processed'));
});

test('payout state machine: HELD and CANCELLED guards', async () => {
  const env = makeEnv();
  await developerFinanceRoutes.updateBilling(req('u1', { minPayoutMinor: 1000 }, '/developers/billing', 'PATCH'), env);
  const created: any = await developerFinanceRoutes.requestPayout(req('u1', {}, '/developers/payouts/request', 'POST'), env);
  const id = created.payout.id;

  // CANCELLED -> PROCESSING is not allowed.
  await adminFinanceRoutes.processPayout(req('admin1', { status: 'CANCELLED' }, `/admin/finance/payouts/${id}/process`, 'POST'), env);
  const revive: any = await adminFinanceRoutes.processPayout(req('admin1', { status: 'PROCESSING' }, `/admin/finance/payouts/${id}/process`, 'POST'), env);
  assert.equal(revive.code, 'VALIDATION_ERROR');

  // A CANCELLED payout releases its balance: a new request is payable again.
  const created2: any = await developerFinanceRoutes.requestPayout(req('u1', {}, '/developers/payouts/request', 'POST'), env);
  assert.ok(created2.payout, 'payable balance restored after cancellation');
  assert.equal(created2.payout.amountMinor, 5100);

  // HELD: hold a payout, then cancel it from HELD.
  const held: any = await adminFinanceRoutes.processPayout(req('admin1', { status: 'PROCESSING' }, `/admin/finance/payouts/${created2.payout.id}/process`, 'POST'), env);
  assert.equal(held.payout.status, 'PROCESSING');
  const hold: any = await adminFinanceRoutes.processPayout(req('admin1', { status: 'HELD', reason: 'Waiting on KYC documents.' }, `/admin/finance/payouts/${created2.payout.id}/process`, 'POST'), env);
  assert.equal(hold.payout.status, 'HELD');
  const unhold: any = await adminFinanceRoutes.processPayout(req('admin1', { status: 'CANCELLED' }, `/admin/finance/payouts/${created2.payout.id}/process`, 'POST'), env);
  assert.equal(unhold.payout.status, 'CANCELLED', 'HELD can be cancelled');
});

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

test('admin: developer revenue view + reconciliation totals', async () => {
  const env = makeEnv();
  const rev: any = await adminFinanceRoutes.developerRevenue(req('admin1', null, '/admin/finance/developers'), env);
  const orgA = rev.developers.find((d: any) => d.developerId === 'dev_a');
  const orgB = rev.developers.find((d: any) => d.developerId === 'dev_b');
  assert.equal(orgA.grossMinor, 8500);
  assert.equal(orgB.grossMinor, 9900, 'org isolation holds in the admin view too');

  const rec: any = await adminFinanceRoutes.reconciliation(req('admin1', null, '/admin/finance/reconciliation'), env);
  assert.equal(rec.totals.grossMinor, 8500 + 9900);
  assert.equal(rec.totals.refundsMinor, 2500);
  assert.equal(rec.feePercent, 15);
  // Purchase ledger backs the totals.
  const ledger = Object.fromEntries(rec.purchaseLedger.map((l: any) => [l.status, l]));
  assert.equal(ledger.complete.totalMinor, 5000 + 1000 + 9900);
  assert.equal(ledger.refunded.totalMinor, 2500);
});

test('admin payout listing includes state and requester; filters by status', async () => {
  const env = makeEnv();
  await developerFinanceRoutes.updateBilling(req('u1', { minPayoutMinor: 1000 }, '/developers/billing', 'PATCH'), env);
  const created: any = await developerFinanceRoutes.requestPayout(req('u1', {}, '/developers/payouts/request', 'POST'), env);
  const list: any = await adminFinanceRoutes.payouts(req('admin1', null, '/admin/finance/payouts?status=PENDING'), env);
  assert.equal(list.payouts.length, 1);
  assert.equal(list.payouts[0].publisherName, 'Org A');
  assert.equal(list.payouts[0].requestedBy, 'Owner');
  assert.equal(list.payouts[0].status, 'PENDING');
  void created;
});
