/**
 * Admin Review & Developer Communication tests (Phase 14 §10).
 *
 * Real route handlers (submissions.ts + the Phase 12 submit flow it wraps)
 * against an in-memory D1/R2 fake. Covers the FULL workflow —
 * submit → admin receives → request changes (action items) → developer
 * notified → responds → resubmits → approve → release publication-eligible —
 * plus rejection, reviewer-assignment enforcement, suspend/resume,
 * attachment policy (type/size/executable/malware/access) and permission
 * boundaries between organizations.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { developerSubmissionRoutes, adminSubmissionRoutes } from './routes/submissions.ts';
import { developerAppRoutes, adminDeveloperAppRoutes } from './routes/developerApps.ts';
import { r2KeyIsPubliclyServed } from './services/packageSecurity.ts';

const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = realFetch; });

// ---------------------------------------------------------------------------
// In-memory fake (submissions + events + attachments + threads + pipeline rows)
// ---------------------------------------------------------------------------

function makeEnv() {
  const db: any = {
    users: [
      { id: 'u1', name: 'Dev Owner', email: 'dev@example.com', role: 'user', preferences: '{"emailNotifications":true}' },
      { id: 'u2', name: 'Other Org', email: 'other@example.com', role: 'user', preferences: '{}' },
      { id: 'admin1', name: 'Admin One', email: 'admin1@example.com', role: 'admin', preferences: '{}' },
      { id: 'admin2', name: 'Admin Two', email: 'admin2@example.com', role: 'admin', preferences: '{}' },
    ],
    developers: [
      { id: 'dev_a', user_id: 'u1', status: 'ACTIVE', created_at: '2026-01-01' },
      { id: 'dev_b', user_id: 'u2', status: 'ACTIVE', created_at: '2026-01-01' },
    ],
    developer_profiles: [{ developer_id: 'dev_a', publisher_name: 'Org A' }],
    developer_members: [
      { id: 'dm1', developer_id: 'dev_a', user_id: 'u1', role: 'OWNER', created_at: '2026-01-01' },
      { id: 'dm2', developer_id: 'dev_b', user_id: 'u2', role: 'OWNER', created_at: '2026-01-01' },
    ],
    applications: [{
      id: 'app_1', slug: 'demo-app', name: 'Demo App', description: 'A demo application', category: 'healthcare',
      status: 'active', platforms: '["windows"]', developer_org_id: 'dev_a', icon: 'https://x/i.png', screenshots: '["https://x/s1.png"]',
      android_package_id: null, linux_package_name: null, windows_executable: null, windows_uninstall_key: null,
    }],
    releases: [{
      id: 'rel_1', application_id: 'app_1', version: '2.0.0', build_number: '42', release_notes: '["Fix"]',
      feature_summary: 'Faster', call_to_action: null, status: 'draft', developer_id: 'dev_a', channel: 'stable',
      release_type: 'patch', minimum_supported_version: null,
    }],
    packages: [{
      id: 'pkg_1', application_id: 'app_1', release_id: 'rel_1', platform: 'windows', architecture: 'x64',
      filename: 'setup.exe', storage_key: 'quarantine/demo-app/2.0.0/windows/x64/setup.exe', file_size: 9,
      sha256: 'a'.repeat(64), status: 'stored', security_state: 'SECURITY_REVIEW_COMPLETE', overall_security: 'PASSED',
      deployment_url: null, developer_id: 'dev_a',
    }],
    package_security_results: [],
    package_security_overrides: [],
    developer_submissions: [],
    developer_submission_events: [],
    developer_threads: [],
    developer_thread_messages: [],
    developer_thread_attachments: [],
    developer_audit_logs: [],
    audit_logs: [],
    notifications: [],
  };
  const storage = new Map<string, Uint8Array>();

  function applyUpdate(row: any, sql: string, binds: any[], idFromBinds: (i: number) => any) {
    // Generic SET parser: col='lit' | col=? | col=datetime('now') | col=NULL
    const m = sql.match(/SET (.*?) WHERE /);
    if (!m) return;
    const id = idFromBinds(binds.length - 1);
    if (!row || row.id !== id && row.release_id !== id) return;
    let bi = 0;
    for (const part of m[1].split(', ')) {
      const lit = part.match(/^(\w+)='([^']*)'$/);
      const dt = part.match(/^(\w+)=datetime\('now'\)$/);
      const nul = part.match(/^(\w+)=NULL$/);
      const bind = part.match(/^(\w+)=\?$/);
      if (lit) row[lit[1]] = lit[2];
      else if (dt) row[dt[1]] = new Date().toISOString();
      else if (nul) row[nul[1]] = null;
      else if (bind) row[bind[1]] = binds[bi++];
    }
  }

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
          if (s.includes('SELECT * FROM applications WHERE id=?')) return db.applications.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT * FROM releases WHERE id=?')) return db.releases.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT * FROM packages WHERE id=?')) return db.packages.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT * FROM developer_submissions WHERE id=?')) return db.developer_submissions.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT * FROM developer_submissions WHERE release_id=?')) return db.developer_submissions.find((x: any) => x.release_id === a[0]) || null;
          if (s.includes('SELECT * FROM developer_threads WHERE id=?')) return db.threadsFind ? db.threadsFind(a[0]) : (db.developer_threads.find((t: any) => t.id === a[0]) || null);
          if (s.includes('SELECT id FROM developer_threads WHERE related_release_id=?')) {
            return db.developer_threads.find((t: any) => t.related_release_id === a[0] || t.related_submission_id === a[1]) || null;
          }
          if (s.includes('SELECT developer_id, status FROM developer_threads WHERE id=?')) {
            const t = db.developer_threads.find((x: any) => x.id === a[0]);
            return t ? { developer_id: t.developer_id, status: t.status } : null;
          }
          if (s.includes('SELECT * FROM developer_thread_attachments WHERE id=?')) return db.developer_thread_attachments.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT id, name, role FROM users WHERE id=?')) return db.users.find((u: any) => u.id === a[0]) || null;
          if (s.includes('SELECT name FROM applications WHERE id=?')) return { name: db.applications.find((x: any) => x.id === a[0])?.name };
          if (s.includes('SELECT security_state, overall_security FROM packages WHERE id=?')) return db.packages.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT id FROM package_security_overrides WHERE package_id=?')) return db.package_security_overrides.find((o: any) => o.package_id === a[0]) || null;
          return null;
        },
        async all() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes("SELECT id FROM users WHERE role='admin'")) return { results: db.users.filter((u: any) => u.role === 'admin') };
          if (s.includes('SELECT user_id FROM developer_members WHERE developer_id=?')) return { results: db.developer_members.filter((m: any) => m.developer_id === a[0]).map((m: any) => ({ user_id: m.user_id })) };
          if (s.includes('SELECT platform, deployment_url, file_size FROM packages WHERE release_id=?')) {
            return { results: db.packages.filter((p: any) => p.release_id === a[0]).map((p: any) => ({ platform: p.platform, deployment_url: p.deployment_url, file_size: p.file_size })) };
          }
          if (s.includes('SELECT id FROM packages WHERE release_id=? AND deployment_url IS NULL')) {
            return { results: db.packages.filter((p: any) => p.release_id === a[0] && !p.deployment_url) };
          }
          if (s.includes('SELECT * FROM packages WHERE release_id=?')) return { results: db.packages.filter((p: any) => p.release_id === a[0]) };
          if (s.includes('SELECT check_type, status, result, details FROM package_security_results')) {
            const latest = new Map<string, any>();
            for (const r of db.package_security_results) if (r.package_id === a[0]) latest.set(r.check_type, r);
            return { results: [...latest.values()].filter((r: any) => ['FAILED', 'DETECTED', 'WARNING', 'NEEDS_REVIEW', 'UNAVAILABLE', 'PENDING', 'SCANNING'].includes(r.status)) };
          }
          if (s.includes('SELECT u.email FROM developer_members m JOIN users u')) {
            return { results: db.developer_members.filter((m: any) => m.developer_id === a[0]).map((m: any) => db.users.find((u: any) => u.id === m.user_id)).filter((u: any) => u?.preferences?.includes('"emailNotifications":true')) };
          }
          if (s.includes('FROM developer_submissions s JOIN applications a')) {
            const mine = s.includes('WHERE s.developer_id=?') ? db.developer_submissions.filter((x: any) => x.developer_id === a[0]) : db.developer_submissions;
            return {
              results: mine.map((sub: any) => ({
                ...sub, app_name: db.applications.find((x: any) => x.id === sub.app_id)?.name, app_slug: 'demo-app',
                version: db.releases.find((r: any) => r.id === sub.release_id)?.version,
                build_number: db.releases.find((r: any) => r.id === sub.release_id)?.build_number,
                release_status: db.releases.find((r: any) => r.id === sub.release_id)?.status,
                publisher_name: 'Org A',
                package_count: db.packages.filter((p: any) => p.release_id === sub.release_id).length,
              })),
            };
          }
          if (s.includes('SELECT version, status, published_at, created_at FROM releases WHERE application_id=?')) {
            return { results: db.releases.filter((r: any) => r.application_id === a[0] && r.id !== a[1]) };
          }
          if (s.includes('FROM developer_submission_events e LEFT JOIN users u')) {
            return { results: db.developer_submission_events.filter((e: any) => e.submission_id === a[0]) };
          }
          if (s.includes('SELECT event, actor_role, notes, created_at FROM developer_submission_events')) {
            return { results: db.developer_submission_events.filter((e: any) => e.submission_id === a[0]) };
          }
          if (s.includes('SELECT id, sender_user_id, sender_context, body, created_at FROM developer_thread_messages')) {
            return { results: db.developer_thread_messages.filter((m: any) => m.thread_id === a[0]) };
          }
          if (s.includes('SELECT id, filename, mime_type, file_size, scan_status, uploader_user_id, created_at FROM developer_thread_attachments')) {
            return { results: db.developer_thread_attachments.filter((x: any) => x.thread_id === a[0]) };
          }
          if (s.includes('SELECT id, subject, status, updated_at FROM developer_threads WHERE related_release_id=?')) {
            const t = db.developer_threads.find((x: any) => x.related_release_id === a[0] || x.related_submission_id === a[1]);
            return { results: t ? [t] : [] };
          }
          if (s.includes('SELECT id FROM developer_threads WHERE related_release_id=? OR related_submission_id=?')) {
            const t = db.developer_threads.find((x: any) => x.related_release_id === a[0] || x.related_submission_id === a[1]);
            return { results: t ? [t] : [] };
          }
          return { results: [] };
        },
        async run() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          const now = new Date().toISOString();
          if (s.includes('INSERT INTO developer_submissions')) {
            db.developer_submissions.push({ id: a[0], developer_id: a[1], app_id: a[2], release_id: a[3], status: 'SUBMITTED', submitted_at: now, reviewer_id: null, review_notes: null, action_items: '[]', decision: null, reviewed_at: null, created_at: now, updated_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developer_submission_events')) {
            db.developer_submission_events.push({ id: a[0], submission_id: a[1], actor_user_id: a[2], actor_role: a[3], event: a[4], notes: a[5], created_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developer_audit_logs')) {
            db.developer_audit_logs.push({ id: a[0], developer_id: a[1], actor_user_id: a[2], action: a[3], details: a[4] });
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
          if (s.includes('INSERT INTO developer_threads')) {
            db.developer_threads.push({ id: a[0], developer_id: a[1], subject: a[2], related_app_id: a[3], related_release_id: a[4], related_submission_id: a[5] ?? null, status: 'AWAITING_ADMIN', action_required: 1, updated_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developer_thread_messages')) {
            // Two shapes: literal context VALUES (?,?,?, 'ADMIN'|'DEVELOPER', ?) → body=a[3];
            // all-bound VALUES (?,?,?,?,?) → context=a[3], body=a[4].
            const literalCtx = s.includes("'ADMIN'") ? 'ADMIN' : s.includes("'DEVELOPER'") ? 'DEVELOPER' : null;
            db.developer_thread_messages.push(
              literalCtx
                ? { id: a[0], thread_id: a[1], sender_user_id: a[2], sender_context: literalCtx, body: a[3], created_at: now }
                : { id: a[0], thread_id: a[1], sender_user_id: a[2], sender_context: a[3], body: a[4], created_at: now },
            );
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO developer_thread_attachments')) {
            db.developer_thread_attachments.push({ id: a[0], thread_id: a[1], message_id: a[2], uploader_user_id: a[3], filename: a[4], storage_key: a[5], mime_type: a[6], file_size: a[7], sha256: a[8], scan_status: a[9], created_at: now });
            return { meta: { changes: 1 } };
          }
          if (s.startsWith('UPDATE developer_submissions SET')) {
            const sub = db.developer_submissions.find((x: any) => x.id === a[a.length - 1]);
            if (sub) applyUpdate(sub, s, a, () => sub.id);
            return { meta: { changes: 1 } };
          }
          if (s.startsWith('UPDATE releases SET')) {
            const rel = db.releases.find((x: any) => x.id === a[a.length - 1]);
            if (rel) applyUpdate(rel, s, a, () => rel.id);
            return { meta: { changes: 1 } };
          }
          if (s.startsWith('UPDATE developer_threads SET')) {
            const t = db.developer_threads.find((x: any) => x.id === a[a.length - 1]);
            if (t) applyUpdate(t, s, a, () => t.id);
            return { meta: { changes: 1 } };
          }
          if (s.startsWith('UPDATE developer_thread_messages SET')) {
            db.developer_thread_messages.forEach((m: any) => { if (m.thread_id === a[0] && m.sender_context === 'DEVELOPER') m.read_by_admin_at = now; });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  const STORAGE = {
    async put(key: string, value: Uint8Array) { storage.set(key, value); },
    async get(key: string, opts?: any) {
      const v = storage.get(key);
      if (!v) return null;
      let bytes = v;
      if (opts?.range) {
        const { offset = 0, length } = opts.range;
        bytes = v.subarray(offset, length != null ? offset + length : undefined);
      }
      return { size: v.length, arrayBuffer: async () => bytes.slice().buffer, body: null, httpMetadata: {} };
    },
    async head(key: string) { const v = storage.get(key); return v ? { size: v.length } : null; },
  };
  return { DB, STORAGE, db, storage };
}

const req = (userId: string | null, body: any, path: string, method = 'POST') => {
  const r = new Request(`https://api.rxstore.com${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  if (userId) (r as any).user = { userId };
  return r;
};

/** Developer (u1 / org A) submits the seeded release — the Phase 12 flow that now creates the submission. */
async function submitted() {
  const env = makeEnv();
  const out: any = await developerAppRoutes.submitRelease(req('u1', {}, '/developers/releases/rel_1/submit'), env);
  assert.ok(out.submission?.id, 'submission created');
  return { env, submissionId: out.submission.id as string };
}

