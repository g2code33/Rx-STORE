/**
 * Developer Platform tests (Phase 11 §16).
 *
 * Hermetic: real route handlers from backend/src/routes/developers.ts against
 * an in-memory D1 fake (same pattern as security.test.ts). Covers the
 * acceptance list: application workflow, admin review, organization creation,
 * team roles, escalation protection, final-owner protection, org isolation,
 * communication privacy, suspension, and audit events.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { developerRoutes, adminDeveloperRoutes } from './routes/developers.ts';
import { hasPermission, permissionsForRole } from './services/developerPermissions.ts';
import { hashToken } from './services/sessions.ts';

// ---------------------------------------------------------------------------
// In-memory D1 fake (dispatches on the SQL shapes used by developers.ts)
// ---------------------------------------------------------------------------

function makeEnv() {
  const db: any = {
    users: [
      { id: 'u1', name: 'Owner One', email: 'owner@example.com', role: 'user' },
      { id: 'u2', name: 'Teammate Two', email: 'mate@example.com', role: 'user' },
      { id: 'u3', name: 'Intruder Three', email: 'intruder@example.com', role: 'user' },
      { id: 'admin1', name: 'Admin', email: 'admin@example.com', role: 'admin' },
    ],
    developer_applications: [],
    developers: [],
    developer_profiles: [],
    developer_members: [],
    developer_invitations: [],
    developer_audit_logs: [],
    developer_threads: [],
    developer_thread_messages: [],
    notifications: [],
    audit_logs: [],
    applications: [],
    releases: [],
    reviews: [],
  };

  const findMemberJoin = (userId: string) => {
    const m = db.developer_members.find((x: any) => x.user_id === userId);
    if (!m) return null;
    const d = db.developers.find((x: any) => x.id === m.developer_id);
    return { member_id: m.id, role: m.role, member_since: m.created_at, ...d };
  };

  const DB = {
    prepare(sql: string) {
      const self: any = {
        _b: [] as any[],
        bind(...a: any[]) { self._b = a; return self; },
        async first() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('FROM developer_members m JOIN developers d')) return findMemberJoin(a[0]);
          if (s.includes('FROM developer_applications WHERE user_id=?')) {
            return db.developer_applications.find((x: any) => x.user_id === a[0]) || null;
          }
          if (s.includes('FROM developer_applications WHERE id=?')) {
            return db.developer_applications.find((x: any) => x.id === a[0]) || null;
          }
          if (s.includes('FROM developers WHERE application_id=?')) {
            return db.developers.find((x: any) => x.application_id === a[0]) || null;
          }
          if (s.includes('FROM developers WHERE id=?')) {
            return db.developers.find((x: any) => x.id === a[0]) || null;
          }
          if (s.includes('FROM developer_profiles WHERE developer_id=?')) {
            return db.developer_profiles.find((x: any) => x.developer_id === a[0]) || null;
          }
          if (s.includes('FROM developer_members WHERE developer_id=? AND user_id=?')) {
            return db.developer_members.find((x: any) => x.developer_id === a[0] && x.user_id === a[1]) || null;
          }
          if (s.includes('SELECT m.id FROM developer_members m JOIN users u')) {
            const m = db.developer_members.find((x: any) => x.developer_id === a[0]);
            if (!m) return null;
            const u = db.users.find((x: any) => x.id === m.user_id);
            return (u && String(u.email).toLowerCase() === String(a[1]).toLowerCase()) ? m : null;
          }
          if (s.includes('FROM developer_invitations WHERE developer_id=? AND LOWER(email)=?')) {
            return db.developer_invitations.find((x: any) => x.developer_id === a[0] && x.email === a[1] && x.status === 'PENDING') || null;
          }
          if (s.includes('SELECT COUNT(*) AS c FROM developer_invitations')) {
            return { c: db.developer_invitations.filter((x: any) => x.developer_id === a[0] && x.status === 'PENDING').length };
          }
          if (s.includes('FROM developer_invitations WHERE token_hash=?')) {
            return db.developer_invitations.find((x: any) => x.token_hash === a[0]) || null;
          }
          if (s.includes('FROM developer_invitations WHERE id=? AND developer_id=?')) {
            return db.developer_invitations.find((x: any) => x.id === a[0] && x.developer_id === a[1]) || null;
          }
          if (s.includes("SELECT COUNT(*) AS c FROM developer_members WHERE developer_id=? AND role='OWNER'")) {
            return { c: db.developer_members.filter((x: any) => x.developer_id === a[0] && x.role === 'OWNER').length };
          }
          if (s.includes('FROM developer_threads WHERE id=? AND developer_id=?')) {
            return db.developer_threads.find((x: any) => x.id === a[0] && x.developer_id === a[1]) || null;
          }
          if (s.includes('FROM developer_threads WHERE id=?')) {
            return db.developer_threads.find((x: any) => x.id === a[0]) || null;
          }
          if (s.includes('FROM users WHERE id=?')) {
            return db.users.find((x: any) => x.id === a[0]) || null;
          }
          if (s.includes('SELECT d.id, d.status, d.created_at, p.publisher_name, p.logo, p.description')) {
            const d = db.developers.find((x: any) => x.id === a[0] && x.status === 'ACTIVE');
            if (!d) return null;
            const p = db.developer_profiles.find((x: any) => x.developer_id === a[0]);
            return { ...d, publisher_name: p?.publisher_name, logo: p?.logo, description: p?.description, website: p?.website, support_url: p?.support_url };
          }
          return null;
        },
        async all() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes("SELECT id FROM users WHERE role='admin'")) return { results: db.users.filter((u: any) => u.role === 'admin') };
          if (s.includes('FROM developer_audit_logs WHERE developer_id=?')) {
            return { results: db.developer_audit_logs.filter((x: any) => x.developer_id === a[0]).slice().reverse() };
          }
          if (s.includes('FROM developer_members m JOIN users u ON u.id=m.user_id WHERE m.developer_id=?')) {
            return { results: db.developer_members.filter((x: any) => x.developer_id === a[0]).map((m: any) => {
              const u = db.users.find((x: any) => x.id === m.user_id);
              return { id: m.id, role: m.role, created_at: m.created_at, user_id: m.user_id, name: u?.name, email: u?.email };
            }) };
          }
          if (s.includes("FROM developer_invitations WHERE developer_id=? AND status='PENDING'")) {
            return { results: db.developer_invitations.filter((x: any) => x.developer_id === a[0] && x.status === 'PENDING') };
          }
          if (s.includes('FROM developer_threads t WHERE t.developer_id=?')) {
            return { results: db.developer_threads.filter((t: any) => t.developer_id === a[0]).map((t: any) => ({
              ...t, unread: db.developer_thread_messages.filter((m: any) => m.thread_id === t.id && m.sender_context === 'ADMIN' && !m.read_by_developer_at).length,
            })) };
          }
          if (s.includes('FROM developer_thread_messages WHERE thread_id=? ORDER BY created_at ASC')) {
            return { results: db.developer_thread_messages.filter((m: any) => m.thread_id === a[0]) };
          }
          if (s.includes('SELECT t.*, (SELECT COUNT(*)')) {
            return { results: db.developer_threads.map((t: any) => ({
              ...t, publisher_name: db.developer_profiles.find((p: any) => p.developer_id === t.developer_id)?.publisher_name,
              unread: db.developer_thread_messages.filter((m: any) => m.thread_id === t.id && m.sender_context === 'DEVELOPER' && !m.read_by_admin_at).length,
            })) };
          }
          if (s.includes('FROM applications WHERE developer_org_id=? ORDER BY created_at DESC')) {
            return { results: db.applications.filter((x: any) => x.developer_org_id === a[0]) };
          }
          if (s.includes('FROM releases r JOIN applications a ON a.id = r.application_id')) {
            const appIds = db.applications.filter((x: any) => x.developer_org_id === a[0]).map((x: any) => x.id);
            return { results: db.releases.filter((r: any) => appIds.includes(r.application_id)) };
          }
          if (s.includes('FROM reviews rv JOIN applications a ON a.id = rv.app_id')) {
            const appIds = db.applications.filter((x: any) => x.developer_org_id === a[0]).map((x: any) => x.id);
            return { results: db.reviews.filter((r: any) => appIds.includes(r.app_id)) };
          }
          if (s.includes('FROM developer_applications a LEFT JOIN users u ON u.id = a.user_id')) {
            const rows = a.length ? db.developer_applications.filter((x: any) => x.status === a[0]) : db.developer_applications;
            return { results: rows.map((x: any) => ({ ...x, user_name: db.users.find((u: any) => u.id === x.user_id)?.name, user_email: db.users.find((u: any) => u.id === x.user_id)?.email })) };
          }
          if (s.includes('FROM developer_members m JOIN users u ON u.id=m.user_id WHERE m.developer_id=?')) {
            return { results: db.developer_members.filter((x: any) => x.developer_id === a[0]).map((m: any) => {
              const u = db.users.find((x: any) => x.id === m.user_id);
              return { role: m.role, created_at: m.created_at, user_id: m.user_id, name: u?.name, email: u?.email };
            }) };
          }
          if (s.includes('SELECT d.id, d.status, d.created_at, p.publisher_name')) {
            return { results: db.developers.map((d: any) => ({
              id: d.id, status: d.status, created_at: d.created_at,
              publisher_name: db.developer_profiles.find((p: any) => p.developer_id === d.id)?.publisher_name,
              member_count: db.developer_members.filter((m: any) => m.developer_id === d.id).length,
              app_count: db.applications.filter((x: any) => x.developer_org_id === d.id).length,
            })) };
          }
          if (s.includes('FROM applications WHERE developer_org_id=? AND status=\'active\'')) {
            return { results: db.applications.filter((x: any) => x.developer_org_id === a[0] && x.status === 'active') };
          }
          if (s.includes('SELECT d.id, d.status, d.created_at, p.publisher_name, p.logo, p.description')) {
            const d = db.developers.find((x: any) => x.id === a[0]);
            const p = db.developer_profiles.find((x: any) => x.developer_id === a[0]);
            return { results: [d && p ? { ...d, publisher_name: p.publisher_name, logo: p.logo, description: p.description, website: p.website, support_url: p.support_url } : null].filter(Boolean) };
          }
          if (s.includes('SELECT user_id FROM developer_members WHERE developer_id=?')) {
            return { results: db.developer_members.filter((x: any) => x.developer_id === a[0]).map((m: any) => ({ user_id: m.user_id })) };
          }
          return { results: [] };
        },
        async run() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          const now = new Date().toISOString();
          if (s.includes('INSERT INTO developer_audit_logs')) {
            db.developer_audit_logs.push({ id: a[0], developer_id: a[1], actor_user_id: a[2], action: a[3], details: a[4], created_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO audit_logs')) {
            db.audit_logs.push({ id: a[0], action: a[1], resource_type: a[2], resource_id: a[3], details: a[4] });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO notifications')) {
            db.notifications.push({ id: a[0], user_id: a[1], type: a[2], title: a[3], message: a[4] });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developer_applications')) {
            db.developer_applications.push({
              id: a[0], user_id: a[1], status: 'DRAFT', publisher_name: a[2], developer_type: a[3],
              contact_email: a[4], support_email: a[5], website: a[6], country: a[7], description: a[8],
              category: a[9], accepted_terms: a[10], terms_accepted_at: a[11], created_at: now, updated_at: now,
            });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE developer_applications SET')) {
            const app = db.developer_applications.find((x: any) => x.id === a[a.length - 1]);
            if (!app) return { meta: { changes: 0 } };
            if (s.includes(`status='SUBMITTED'`)) { app.status = 'SUBMITTED'; app.submitted_at = now; app.accepted_terms = 1; app.review_reason = null; }
            else if (s.includes(`status='UNDER_REVIEW'`)) app.status = 'UNDER_REVIEW';
            else if (s.includes(`status='REJECTED'`)) { app.status = 'REJECTED'; app.reviewed_at = now; app.review_reason = a[0]; app.reviewed_by = a[1]; }
            else if (s.includes(`status='CHANGES_REQUESTED'`)) { app.status = 'CHANGES_REQUESTED'; app.reviewed_at = now; app.review_reason = a[0]; app.reviewed_by = a[1]; }
            else if (s.includes(`status='APPROVED'`) && s.includes('review_reason=NULL, updated_at')) { app.status = 'APPROVED'; app.reviewed_at = now; app.review_reason = null; }
            else if (s.includes(`status='SUSPENDED'`)) { app.status = 'SUSPENDED'; app.review_reason = a[0]; }
            else {
              // Generic field update: fields are the bound values before the id.
              const setMatch = s.match(/SET (.*) WHERE id=\?/);
              if (setMatch) {
                const cols = setMatch[1].split(', ').map((c: string) => c.split('=')[0].trim()).filter((c) => c !== 'updated_at');
                cols.forEach((c, i) => { (app as any)[c] = a[i]; });
              }
            }
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developers')) {
            db.developers.push({ id: a[0], user_id: a[1], application_id: a[2], status: 'ACTIVE', created_at: now, updated_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developer_profiles')) {
            db.developer_profiles.push({ developer_id: a[0], publisher_name: a[1], description: a[2], website: a[3], support_url: a[4] });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developer_members')) {
            // The approval flow writes role as a SQL literal ('OWNER'); team
            // management binds it as a parameter.
            const role = s.includes("'OWNER'") ? 'OWNER' : a[3];
            db.developer_members.push({ id: a[0], developer_id: a[1], user_id: a[2], role, created_at: now, updated_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE developer_members SET role=?')) {
            const m = db.developer_members.find((x: any) => x.id === a[1]);
            if (m) m.role = a[0];
            return { meta: { changes: 1 } };
          }
          if (s.includes('DELETE FROM developer_members')) {
            const i = db.developer_members.findIndex((x: any) => x.id === a[0]);
            if (i >= 0) db.developer_members.splice(i, 1);
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developer_invitations')) {
            db.developer_invitations.push({ id: a[0], developer_id: a[1], email: a[2], role: a[3], token_hash: a[4], status: 'PENDING', invited_by: a[5], expires_at: a[6], created_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes("UPDATE developer_invitations SET status='CANCELLED'")) {
            const inv = db.developer_invitations.find((x: any) => x.id === a[0]); if (inv) inv.status = 'CANCELLED';
            return { meta: { changes: 1 } };
          }
          if (s.includes("UPDATE developer_invitations SET status='ACCEPTED'")) {
            const inv = db.developer_invitations.find((x: any) => x.id === a[0]); if (inv) { inv.status = 'ACCEPTED'; inv.accepted_at = now; }
            return { meta: { changes: 1 } };
          }
          if (s.includes("UPDATE developer_invitations SET status='EXPIRED'")) {
            const inv = db.developer_invitations.find((x: any) => x.id === a[0]); if (inv) inv.status = 'EXPIRED';
            return { meta: { changes: 1 } };
          }
          if (s.includes("UPDATE developer_invitations SET status='EXPIRED' WHERE developer_id=? AND status='PENDING'")) {
            db.developer_invitations.forEach((x: any) => { if (x.developer_id === a[0] && x.status === 'PENDING') x.status = 'EXPIRED'; });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE applications SET developer_org_id=?')) {
            db.applications.forEach((x: any) => { if (x.developer_id === a[1] && !x.developer_org_id) x.developer_org_id = a[0]; });
            return { meta: { changes: 1 } };
          }
          if (s.includes("UPDATE developers SET status='SUSPENDED'")) {
            const d = db.developers.find((x: any) => x.id === a[1]); if (d) { d.status = 'SUSPENDED'; d.suspended_reason = a[0]; }
            return { meta: { changes: 1 } };
          }
          if (s.includes("UPDATE developers SET status='ACTIVE'")) {
            const d = db.developers.find((x: any) => x.id === a[0]); if (d) { d.status = 'ACTIVE'; d.suspended_reason = null; }
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developer_threads')) {
            db.developer_threads.push({ id: a[0], developer_id: a[1], subject: a[2], related_application_id: a[3], related_app_id: a[4], related_release_id: a[5], status: 'AWAITING_ADMIN', action_required: 1, created_at: now, updated_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developer_thread_messages')) {
            db.developer_thread_messages.push({ id: a[0], thread_id: a[1], sender_user_id: a[2], sender_context: s.includes("'DEVELOPER', ?") || s.includes("'DEVELOPER',?, ?") ? 'DEVELOPER' : 'ADMIN', body: a[3] ?? a[4], created_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes("UPDATE developer_threads SET status='AWAITING_ADMIN'")) {
            const t = db.developer_threads.find((x: any) => x.id === a[0]); if (t) { t.status = 'AWAITING_ADMIN'; t.updated_at = now; }
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE developer_threads SET status=?, action_required=?')) {
            const t = db.developer_threads.find((x: any) => x.id === a[2]); if (t) { t.status = a[0]; t.action_required = a[1]; t.updated_at = now; }
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE developer_thread_messages SET read_by_developer_at')) {
            db.developer_thread_messages.forEach((m: any) => { if (m.thread_id === a[0] && m.sender_context === 'ADMIN') m.read_by_developer_at = now; });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE developer_thread_messages SET read_by_admin_at')) {
            db.developer_thread_messages.forEach((m: any) => { if (m.thread_id === a[0] && m.sender_context === 'DEVELOPER') m.read_by_admin_at = now; });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  return { DB, db };
}

const req = (userId: string | null, body: any, path: string, method = 'POST') => {
  const r = new Request(`https://api.rxstore.com${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  if (userId) (r as any).user = { userId };
  return r;
};

const APPLICATION = {
  publisher_name: 'Calcitonin Technologies', developer_type: 'organization',
  contact_email: 'owner@example.com', support_email: 'support@example.com',
  website: 'https://example.com', country: 'Ghana',
  description: 'We build healthcare and education software for West Africa.',
  category: 'Healthcare', accepted_terms: true,
};

/** Apply + submit + approve, returning the env and created developer id. */
async function approvedDeveloper() {
  const env = makeEnv();
  await developerRoutes.saveApplication(req('u1', APPLICATION, '/developers/apply'), env);
  await developerRoutes.submitApplication(req('u1', {}, '/developers/application/submit'), env);
  const app = env.db.developer_applications[0];
  await adminDeveloperRoutes.approveApplication(req('admin1', {}, `/admin/developers/applications/${app.id}/approve`), env);
  return { env, devId: env.db.developers[0].id, appId: app.id };
}

