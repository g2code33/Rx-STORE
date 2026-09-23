/**
 * Ratings & Reviews tests (Phase 17).
 *
 * Real route handlers (reviews.ts) against an in-memory D1 fake. Covers the
 * full matrix: authenticated/unauthenticated submission, one-active-review +
 * edit semantics, no-op edit rejection, validation + spam heuristics, the
 * per-user cooldown, verified-install evidence markers, rating aggregate
 * correctness (including exclusion of hidden/removed), pagination + summary,
 * reporting (reasons, duplicates), moderation (reason required, hide/restore/
 * remove, aggregate recompute, report resolution, audit history) and
 * developer-response permissions (role gate, org isolation).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reviewRoutes, developerReviewRoutes, adminReviewRoutes, recomputeAppRating, reviewSpamCheck } from './routes/reviews.ts';

// ---------------------------------------------------------------------------
// In-memory fake
// ---------------------------------------------------------------------------

function makeEnv() {
  const db: any = {
    users: [
      { id: 'u1', name: 'Alice', email: 'a@x.com', role: 'user', preferences: '{}' },
      { id: 'u2', name: 'Bob', email: 'b@x.com', role: 'user', preferences: '{}' },
      { id: 'admin1', name: 'Admin', email: 'adm@x.com', role: 'admin', preferences: '{}' },
    ],
    developers: [{ id: 'dev_a', user_id: 'u1', status: 'ACTIVE', created_at: '2026-01-01' }],
    developer_profiles: [{ developer_id: 'dev_a', publisher_name: 'Org A' }],
    developer_members: [{ id: 'dm1', developer_id: 'dev_a', user_id: 'u1', role: 'OWNER', created_at: '2026-01-01' }],
    applications: [
      { id: 'app_1', slug: 'clinic', name: 'Clinic Pro', status: 'active', rating: 0, review_count: 0, current_version: '2.0.0', developer_org_id: 'dev_a' },
      { id: 'app_2', slug: 'other-app', name: 'Other App', status: 'active', rating: 0, review_count: 0, current_version: '1.0.0', developer_org_id: null },
    ],
    reviews: [] as any[],
    review_reports: [] as any[],
    downloads: [] as any[],
    app_installations: [] as any[],
    audit_logs: [] as any[],
    developer_audit_logs: [] as any[],
    site_settings: [] as any[],
  };
  // Simulated clock offset in hours (for cooldown tests).
  let clockOffsetHours = 0;

  const DB = {
    prepare(sql: string) {
      const self: any = {
        _b: [] as any[],
        bind(...a: any[]) { self._b = a; return self; },
        async first() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          const now = new Date(Date.now() - clockOffsetHours * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
          if (s.includes('FROM developer_members m JOIN developers d')) {
            const m = db.developer_members.find((x: any) => x.user_id === a[0]);
            if (!m) return null;
            const d = db.developers.find((x: any) => x.id === m.developer_id);
            return { member_id: m.id, role: m.role, member_since: m.created_at, ...d };
          }
          if (s.includes('SELECT id, current_version FROM applications WHERE slug=?')) return db.applications.find((x: any) => x.slug === a[0]) || null;
          if (s.includes('SELECT id FROM applications WHERE slug=?')) return db.applications.find((x: any) => x.slug === a[0]) || null;
          if (s.includes('SELECT 1 AS ok FROM downloads WHERE app_id=? AND user_id=?')) return db.downloads.find((d: any) => d.app_id === a[0] && d.user_id === a[1]) ? { ok: 1 } : null;
          if (s.includes('FROM app_installations WHERE application_id=? AND user_id=?')) return db.app_installations.find((i: any) => i.application_id === a[0] && i.user_id === a[1]) ? { ok: 1 } : null;
          if (s.includes('SELECT id, rating, comment, title FROM reviews WHERE app_id=? AND user_id=?')) return db.reviews.find((r: any) => r.app_id === a[0] && r.user_id === a[1]) || null;
          if (s.includes('SELECT COUNT(*) AS c FROM reviews WHERE user_id=?')) {
            // updated_at within the last hour (with the simulated clock)
            const cutoff = new Date(Date.now() - 3600_000).toISOString().replace('T', ' ').slice(0, 19);
            const c = db.reviews.filter((r: any) => r.user_id === a[0] && String(r.updated_at) >= cutoff).length;
            return { c };
          }
          if (s.includes('SELECT id, app_id FROM reviews WHERE id=?')) return db.reviews.find((r: any) => r.id === a[0]) || null;
          if (s.includes('SELECT id, app_id, status FROM reviews WHERE id=?')) return db.reviews.find((r: any) => r.id === a[0]) || null;
          if (s.includes('SELECT r.id, a.id AS app_id, a.developer_org_id FROM reviews')) {
            const r = db.reviews.find((x: any) => x.id === a[0]);
            if (!r) return null;
            const app = db.applications.find((x: any) => x.id === r.app_id);
            return { id: r.id, app_id: r.app_id, developer_org_id: app?.developer_org_id ?? null };
          }
          if (s.includes('SELECT * FROM reviews WHERE id=?')) return db.reviews.find((r: any) => r.id === a[0]) || null;
          if (s.includes('SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM reviews')) {
            const rows = db.reviews.filter((r: any) => r.app_id === a[0] && (r.status || 'visible') === 'visible');
            if (!rows.length) return { avg: 0, cnt: 0 };
            return { avg: rows.reduce((s2: number, r: any) => s2 + r.rating, 0) / rows.length, cnt: rows.length };
          }
          if (s.includes('SELECT id, status FROM review_reports WHERE review_id=? AND reporter_user_id=?')) {
            return db.review_reports.find((x: any) => x.review_id === a[0] && x.reporter_user_id === a[1]) || null;
          }
          if (s.includes("SELECT value FROM site_settings WHERE key='reviews_open'")) {
            const row = db.site_settings.find((x: any) => x.key === 'reviews_open');
            return row ? { value: row.value } : null;
          }
          void now;
          return null;
        },
        async all() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('SELECT rating, COUNT(*) AS c FROM reviews WHERE app_id=?')) {
            const rows = db.reviews.filter((r: any) => r.app_id === a[0] && (r.status || 'visible') === 'visible');
            const by: Record<string, number> = {};
            for (const r of rows) by[r.rating] = (by[r.rating] || 0) + 1;
            return { results: Object.entries(by).map(([rating, c]) => ({ rating: Number(rating), c })) };
          }
          if (s.includes('FROM reviews r') && s.includes('LEFT JOIN users u') && s.includes('WHERE r.app_id=?') && s.includes('ORDER BY r.created_at DESC')) {
            const page = Number(self._page) || 1;
            const limit = Number(self._limit) || 10;
            const rows = db.reviews
              .filter((r: any) => r.app_id === a[0] && (r.status || 'visible') === 'visible')
              .sort((x: any, y: any) => String(y.created_at).localeCompare(String(x.created_at)))
              .slice((page - 1) * limit, page * limit)
              .map((r: any) => ({
                ...r,
                user_name: db.users.find((u: any) => u.id === r.user_id)?.name,
                developer_org_name: db.developer_profiles.find((p: any) => p.developer_id === db.applications.find((ap: any) => ap.id === r.app_id)?.developer_org_id)?.publisher_name,
              }));
            return { results: rows };
          }
          if (s.includes('FROM review_reports rp')) {
            return {
              results: db.review_reports
                .filter((x: any) => x.status === (a[0] || 'open'))
                .map((x: any) => ({
                  ...x,
                  report_id: x.id, reason: x.reason, details: x.details, report_status: x.status,
                  reported_at: x.created_at, reporter_user_id: x.reporter_user_id,
                  reporter_name: db.users.find((u: any) => u.id === x.reporter_user_id)?.name,
                  review_id: x.review_id,
                  rating: db.reviews.find((r: any) => r.id === x.review_id)?.rating,
                  body: db.reviews.find((r: any) => r.id === x.review_id)?.comment,
                  review_status: db.reviews.find((r: any) => r.id === x.review_id)?.status || 'visible',
                })),
            };
          }
          if (s.includes('FROM reviews r LEFT JOIN users u ON u.id = r.user_id') && s.includes('WHERE r.status = ?')) {
            return { results: db.reviews.filter((r: any) => (r.status || 'visible') === a[0]) };
          }
          return { results: [] };
        },
        async run() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          if (s.includes('INSERT INTO reviews')) {
            const [id, appId, userId, rating, title, comment, appVersion, platform, verified] = a;
            db.reviews.push({ id, app_id: appId, user_id: userId, rating, title, comment, app_version: appVersion, platform, verified_install: verified, helpful_count: 0, status: 'visible', created_at: now, updated_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE reviews SET rating=?')) {
            const r = db.reviews.find((x: any) => x.id === a[a.length - 1]);
            if (r) { r.rating = a[0]; r.title = a[1]; r.comment = a[2]; r.app_version = a[3]; r.platform = a[4]; r.verified_install = a[5]; r.updated_at = now; }
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE reviews SET status=?')) {
            const r = db.reviews.find((x: any) => x.id === a[a.length - 1]);
            if (r) { r.status = a[0]; r.moderation_reason = a[1]; r.moderated_at = now; r.moderated_by = a[2]; }
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE reviews SET developer_response=?')) {
            const r = db.reviews.find((x: any) => x.id === a[a.length - 1]);
            if (r) { r.developer_response = a[0]; r.developer_responded_at = now; r.developer_responder_id = a[1]; }
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE applications SET rating=?')) {
            const app = db.applications.find((x: any) => x.id === a[2]);
            if (app) { app.rating = a[0]; app.review_count = a[1]; }
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO review_reports')) {
            db.review_reports.push({ id: a[0], review_id: a[1], reporter_user_id: a[2], reason: a[3], details: a[4], status: 'open', created_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes("UPDATE review_reports SET status='resolved'")) {
            db.review_reports.forEach((x: any) => { if (x.review_id === a[1] && x.status === 'open') { x.status = 'resolved'; x.resolved_by = a[0]; } });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO audit_logs')) { db.audit_logs.push({ id: a[0], action: a[1], resource_id: a[3], details: a[4] }); return { meta: { changes: 1 } }; }
          if (s.includes('INSERT INTO developer_audit_logs')) { db.developer_audit_logs.push({ id: a[0], action: a[3] }); return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  // capture page/limit binds for the list query
  const origPrepare = DB.prepare.bind(DB);
  (DB as any).prepare = (sql: string) => {
    const stmt: any = origPrepare(sql);
    const origBind = stmt.bind.bind(stmt);
    stmt.bind = (...a: any[]) => {
      const s = sql.replace(/\s+/g, ' ');
      if (/LIMIT \? OFFSET \?$/.test(s)) { stmt._limit = a[1]; stmt._page = Math.floor(a[2] / Math.max(1, a[1])) + 1; }
      return origBind(...a);
    };
    return stmt;
  };
  const env = { DB, __db: db };
  (env as any).__tick = (hours: number) => { clockOffsetHours = hours; };
  return env;
}

// Token helper: the handlers parse a Bearer token via verifyAccessToken — the
// fake env has no real JWT_SECRET flow, so build a real token with the shared
// secret convention used by the tests' env.
import { generateToken } from './services/auth.ts';
const SECRET = 'test-secret-please-rotate';
function authReq(userId: string | null, body: any, path: string, method = 'POST') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (userId) {
    // generateToken is async — precompute below via await in tests instead.
    void headers;
  }
  void body; void path; void method;
  throw new Error('use authReqAsync');
}
void authReq;

async function req(userId: string | null, body: any, path: string, method = 'POST'): Promise<Request> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (userId) headers.Authorization = `Bearer ${await generateToken({ userId, role: 'user' }, SECRET)}`;
  const r = new Request(`https://api.rxstore.com${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  if (userId) (r as any).user = { userId };
  return r;
}

// ---------------------------------------------------------------------------

async function seeded() {
  const env: any = makeEnv();
  env.JWT_SECRET = SECRET;
  return env;
}

// ---------------------------------------------------------------------------
// Submission: auth, create, edit, duplicates, validation, spam, cooldown
// ---------------------------------------------------------------------------

test('unauthenticated submission is rejected', async () => {
  const env = await seeded();
  const out: any = await reviewRoutes.submit(await req(null, { rating: 5, comment: 'Great app' }, '/apps/clinic/reviews'), env);
  assert.equal(out.code, 'UNAUTHORIZED');
});

test('authenticated submission creates ONE review; resubmission edits (no duplicate rows)', async () => {
  const env = await seeded();
  const first: any = await reviewRoutes.submit(await req('u1', { rating: 5, title: 'Excellent', comment: 'Works perfectly for my clinic' }, '/apps/clinic/reviews'), env);
  assert.equal(first.edited, false);
  assert.equal(first.review.rating, 5);
  assert.equal(first.review.title, 'Excellent');
  assert.equal(first.review.appVersion, '2.0.0', 'app version captured');

  const second: any = await reviewRoutes.submit(await req('u1', { rating: 3, title: 'Update', comment: 'Changed my mind after the update' }, '/apps/clinic/reviews'), env);
  assert.equal(second.edited, true, 'resubmission is an EDIT');
  assert.equal(env.__db.reviews.length, 1, 'still exactly one review row (one active review per user per app)');
  assert.equal(env.__db.reviews[0].rating, 3);
});

test('a no-op edit (same content) is rejected as a duplicate', async () => {
  const env = await seeded();
  await reviewRoutes.submit(await req('u1', { rating: 4, title: 'Good', comment: 'Solid and reliable tool' }, '/apps/clinic/reviews'), env);
  const out: any = await reviewRoutes.submit(await req('u1', { rating: 4, title: 'Good', comment: 'Solid and reliable tool' }, '/apps/clinic/reviews'), env);
  assert.equal(out.code, 'VALIDATION_ERROR');
  assert.ok(String(out.error).includes('No changes'));
});

test('rating bounds and body length are validated', async () => {
  const env = await seeded();
  assert.equal((await reviewRoutes.submit(await req('u1', { rating: 0, comment: 'xxxxxxxx' }, '/apps/clinic/reviews'), env)).code, 'VALIDATION_ERROR');
  assert.equal((await reviewRoutes.submit(await req('u1', { rating: 6, comment: 'xxxxxxxx' }, '/apps/clinic/reviews'), env)).code, 'VALIDATION_ERROR');
  assert.equal((await reviewRoutes.submit(await req('u1', { rating: 5, comment: 'ok' }, '/apps/clinic/reviews'), env)).code, 'VALIDATION_ERROR', 'body < 4 chars');
});

test('spam heuristics: filler runs and ALL-CAPS shouting are rejected (pure fn)', () => {
  assert.ok(reviewSpamCheck({ body: 'great app aaaaaaaaaaaaaaa' }));
  assert.ok(reviewSpamCheck({ body: 'THIS APP IS TOTALLY AMAZING AND EVERYONE SHOULD USE IT RIGHT NOW OK' }));
  assert.equal(reviewSpamCheck({ body: 'Works great for tracking my clinical attachments daily.' }), null);
  assert.equal(reviewSpamCheck({ title: 'Solid', body: 'Reliable, fast, and the support team answers quickly.' }), null);
});

test('cooldown: reviewing more than 5 apps within an hour is rate limited', async () => {
  const env = await seeded();
  // The limit counts review rows created/edited in the window (one row per
  // user per app) — so exercise it across six different apps.
  const slugs = ['clinic', 'other-app'];
  for (let i = 2; i < 6; i++) {
    env.__db.applications.push({ id: `app_${i}`, slug: `app-${i}`, name: `App ${i}`, status: 'active', rating: 0, review_count: 0, current_version: '1.0.0', developer_org_id: null });
    slugs.push(`app-${i}`);
  }
  for (const slug of slugs) {
    const r: any = await reviewRoutes.submit(await req('u1', { rating: 5, comment: `Honest review of ${slug} after use` }, `/apps/${slug}/reviews`), env);
    assert.ok(!r.error, `review of ${slug} should succeed`);
  }
  const blocked: any = await reviewRoutes.submit(await req('u1', { rating: 2, comment: 'A sixth review within the hour' }, '/apps/clinic/reviews'), env);
  assert.equal(blocked.code, 'RATE_LIMITED');
});

test('verified install is a factual marker from the download/install ledger', async () => {
  const env = await seeded();
  // No evidence:
  const none: any = await reviewRoutes.submit(await req('u2', { rating: 5, comment: 'Nice application overall' }, '/apps/clinic/reviews'), env);
  assert.equal(none.review.verifiedInstall, false);
  // Download evidence:
  env.__db.downloads.push({ app_id: 'app_1', user_id: 'u2' });
  const edited: any = await reviewRoutes.submit(await req('u2', { rating: 4, comment: 'Updating after real usage' }, '/apps/clinic/reviews'), env);
  assert.equal(edited.review.verifiedInstall, true, 'marker appears once evidence exists');
});

// ---------------------------------------------------------------------------
// Aggregates + list (summary, distribution, pagination, own marker)
// ---------------------------------------------------------------------------

test('rating aggregate = average + count over VISIBLE reviews only', async () => {
  const env = await seeded();
  await reviewRoutes.submit(await req('u1', { rating: 5, comment: 'Five stars, love it' }, '/apps/clinic/reviews'), env);
  await reviewRoutes.submit(await req('u2', { rating: 3, comment: 'Three stars, decent app' }, '/apps/clinic/reviews'), env);
  let app = env.__db.applications.find((a: any) => a.id === 'app_1');
  assert.equal(app.review_count, 2);
  assert.equal(app.rating, 4, 'average of 5 and 3');

  // Hide one — the aggregate must recompute over visible only.
  env.__db.reviews[0].status = 'hidden';
  await recomputeAppRating(env, 'app_1');
  app = env.__db.applications.find((a: any) => a.id === 'app_1');
  assert.equal(app.review_count, 1);
  assert.equal(app.rating, 3);
});

test('list returns TRUE summary (not page-scoped), distribution, pagination + own marker', async () => {
  const env = await seeded();
  // 12 reviews from 12 users would need more users; instead vary apps — use 12
  // users via id suffixes (fake users list is small; the fake joins by id).
  for (let i = 0; i < 12; i++) {
    env.__db.users.push({ id: `u${100 + i}`, name: `User ${i}`, role: 'user' });
    await reviewRoutes.submit(await req(`u${100 + i}`, { rating: (i % 5) + 1, comment: `Review number ${i} content` }, '/apps/clinic/reviews'), env);
  }

  const page1: any = await reviewRoutes.list(new Request('https://api.rxstore.com/apps/clinic/reviews?page=1&limit=10'), env);
  assert.equal(page1.reviews.length, 10, 'page size respected');
  assert.equal(page1.summary.count, 12, 'summary counts ALL visible reviews');
  assert.equal(page1.pagination.total, 12);
  assert.equal(page1.pagination.hasNext, true);
  const dist = Object.fromEntries(page1.summary.distribution.map((d: any) => [d.stars, d.count]));
  assert.equal(dist[1] + dist[2] + dist[3] + dist[4] + dist[5], 12, 'distribution adds up');

  const page2: any = await reviewRoutes.list(new Request('https://api.rxstore.com/apps/clinic/reviews?page=2&limit=10'), env);
  assert.equal(page2.reviews.length, 2);
  assert.equal(page2.pagination.hasNext, false);

  // own marker: a viewer sees their own review flagged.
  const withViewer: any = await reviewRoutes.list(new Request('https://api.rxstore.com/apps/clinic/reviews?page=1&limit=50', { headers: { Authorization: `Bearer ${await generateToken({ userId: 'u100' }, SECRET)}` } }), env);
  const own = withViewer.reviews.filter((r: any) => r.own);
  assert.equal(own.length, 1);
  assert.equal(own[0].appVersion, '2.0.0');
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test('reporting: fixed reasons, duplicates rejected, unknown reasons rejected', async () => {
  const env = await seeded();
  const created: any = await reviewRoutes.submit(await req('u1', { rating: 5, comment: 'Great clinical software' }, '/apps/clinic/reviews'), env);
  const reviewId = created.review.id;

  const bad: any = await reviewRoutes.report(await req('u2', { reason: 'mean' }, `/reviews/${reviewId}/report`), env);
  assert.equal(bad.code, 'VALIDATION_ERROR');

  const ok: any = await reviewRoutes.report(await req('u2', { reason: 'spam', details: 'Posted everywhere' }, `/reviews/${reviewId}/report`), env);
  assert.equal(ok.report.reason, 'spam');

  const dup: any = await reviewRoutes.report(await req('u2', { reason: 'spam' }, `/reviews/${reviewId}/report`), env);
  assert.equal(dup.code, 'VALIDATION_ERROR', 'one report per user per review');

  // A second user may also report it.
  env.__db.users.push({ id: 'u3', name: 'Cara', role: 'user' });
  const also: any = await reviewRoutes.report(await req('u3', { reason: 'harassment' }, `/reviews/${reviewId}/report`), env);
  assert.ok(also.report);
});

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

async function reportedReview() {
  const env = await seeded();
  const created: any = await reviewRoutes.submit(await req('u1', { rating: 1, title: 'Terrible', comment: 'This app deleted my files' }, '/apps/clinic/reviews'), env);
  await reviewRoutes.report(await req('u2', { reason: 'fraudulent' }, `/reviews/${created.review.id}/report`), env);
  return { env, reviewId: created.review.id as string };
}

test('moderation: reason required; hide/restore/remove transitions; aggregate recomputed', async () => {
  const { env, reviewId } = await reportedReview();
  const admin = (b: any, p: string) => req('admin1', b, p);

  const noReason: any = await adminReviewRoutes.moderate(await admin({}, `/admin/reviews/${reviewId}/moderate`), env);
  assert.equal(noReason.code, 'VALIDATION_ERROR');

  const hide: any = await adminReviewRoutes.moderate(await admin({ action: 'hide', reason: 'Unsubstantiated claim posted repeatedly.' }, `/admin/reviews/${reviewId}/moderate`), env);
  assert.equal(hide.review.status, 'hidden');
  assert.equal(env.__db.applications.find((a: any) => a.id === 'app_1').review_count, 0, 'hidden review excluded from aggregate');

  const dupHide: any = await adminReviewRoutes.moderate(await admin({ action: 'hide', reason: 'Trying to hide it again now.' }, `/admin/reviews/${reviewId}/moderate`), env);
  assert.equal(dupHide.code, 'VALIDATION_ERROR', 'already hidden');

  const restore: any = await adminReviewRoutes.moderate(await admin({ action: 'restore', reason: 'Reporter retracted; the claim was real.' }, `/admin/reviews/${reviewId}/moderate`), env);
  assert.equal(restore.review.status, 'visible');
  assert.equal(env.__db.applications.find((a: any) => a.id === 'app_1').review_count, 1);

  const remove: any = await adminReviewRoutes.moderate(await admin({ action: 'remove', reason: 'Confirmed policy violation after review.' }, `/admin/reviews/${reviewId}/moderate`), env);
  assert.equal(remove.review.status, 'removed');
  assert.equal(env.__db.reviews.length, 1, 'the ROW is preserved — removal is a status, never a delete');
  assert.equal(env.__db.reviews[0].moderation_reason, 'Confirmed policy violation after review.');
  assert.equal(env.__db.reviews[0].moderated_by, 'admin1');

  // Open reports on the review were resolved by the moderation decision.
  assert.equal(env.__db.review_reports[0].status, 'resolved');
  // Audit history exists for every action.
  const actions = env.__db.audit_logs.map((l: any) => l.action);
  assert.ok(actions.includes('review_hidden') && actions.includes('review_restored') && actions.includes('review_removed'));
});

test('hidden/removed reviews never appear in the public list', async () => {
  const { env, reviewId } = await reportedReview();
  await adminReviewRoutes.moderate(await req('admin1', { action: 'hide', reason: 'Spam wave from a single account.' }, `/admin/reviews/${reviewId}/moderate`), env);
  const list: any = await reviewRoutes.list(new Request('https://api.rxstore.com/apps/clinic/reviews'), env);
  assert.equal(list.reviews.length, 0);
  assert.equal(list.summary.count, 0);
});

// ---------------------------------------------------------------------------
// Developer responses
// ---------------------------------------------------------------------------

test('developer response: permission-gated, org-scoped, clearly attributable', async () => {
  const env = await seeded();
  // A review on ORG A's app by u2.
  const created: any = await reviewRoutes.submit(await req('u2', { rating: 2, comment: 'Crashes on startup sometimes' }, '/apps/clinic/reviews'), env);
  const reviewId = created.review.id;

  // u1 is OWNER of org A (has reviews.manage) — may respond.
  const ok: any = await developerReviewRoutes.respond(await req('u1', { response: 'Fixed in 2.0.1 — please update and let us know.' }, `/developers/reviews/${reviewId}/respond`), env);
  assert.equal(ok.success, true);
  const stored = env.__db.reviews[0];
  assert.equal(stored.developer_response, 'Fixed in 2.0.1 — please update and let us know.');
  assert.equal(stored.developer_responder_id, 'u1');
  assert.ok(env.__db.developer_audit_logs.some((l: any) => l.action === 'developer_review_response'));

  // A member WITHOUT reviews.manage cannot respond.
  env.__db.developer_members.push({ id: 'dm2', developer_id: 'dev_a', user_id: 'u2', role: 'DEVELOPER', created_at: 'now' });
  const denied: any = await developerReviewRoutes.respond(await req('u2', { response: 'Dev role tries to respond now' }, `/developers/reviews/${reviewId}/respond`), env);
  assert.equal(denied.code, 'FORBIDDEN', 'DEVELOPER role lacks reviews.manage');
  env.__db.developer_members.pop();

  // A review on ANOTHER org's app (app_2 has no org) is out of scope.
  env.__db.users.push({ id: 'u9', name: 'Nine', role: 'user' });
  const other: any = await reviewRoutes.submit(await req('u9', { rating: 5, comment: 'Unrelated app review here' }, '/apps/other-app/reviews'), env);
  const cross: any = await developerReviewRoutes.respond(await req('u1', { response: 'Trying to respond to a foreign app' }, `/developers/reviews/${other.review.id}/respond`), env);
  assert.equal(cross.code, 'FORBIDDEN');

  // The public list labels the response with the org name.
  const list: any = await reviewRoutes.list(new Request('https://api.rxstore.com/apps/clinic/reviews'), env);
  assert.equal(list.reviews[0].developerResponse.byOrgName, 'Org A', 'clearly identified as an Org A response');
});