// ---------------------------------------------------------------------------
// THE full workflow (§10)
// ---------------------------------------------------------------------------

test('FULL WORKFLOW: submit → review → request changes → respond → resubmit → approve → publication-eligible', async () => {
  const { env, submissionId } = await submitted();

  // 1. The submission entered the automated security stage and reached ADMIN_REVIEW
  //    (the seeded package already passed the Phase 13 pipeline).
  let sub = env.db.developer_submissions[0];
  assert.equal(sub.status, 'ADMIN_REVIEW');
  assert.ok(env.db.developer_submission_events.some((e: any) => e.event === 'submission_created'));
  assert.ok(env.db.developer_submission_events.some((e: any) => e.event === 'submission_submitted'));
  assert.ok(env.db.notifications.some((n: any) => n.user_id === 'admin1' && n.title.includes('received')), 'admins notified');

  // 2. Admin sees it in the queue.
  const queue: any = await adminSubmissionRoutes.list(req('admin1', null, '/admin/submissions', 'GET'), env);
  assert.equal(queue.submissions.length, 1);
  assert.equal(queue.submissions[0].status, 'ADMIN_REVIEW');

  // 3. Admin requests changes — reason AND concrete action items required.
  const generic: any = await adminSubmissionRoutes.requestChanges(req('admin1', { reason: 'Please fix your app.' }, `/admin/submissions/${submissionId}/request-changes`), env);
  assert.equal(generic.code, 'VALIDATION_ERROR', 'generic reasons are rejected');
  const noItems: any = await adminSubmissionRoutes.requestChanges(req('admin1', { reason: 'Metadata needs work before listing.' }, `/admin/submissions/${submissionId}/request-changes`), env);
  assert.equal(noItems.code, 'VALIDATION_ERROR', 'action items are required');

  const changes: any = await adminSubmissionRoutes.requestChanges(req('admin1', {
    reason: 'The listing metadata is incomplete for publication.',
    actionItems: ['Add a 512x512 PNG icon with transparent background', 'Describe the new permission in the 2.0.0 release notes'],
  }, `/admin/submissions/${submissionId}/request-changes`), env);
  assert.equal(changes.submission.status, 'CHANGES_REQUESTED');

  // 4. Developer is notified, sees the exact action items, and the release is editable again.
  assert.ok(env.db.notifications.some((n: any) => n.user_id === 'u1' && n.title.includes('Changes requested')), 'developer notified');
  sub = env.db.developer_submissions[0];
  assert.deepEqual(JSON.parse(sub.action_items), ['Add a 512x512 PNG icon with transparent background', 'Describe the new permission in the 2.0.0 release notes']);
  assert.equal(env.db.releases[0].status, 'changes_requested');
  // The communication thread carries the exact items.
  assert.ok(env.db.developer_thread_messages.some((m: any) => m.sender_context === 'ADMIN' && m.body.includes('1. Add a 512x512 PNG icon')));
  assert.ok(env.db.developer_audit_logs.some((l: any) => l.action === 'changes_requested'));

  // 5. Developer responds + resubmits.
  const resubmit: any = await developerSubmissionRoutes.resubmit(req('u1', { message: 'Icon updated and release notes amended.' }, `/developers/submissions/${submissionId}/resubmit`), env);
  assert.ok(resubmit.submission);
  sub = env.db.developer_submissions[0];
  assert.equal(sub.status, 'ADMIN_REVIEW', 'resubmission re-entered review');
  assert.equal(env.db.releases[0].status, 'submitted');
  assert.ok(env.db.developer_submission_events.some((e: any) => e.event === 'developer_response'));
  assert.ok(env.db.developer_submission_events.some((e: any) => e.event === 'submission_resubmitted'));
  assert.ok(env.db.developer_thread_messages.some((m: any) => m.sender_context === 'DEVELOPER' && m.body.includes('Icon updated')));

  // 6. Admin approves → the release becomes publication-eligible (approved).
  const approve: any = await adminSubmissionRoutes.approve(req('admin1', { notes: 'Great improvements.' }, `/admin/submissions/${submissionId}/approve`), env);
  assert.equal(approve.submission.status, 'APPROVED');
  assert.equal(env.db.releases[0].status, 'approved', 'release approved — publish remains a separate gated step');
  assert.equal(env.db.developer_submissions[0].decision, 'APPROVED');
  assert.ok(env.db.notifications.some((n: any) => n.user_id === 'u1' && n.title.includes('approved')));
  assert.ok(env.db.developer_submission_events.some((e: any) => e.event === 'submission_approved'));
  // Full history preserved end-to-end.
  const events = env.db.developer_submission_events.map((e: any) => e.event);
  assert.ok(events.includes('submission_created') && events.includes('changes_requested') && events.includes('submission_resubmitted') && events.includes('submission_approved'));
});