// ---------------------------------------------------------------------------
// Application workflow
// ---------------------------------------------------------------------------

test('a normal user with no application reports NOT_APPLIED', async () => {
  const env = makeEnv();
  const out: any = await developerRoutes.getStatus(req('u3', null, '/developers/me', 'GET'), env);
  assert.equal(out.status, 'NOT_APPLIED');
  assert.equal(out.application, null);
});

test('a normal user cannot access developer organization data', async () => {
  const { env } = await approvedDeveloper();
  const out: any = await developerRoutes.getOrganization(req('u3', null, '/developers/organization', 'GET'), env);
  assert.equal(out.code, 'FORBIDDEN');
});

test('a signed-in user can begin an application (DRAFT)', async () => {
  const env = makeEnv();
  const out: any = await developerRoutes.saveApplication(req('u1', { publisher_name: 'X' }, '/developers/apply'), env);
  assert.equal(out.application.status, 'DRAFT');
  assert.equal(env.db.developer_applications.length, 1);
});

test('drafts can be saved repeatedly (continue later)', async () => {
  const env = makeEnv();
  await developerRoutes.saveApplication(req('u1', { publisher_name: 'X' }, '/developers/apply'), env);
  const out: any = await developerRoutes.saveApplication(req('u1', { country: 'Ghana', description: 'Updated draft text' }, '/developers/application', 'PATCH'), env);
  assert.equal(out.saved, true);
  assert.equal(env.db.developer_applications[0].country, 'Ghana');
  assert.equal(env.db.developer_applications.length, 1, 'still one application per user');
});

test('submission requires terms and complete fields', async () => {
  const env = makeEnv();
  await developerRoutes.saveApplication(req('u1', { publisher_name: 'X' }, '/developers/apply'), env);
  const out: any = await developerRoutes.submitApplication(req('u1', {}, '/developers/application/submit'), env);
  assert.equal(out.code, 'VALIDATION_ERROR');
  assert.ok(Array.isArray(out.errors) && out.errors.length > 0, 'reports the missing fields');
});

test('a complete application submits: DRAFT -> SUBMITTED (audit + admin notification)', async () => {
  const env = makeEnv();
  await developerRoutes.saveApplication(req('u1', APPLICATION, '/developers/apply'), env);
  const out: any = await developerRoutes.submitApplication(req('u1', {}, '/developers/application/submit'), env);
  assert.equal(out.application.status, 'SUBMITTED');
  assert.ok(env.db.audit_logs.some((l: any) => l.action === 'developer_application_submitted'));
  assert.ok(env.db.notifications.some((n: any) => n.user_id === 'admin1'), 'admins are notified');
});

test('a pending (submitted) applicant still has NO organization and cannot publish', async () => {
  const env = makeEnv();
  await developerRoutes.saveApplication(req('u1', APPLICATION, '/developers/apply'), env);
  await developerRoutes.submitApplication(req('u1', {}, '/developers/application/submit'), env);
  const status: any = await developerRoutes.getStatus(req('u1', null, '/developers/me', 'GET'), env);
  assert.equal(status.status, 'SUBMITTED');
  assert.equal(status.developer, null, 'no organization until approval');
  const org: any = await developerRoutes.getOrganization(req('u1', null, '/developers/organization', 'GET'), env);
  assert.equal(org.code, 'FORBIDDEN');
});