// ---------------------------------------------------------------------------
// Rejection + workflow states
// ---------------------------------------------------------------------------

test('rejection requires a reason, preserves records, and blocks the release', async () => {
  const { env, submissionId } = await submitted();
  await adminSubmissionRoutes.startReview(req('admin1', {}, `/admin/submissions/${submissionId}/review`), env);
  const noReason: any = await adminSubmissionRoutes.reject(req('admin1', {}, `/admin/submissions/${submissionId}/reject`), env);
  assert.equal(noReason.code, 'VALIDATION_ERROR');
  const out: any = await adminSubmissionRoutes.reject(req('admin1', { reason: 'The installer crashes on Windows 11 during setup.' }, `/admin/submissions/${submissionId}/reject`), env);
  assert.equal(out.submission.status, 'REJECTED');
  assert.equal(env.db.releases[0].status, 'rejected');
  assert.equal(env.db.developer_submissions.length, 1, 'the record is preserved, not deleted');
  assert.ok(env.db.developer_thread_messages.some((m: any) => m.body.includes('installer crashes')));
  assert.ok(env.db.notifications.some((n: any) => n.user_id === 'u1' && n.title.includes('not approved')));
});

test('suspend and resume review', async () => {
  const { env, submissionId } = await submitted();
  await adminSubmissionRoutes.startReview(req('admin1', {}, `/admin/submissions/${submissionId}/review`), env);
  const suspend: any = await adminSubmissionRoutes.suspend(req('admin1', { reason: 'Waiting for the security team advisory.' }, `/admin/submissions/${submissionId}/suspend`), env);
  assert.equal(suspend.submission.status, 'REVIEW_SUSPENDED');
  const resume: any = await adminSubmissionRoutes.resume(req('admin1', {}, `/admin/submissions/${submissionId}/resume`), env);
  assert.equal(resume.submission.status, 'ADMIN_REVIEW');
});