// ---------------------------------------------------------------------------
// Admin review
// ---------------------------------------------------------------------------

test('admin can move a submitted application to UNDER_REVIEW', async () => {
  const env = makeEnv();
  await developerRoutes.saveApplication(req('u1', APPLICATION, '/developers/apply'), env);
  await developerRoutes.submitApplication(req('u1', {}, '/developers/application/submit'), env);
  const out: any = await adminDeveloperRoutes.startReview(req('admin1', {}, `/admin/developers/applications/${env.db.developer_applications[0].id}/review`), env);
  assert.equal(out.application.status, 'UNDER_REVIEW');
});

test('rejection REQUIRES a reason', async () => {
  const env = makeEnv();
  await developerRoutes.saveApplication(req('u1', APPLICATION, '/developers/apply'), env);
  await developerRoutes.submitApplication(req('u1', {}, '/developers/application/submit'), env);
  const noReason: any = await adminDeveloperRoutes.rejectApplication(req('admin1', {}, `/admin/developers/applications/${env.db.developer_applications[0].id}/reject`), env);
  assert.equal(noReason.code, 'VALIDATION_ERROR');
  const withReason: any = await adminDeveloperRoutes.rejectApplication(req('admin1', { reason: 'Insufficient detail about your organization.' }, `/admin/developers/applications/${env.db.developer_applications[0].id}/reject`), env);
  assert.equal(withReason.application.status, 'REJECTED');
  assert.equal(env.db.developer_applications[0].review_reason, 'Insufficient detail about your organization.');
});