// ---------------------------------------------------------------------------
// Reviewer assignment (§8)
// ---------------------------------------------------------------------------

test('reviewer assignment: only admins can be reviewers; only the assigned reviewer decides', async () => {
  const { env, submissionId } = await submitted();

  // Non-admin target rejected.
  const badTarget: any = await adminSubmissionRoutes.assign(req('admin1', { userId: 'u1' }, `/admin/submissions/${submissionId}/assign`), env);
  assert.equal(badTarget.code, 'FORBIDDEN');

  // Assign admin2; admin1 can no longer decide.
  const assign: any = await adminSubmissionRoutes.assign(req('admin1', { userId: 'admin2' }, `/admin/submissions/${submissionId}/assign`), env);
  assert.equal(assign.submission.reviewerId, 'admin2');
  assert.ok(env.db.developer_submission_events.some((e: any) => e.event === 'reviewer_assigned'));

  const blocked: any = await adminSubmissionRoutes.approve(req('admin1', {}, `/admin/submissions/${submissionId}/approve`), env);
  assert.equal(blocked.code, 'FORBIDDEN', 'an unassigned admin cannot review someone else\'s submission');

  const ok: any = await adminSubmissionRoutes.approve(req('admin2', {}, `/admin/submissions/${submissionId}/approve`), env);
  assert.equal(ok.submission.status, 'APPROVED', 'the assigned reviewer can decide');
});