test('requesting changes REQUIRES a reason', async () => {
  const env = makeEnv();
  await developerRoutes.saveApplication(req('u1', APPLICATION, '/developers/apply'), env);
  await developerRoutes.submitApplication(req('u1', {}, '/developers/application/submit'), env);
  const out: any = await adminDeveloperRoutes.requestChanges(req('admin1', {}, `/admin/developers/applications/${env.db.developer_applications[0].id}/request-changes`), env);
  assert.equal(out.code, 'VALIDATION_ERROR');
});

test('approval creates the organization: developer + OWNER member + public profile + audit', async () => {
  const { env, devId } = await approvedDeveloper();
  assert.match(devId, /^dev_[a-z2-9]{9}$/, 'stable developer id format');
  assert.equal(env.db.developer_applications[0].status, 'APPROVED');
  assert.equal(env.db.developers.length, 1);
  const member = env.db.developer_members.find((m: any) => m.developer_id === devId);
  assert.equal(member.role, 'OWNER');
  assert.equal(member.user_id, 'u1');
  const profile = env.db.developer_profiles.find((p: any) => p.developer_id === devId);
  assert.equal(profile.publisher_name, 'Calcitonin Technologies');
  assert.ok(env.db.developer_audit_logs.some((l: any) => l.action === 'developer_application_approved'));
  assert.ok(env.db.audit_logs.some((l: any) => l.action === 'developer_application_approved'));
});

test('approval connects the applicant\u2019s existing apps to the organization', async () => {
  const env = makeEnv();
  env.db.applications.push({ id: 'app_1', slug: 'a', developer_id: 'u1', status: 'active', name: 'A', download_count: 5, rating: 5, review_count: 1 });
  await developerRoutes.saveApplication(req('u1', APPLICATION, '/developers/apply'), env);
  await developerRoutes.submitApplication(req('u1', {}, '/developers/application/submit'), env);
  await adminDeveloperRoutes.approveApplication(req('admin1', {}, `/admin/developers/applications/${env.db.developer_applications[0].id}/approve`), env);
  assert.equal(env.db.applications[0].developer_org_id, env.db.developers[0].id, 'My Apps is real data');
});

test('the approved developer receives their organization with real stats', async () => {
  const { env, devId } = await approvedDeveloper();
  env.db.applications.push({ id: 'app_1', slug: 'a', developer_id: 'u1', developer_org_id: devId, status: 'active', name: 'A', download_count: 5, rating: 5, review_count: 1 });
  const out: any = await developerRoutes.getOrganization(req('u1', null, '/developers/organization', 'GET'), env);
  assert.equal(out.organization.id, devId);
  assert.equal(out.organization.myRole, 'OWNER');
  assert.equal(out.apps.length, 1);
  assert.equal(out.stats.downloads, 5);
});

// ---------------------------------------------------------------------------
// Team, roles, isolation
// ---------------------------------------------------------------------------

test('the owner can invite a member; only the token HASH is stored', async () => {
  const { env, devId } = await approvedDeveloper();
  const out: any = await developerRoutes.inviteMember(req('u1', { email: 'mate@example.com', role: 'DEVELOPER' }, '/developers/team/invite'), env);
  assert.ok(out.inviteToken, 'raw token returned once to the inviter');
  const inv = env.db.developer_invitations[0];
  assert.equal(inv.status, 'PENDING');
  assert.equal(inv.role, 'DEVELOPER');
  assert.notEqual(inv.token_hash, out.inviteToken, 'never stored in plaintext');
  assert.equal(await hashToken(out.inviteToken), inv.token_hash);
});

test('invitation acceptance requires the matching account email', async () => {
  const { env } = await approvedDeveloper();
  const inv: any = await developerRoutes.inviteMember(req('u1', { email: 'mate@example.com', role: 'ANALYST' }, '/developers/team/invite'), env);
  const wrongUser: any = await developerRoutes.acceptInvitation(req('u3', { token: inv.inviteToken }, '/developers/invitations/accept'), env);
  assert.equal(wrongUser.code, 'FORBIDDEN', 'a different account cannot consume the invitation');
  const rightUser: any = await developerRoutes.acceptInvitation(req('u2', { token: inv.inviteToken }, '/developers/invitations/accept'), env);
  assert.equal(rightUser.success, true);
  assert.equal(rightUser.role, 'ANALYST');
  const member = env.db.developer_members.find((m: any) => m.user_id === 'u2');
  assert.equal(member.role, 'ANALYST');
});