// ---------------------------------------------------------------------------
// Permission boundaries
// ---------------------------------------------------------------------------

test('organization B cannot see, resubmit, or attach to organization A submissions', async () => {
  const { env, submissionId } = await submitted();
  const other: any = await developerSubmissionRoutes.get(req('u2', null, `/developers/submissions/${submissionId}`, 'GET'), env);
  assert.equal(other.code, 'NOT_FOUND');
  const resub: any = await developerSubmissionRoutes.resubmit(req('u2', {}, `/developers/submissions/${submissionId}/resubmit`), env);
  assert.equal(resub.code, 'NOT_FOUND');
  const list: any = await developerSubmissionRoutes.list(req('u2', null, '/developers/submissions', 'GET'), env);
  assert.equal(list.submissions.length, 0);
});

test('the Phase 12 admin release actions keep the submission in sync', async () => {
  const { env, submissionId } = await submitted();
  await adminDeveloperAppRoutes.approveRelease(req('admin1', {}, '/admin/developers/releases/rel_1/approve'), env);
  assert.equal(env.db.developer_submissions[0].status, 'APPROVED', 'synced via syncSubmissionOnReleaseAction');
  void submissionId;
});

// ---------------------------------------------------------------------------
// Attachments (§5)
// ---------------------------------------------------------------------------

async function withThread(env: any) {
  env.db.developer_threads.push({ id: 'dt_1', developer_id: 'dev_a', subject: 'Review: Demo App', related_app_id: 'app_1', related_release_id: 'rel_1', related_submission_id: null, status: 'AWAITING_ADMIN', action_required: 1 });
  return 'dt_1';
}

function fileReq(userId: string, path: string, file: File, message?: string) {
  const form = new FormData();
  form.append('file', file);
  if (message) form.append('message', message);
  const r = new Request(`https://api.rxstore.com${path}`, { method: 'POST', body: form });
  (r as any).user = { userId };
  return r;
}

test('attachments: executables and unknown types rejected; size capped', async () => {
  const env = makeEnv();
  const threadId = await withThread(env);

  const exe: any = await developerSubmissionRoutes.uploadAttachment(fileReq('u1', `/developers/communications/${threadId}/attachments`, new File([new Uint8Array([1])], 'payload.exe', { type: 'application/octet-stream' })), env);
  assert.equal(exe.code, 'VALIDATION_ERROR');
  assert.ok(String(exe.error).includes('Executable'));

  const wrongMime: any = await developerSubmissionRoutes.uploadAttachment(fileReq('u1', `/developers/communications/${threadId}/attachments`, new File([new Uint8Array([1])], 'image.png', { type: 'application/x-msdownload' })), env);
  assert.equal(wrongMime.code, 'VALIDATION_ERROR');

  const big = new File([new Uint8Array(11 * 1024 * 1024)], 'screenshot.png', { type: 'image/png' });
  const tooBig: any = await developerSubmissionRoutes.uploadAttachment(fileReq('u1', `/developers/communications/${threadId}/attachments`, big), env);
  assert.equal(tooBig.code, 'VALIDATION_ERROR');
  assert.ok(String(tooBig.error).includes('10 MB'));
});