test('the owner can change a member role (audited)', async () => {
  const { env, devId } = await approvedDeveloper();
  env.db.developer_members.push({ id: 'dm2', developer_id: devId, user_id: 'u2', role: 'DEVELOPER', created_at: new Date().toISOString() });
  const out: any = await developerRoutes.changeRole(req('u1', { userId: 'u2', role: 'RELEASE_MANAGER' }, '/developers/team/role'), env);
  assert.equal(out.success, true);
  assert.equal(env.db.developer_members.find((m: any) => m.user_id === 'u2').role, 'RELEASE_MANAGER');
  assert.ok(env.db.developer_audit_logs.some((l: any) => l.action === 'developer_role_changed'));
});

test('unauthorized role escalation fails (server-side)', async () => {
  const { env, devId } = await approvedDeveloper();
  env.db.developer_members.push({ id: 'dm2', developer_id: devId, user_id: 'u2', role: 'SUPPORT', created_at: new Date().toISOString() });

  // SUPPORT cannot manage the team.
  const escalate: any = await developerRoutes.changeRole(req('u2', { userId: 'u2', role: 'ADMIN' }, '/developers/team/role'), env);
  assert.equal(escalate.code, 'FORBIDDEN');

  // Nobody can assign OWNER via role change.
  env.db.developer_members.find((m: any) => m.user_id === 'u2').role = 'ADMIN';
  const ownerGrant: any = await developerRoutes.changeRole(req('u2', { userId: 'u2', role: 'OWNER' }, '/developers/team/role'), env);
  assert.equal(ownerGrant.code, 'VALIDATION_ERROR', 'OWNER is not assignable');

  // ADMIN (non-owner) cannot demote the OWNER.
  const demote: any = await developerRoutes.changeRole(req('u2', { userId: 'u1', role: 'ADMIN' }, '/developers/team/role'), env);
  assert.equal(demote.code, 'FORBIDDEN', 'only the owner can touch the owner role');
});

test('the final owner cannot be removed or demoted', async () => {
  const { env, devId } = await approvedDeveloper();
  const remove: any = await developerRoutes.removeMember(req('u1', null, `/developers/team/${'u1'}`, 'DELETE'), env);
  assert.equal(remove.code, 'FORBIDDEN', 'cannot remove the final owner');
  const demote: any = await developerRoutes.changeRole(req('u1', { userId: 'u1', role: 'ADMIN' }, '/developers/team/role'), env);
  assert.equal(demote.code, 'FORBIDDEN', 'cannot demote the final owner');
});

test('organization A cannot read or write organization B (thread isolation)', async () => {
  const { env, devId } = await approvedDeveloper();

  // A second organization (org B) with its own thread.
  const envB = { DB: { prepare: () => ({}) } }; // placeholder; org B lives in the SAME env
  env.db.users.push({ id: 'u9', name: 'B Owner', email: 'b@example.com', role: 'user' });
  env.db.developers.push({ id: 'dev_bbbbbbbbb', user_id: 'u9', application_id: null, status: 'ACTIVE', created_at: new Date().toISOString() });
  env.db.developer_members.push({ id: 'dmb', developer_id: 'dev_bbbbbbbbb', user_id: 'u9', role: 'OWNER', created_at: new Date().toISOString() });
  const t: any = await developerRoutes.createThread(req('u9', { subject: 'B private subject', message: 'private' }, '/developers/communications/threads'), env);
  const threadBId = t.thread.id;

  // Org A's member asks for org B's thread -> NOT_FOUND (not FORBIDDEN with detail).
  const read: any = await developerRoutes.getThread(req('u1', null, `/developers/communications/${threadBId}`, 'GET'), env);
  assert.equal(read.code, 'NOT_FOUND');
  const write: any = await developerRoutes.sendMessage(req('u1', { message: 'intruding' }, `/developers/communications/${threadBId}/messages`), env);
  assert.equal(write.code, 'NOT_FOUND');

  // And A's thread list never contains B's thread.
  const list: any = await developerRoutes.listThreads(req('u1', null, '/developers/communications', 'GET'), env);
  assert.equal(list.threads.length, 0);
  void envB;
});

test('a non-member user has NO developer communications', async () => {
  const { env } = await approvedDeveloper();
  const out: any = await developerRoutes.listThreads(req('u3', null, '/developers/communications', 'GET'), env);
  assert.equal(out.code, 'FORBIDDEN');
});

test('developer <-> admin communication works both ways and stays private to the org', async () => {
  const { env } = await approvedDeveloper();
  const created: any = await developerRoutes.createThread(req('u1', { subject: 'Release question', message: 'When can we ship?' }, '/developers/communications/threads'), env);
  const threadId = created.thread.id;

  const adminReply: any = await adminDeveloperRoutes.adminSendMessage(req('admin1', { message: 'After review.' }, `/admin/developers/communications/${threadId}/messages`), env);
  assert.equal(adminReply.success, true);

  const view: any = await developerRoutes.getThread(req('u1', null, `/developers/communications/${threadId}`, 'GET'), env);
  assert.equal(view.messages.length, 2);
  assert.equal(view.messages[1].sender_context, 'ADMIN');
  // Reading marks admin messages as read by the developer.
  assert.ok(view.messages[1].read_by_developer_at || env.db.developer_thread_messages[1].read_by_developer_at);
});

// ---------------------------------------------------------------------------
// Suspension, audit, permissions
// ---------------------------------------------------------------------------

test('suspension requires a reason, blocks team operations, keeps communications', async () => {
  const { env, devId } = await approvedDeveloper();
  const noReason: any = await adminDeveloperRoutes.suspendDeveloper(req('admin1', {}, `/admin/developers/${devId}/suspend`), env);
  assert.equal(noReason.code, 'VALIDATION_ERROR');

  const out: any = await adminDeveloperRoutes.suspendDeveloper(req('admin1', { reason: 'Policy violation under review.' }, `/admin/developers/${devId}/suspend`), env);
  assert.equal(out.developer.status, 'SUSPENDED');

  // Team management is blocked while suspended…
  const invite: any = await developerRoutes.inviteMember(req('u1', { email: 'new@example.com', role: 'DEVELOPER' }, '/developers/team/invite'), env);
  assert.equal(invite.code, 'FORBIDDEN');
  // …but communication stays available (restricted area).
  const msg: any = await developerRoutes.createThread(req('u1', { subject: 'Why suspended?', message: 'Please advise.' }, '/developers/communications/threads'), env);
  assert.ok(msg.thread);

  const back: any = await adminDeveloperRoutes.reinstateDeveloper(req('admin1', {}, `/admin/developers/${devId}/reinstate`), env);
  assert.equal(back.developer.status, 'ACTIVE');
});

test('audit history is available to roles with security.view', async () => {
  const { env, devId } = await approvedDeveloper();
  const asOwner: any = await developerRoutes.listAudit(req('u1', null, '/developers/audit', 'GET'), env);
  assert.ok(asOwner.events.some((e: any) => e.action === 'developer_application_approved'));

  // A SUPPORT member (no security.view) is refused.
  env.db.developer_members.push({ id: 'dm3', developer_id: devId, user_id: 'u2', role: 'SUPPORT', created_at: new Date().toISOString() });
  const asSupport: any = await developerRoutes.listAudit(req('u2', null, '/developers/audit', 'GET'), env);
  assert.equal(asSupport.code, 'FORBIDDEN');
});

test('the public profile exposes ONLY public fields', async () => {
  const { env, devId } = await approvedDeveloper();
  const out: any = await developerRoutes.publicProfile(devId, env);
  assert.equal(out.developer.publisherName, 'Calcitonin Technologies');
  const json = JSON.stringify(out);
  assert.ok(!json.includes('owner@example.com'), 'private contact email never leaks');
  assert.ok(!json.includes('contactEmail'));
  assert.ok(!json.includes('member'), 'team information never leaks');
});

// ---------------------------------------------------------------------------
// Permission matrix (pending developers cannot publish; role semantics)
// ---------------------------------------------------------------------------

test('only OWNER / ADMIN / RELEASE_MANAGER can publish releases (matrix)', () => {
  assert.equal(hasPermission('ANALYST', 'release.publish'), false, 'ANALYST cannot publish');
  assert.equal(hasPermission('SUPPORT', 'release.publish'), false, 'SUPPORT cannot publish');
  assert.equal(hasPermission('DEVELOPER', 'release.publish'), false, 'DEVELOPER cannot publish');
  assert.equal(hasPermission('RELEASE_MANAGER', 'release.publish'), true);
  assert.equal(hasPermission('ADMIN', 'release.publish'), true);
  assert.equal(hasPermission('OWNER', 'release.publish'), true);
  assert.equal(hasPermission('OWNER', 'billing.manage'), true, 'OWNER has full control');
  assert.equal(hasPermission('ADMIN', 'billing.manage'), false, 'billing stays with the owner');
  assert.ok(permissionsForRole('OWNER').length === 14);
});