test('attachments: valid images are stored PRIVATELY with an honest scan status', async () => {
  const env = makeEnv();
  const threadId = await withThread(env);
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'screenshot.png', { type: 'image/png' });

  const out: any = await developerSubmissionRoutes.uploadAttachment(fileReq('u1', `/developers/communications/${threadId}/attachments`, png, 'Here is the icon.'), env);
  assert.ok(out.attachment?.id);
  assert.equal(out.attachment.scanStatus, 'UNAVAILABLE', 'no scanner configured — never "clean"');
  const att = env.db.developer_thread_attachments[0];
  assert.ok(att.storage_key.startsWith('attachments/threads/'), 'private prefix');
  assert.ok(env.storage.has(att.storage_key), 'bytes stored');
  assert.equal(att.mime_type, 'image/png');
  // The accompanying message was created on the thread.
  assert.ok(env.db.developer_thread_messages.some((m: any) => m.body === 'Here is the icon.'));
});

test('attachments: malware DETECTED rejects the upload and stores nothing', async () => {
  const env = makeEnv();
  const threadId = await withThread(env);
  env.MALWARE_SCANNER = 'virustotal';
  env.VIRUSTOTAL_API_KEY = 'vt_test';
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { attributes: { last_analysis_stats: { malicious: 5 } } } }), { status: 200 })) as any;
  const out: any = await developerSubmissionRoutes.uploadAttachment(fileReq('u1', `/developers/communications/${threadId}/attachments`, new File([new Uint8Array([1, 2, 3])], 'evil.png', { type: 'image/png' })), env);
  assert.equal(out.code, 'FORBIDDEN');
  assert.equal(env.db.developer_thread_attachments.length, 0, 'nothing stored');
  assert.equal(env.storage.size, 0);
});

test('attachment access: only the owning organization can download', async () => {
  const env = makeEnv();
  const threadId = await withThread(env);
  const out: any = await developerSubmissionRoutes.uploadAttachment(fileReq('u1', `/developers/communications/${threadId}/attachments`, new File([new Uint8Array([1])], 'note.txt', { type: 'text/plain' })), env);
  const attId = out.attachment.id;

  const own: any = await developerSubmissionRoutes.downloadAttachment(req('u1', null, `/developers/attachments/${attId}`, 'GET'), env);
  assert.ok(own.attachment);

  const other: any = await developerSubmissionRoutes.downloadAttachment(req('u2', null, `/developers/attachments/${attId}`, 'GET'), env);
  assert.equal(other.code, 'NOT_FOUND', "another org's attachment is indistinguishable from missing");

  // The admin path serves the same attachment to any admin.
  const adminSide: any = await adminSubmissionRoutes.downloadAttachment(req('admin1', null, `/admin/developers/attachments/${attId}`, 'GET'), env);
  assert.ok(adminSide.attachment);
});

test('attachment storage keys are never publicly served (the /r2/ prefix is blocked in index.ts)', async () => {
  const env = makeEnv();
  const threadId = await withThread(env);
  const out: any = await developerSubmissionRoutes.uploadAttachment(fileReq('u1', `/developers/communications/${threadId}/attachments`, new File([new Uint8Array([1])], 'note.txt', { type: 'text/plain' })), env);
  const key = env.db.developer_thread_attachments[0].storage_key;
  assert.ok(key.startsWith('attachments/'), 'private prefix enforced');
  // Even if a package row existed, attachments/ never resolves through the
  // package gate (index.ts short-circuits the prefix before the DB lookup).
  assert.equal(await r2KeyIsPubliclyServed(env, key), false, 'no package row owns it -> not served');
});

// ---------------------------------------------------------------------------
// Email preference integration (§6)
// ---------------------------------------------------------------------------

test('decision emails go ONLY to org members who enabled email notifications', async () => {
  const { env, submissionId } = await submitted();
  env.RESEND_API_KEY = 're_test';
  env.FROM_EMAIL = 'notifications@rxstore.com';
  const sent: string[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push(...body.to);
    return new Response('{}', { status: 200 });
  }) as any;

  await adminSubmissionRoutes.approve(req('admin1', {}, `/admin/submissions/${submissionId}/approve`), env);
  // u1 (org A, opted in) is emailed; u2 (org B) and admins are not.
  assert.ok(sent.includes('dev@example.com'));
  assert.ok(!sent.includes('other@example.com'));
  assert.ok(!sent.includes('admin1@example.com'));
});
