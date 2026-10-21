/**
 * Admin awareness / notification tests.
 *
 * Pins the contract the Admin sidebar badges depend on:
 *   - every emitted event lands in admin_events with its SECTION
 *   - counts are per section and total (what the numbered badges render)
 *   - marking a section seen clears ONLY that section's number
 *   - per-user (developer/profile) notifications badge the right tab, and
 *     legacy rows without a `section` column still map from their link
 *
 * Run: node --experimental-strip-types --test backend/src/adminNotifications.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  notifyAdmin, adminEventCounts, adminEventList, markAdminEventsSeen, ensureAdminEventTable,
  userNotificationCounts, markUserNotificationsSeen, sectionFromLink,
} from './services/adminNotifications.ts';

function fakeEnv() {
  const tables: Record<string, any[]> = { admin_events: [], notifications: [] };
  const DB = {
    prepare(sql: string) {
      const s = sql.replace(/\s+/g, ' ');
      return {
        _binds: [] as any[],
        bind(...args: any[]) { this._binds = args; return this; },
        async run() {
          const a = this._binds;
          const T = (n: string) => tables[n];
          if (s.includes('CREATE TABLE') || s.includes('CREATE INDEX')) return { meta: { changes: 0 } };
          if (s.includes('INSERT INTO admin_events')) {
            T('admin_events').push({ id: a[0], section: a[1], type: a[2], title: a[3], message: a[4], link: a[5], meta: a[6], actor_user_id: a[7], read_at: null, read_by: null, created_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE admin_events SET read_at=datetime(\'now\'), read_by=? WHERE read_at IS NULL')) {
            let n = 0; for (const e of T('admin_events')) if (!e.read_at) { e.read_at = 'now'; e.read_by = a[0]; n++; }
            return { meta: { changes: n } };
          }
          if (s.includes('UPDATE admin_events SET read_at=datetime(\'now\'), read_by=? WHERE section=?')) {
            let n = 0; for (const e of T('admin_events')) if (!e.read_at && e.section === a[1]) { e.read_at = 'now'; e.read_by = a[0]; n++; }
            return { meta: { changes: n } };
          }
          if (s.includes('UPDATE notifications SET read=1 WHERE user_id=? AND read=0 AND section=?')) {
            let n = 0; for (const r of T('notifications')) if (r.user_id === a[0] && !r.read && r.section === a[1]) { r.read = 1; n++; }
            return { meta: { changes: n } };
          }
          if (s.includes('UPDATE notifications SET read=1 WHERE user_id=? AND read=0')) {
            let n = 0; for (const r of T('notifications')) if (r.user_id === a[0] && !r.read) { r.read = 1; n++; }
            return { meta: { changes: n } };
          }
          if (s.includes('UPDATE notifications SET read=1 WHERE id=?')) {
            const r = T('notifications').find((x) => x.id === a[0]); if (r) r.read = 1;
            return { meta: { changes: r ? 1 : 0 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          const a = this._binds;
          const T = (n: string) => tables[n];
          if (s.includes('SELECT created_at FROM admin_events WHERE read_at IS NULL')) {
            const u = T('admin_events').filter((e) => !e.read_at).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
            return u.length ? { created_at: u[0].created_at } : null;
          }
          return null;
        },
        async all() {
          const a = this._binds;
          const T = (n: string) => tables[n];
          if (s.includes('SELECT section, COUNT(*) AS n FROM admin_events')) {
            const m: Record<string, number> = {};
            for (const e of T('admin_events')) if (!e.read_at) m[e.section] = (m[e.section] || 0) + 1;
            return { results: Object.entries(m).map(([section, n]) => ({ section, n })) };
          }
          if (s.includes('FROM admin_events')) {
            let rows = [...T('admin_events')];
            if (a.includes('all') === false && s.includes('section=?')) rows = rows.filter((e) => e.section === a[0]);
            if (s.includes('read_at IS NULL')) rows = rows.filter((e) => !e.read_at);
            return { results: rows };
          }
          if (s.includes('SELECT section, data FROM notifications WHERE user_id=? AND read=0')) {
            return { results: T('notifications').filter((r) => r.user_id === a[0] && !r.read).map((r) => ({ section: r.section, data: r.data })) };
          }
          if (s.includes('SELECT id, data FROM notifications WHERE user_id=? AND read=0 AND section IS NULL')) {
            return { results: T('notifications').filter((r) => r.user_id === a[0] && !r.read && !r.section).map((r) => ({ id: r.id, data: r.data })) };
          }
          return { results: [] };
        },
      };
    },
  };
  return { DB, tables };
}

let env: any;
beforeEach(async () => {
  env = fakeEnv();
  await ensureAdminEventTable(env);
});

test('emitted events land with their section and produce per-section badge counts', async () => {
  await notifyAdmin(env, { section: 'releases', type: 'action_required', title: 'Release submitted', message: 'App 1.2.0' });
  await notifyAdmin(env, { section: 'releases', type: 'action_required', title: 'Release submitted', message: 'App 1.2.1' });
  await notifyAdmin(env, { section: 'inbox', type: 'action_required', title: 'Support message' });
  await notifyAdmin(env, { section: 'users', type: 'info', title: 'New user signed up' });

  const counts = await adminEventCounts(env);
  assert.equal(counts.total, 4);
  assert.deepEqual(counts.bySection, { releases: 2, inbox: 1, users: 1 });
  assert.ok(counts.unreadOldest, 'the oldest unread timestamp is reported');
});

test('opening a section clears ONLY that section badge', async () => {
  await notifyAdmin(env, { section: 'releases', title: 'r1' });
  await notifyAdmin(env, { section: 'releases', title: 'r2' });
  await notifyAdmin(env, { section: 'payments', title: 'p1' });

  const changed = await markAdminEventsSeen(env, 'releases', 'admin-1');
  assert.equal(changed, 2);
  const counts = await adminEventCounts(env);
  assert.equal(counts.bySection.releases, undefined, 'the releases number disappears after viewing');
  assert.equal(counts.bySection.payments, 1, 'other sections keep their number');
  assert.equal(counts.total, 1);

  // Marking all clears everything.
  await markAdminEventsSeen(env, 'all', 'admin-1');
  assert.equal((await adminEventCounts(env)).total, 0);
});

test('the event feed supports section + unread filters (what the panel renders)', async () => {
  await notifyAdmin(env, { section: 'github', type: 'action_required', title: 'GitHub release detected' });
  await notifyAdmin(env, { section: 'users', type: 'info', title: 'New user' });
  await markAdminEventsSeen(env, 'users', 'admin-1');

  const github = await adminEventList(env, { section: 'github' });
  assert.equal(github.length, 1);
  assert.equal(github[0].section, 'github');
  const unread = await adminEventList(env, { unreadOnly: true });
  assert.equal(unread.length, 1, 'only the github event is still unread');
});

test('per-user badges: unread notifications counted by section (developer tabs)', async () => {
  env.tables.notifications.push(
    { id: 'n1', user_id: 'dev-1', read: 0, section: 'releases', data: '{}' },
    { id: 'n2', user_id: 'dev-1', read: 0, section: 'messages', data: '{}' },
    { id: 'n3', user_id: 'dev-1', read: 1, section: 'releases', data: '{}' }, // already read
    { id: 'n4', user_id: 'other', read: 0, section: 'releases', data: '{}' },  // different user
  );
  const counts = await userNotificationCounts(env, 'dev-1');
  assert.equal(counts.total, 2);
  assert.deepEqual(counts.bySection, { releases: 1, messages: 1 });
});

test('legacy notifications without a section badge from their link, and clear with that tab', async () => {
  env.tables.notifications.push(
    { id: 'old1', user_id: 'u1', read: 0, section: null, data: JSON.stringify({ link: '/developers/messages' }) },
    { id: 'old2', user_id: 'u1', read: 0, section: null, data: JSON.stringify({ link: '/developers/reviews' }) },
  );
  const counts = await userNotificationCounts(env, 'u1');
  assert.deepEqual(counts.bySection, { messages: 1, reviews: 1 });

  const cleared = await markUserNotificationsSeen(env, 'u1', 'messages');
  assert.equal(cleared, 1);
  const after = await userNotificationCounts(env, 'u1');
  assert.deepEqual(after.bySection, { reviews: 1 }, 'only the viewed tab cleared');

  await markUserNotificationsSeen(env, 'u1', 'all');
  assert.equal((await userNotificationCounts(env, 'u1')).total, 0);
});

test('sectionFromLink maps the real notification destinations', () => {
  assert.equal(sectionFromLink(JSON.stringify({ link: '/developers/messages' })), 'messages');
  assert.equal(sectionFromLink(JSON.stringify({ link: '/developers/releases/rel_1' })), 'releases');
  assert.equal(sectionFromLink(JSON.stringify({ link: '/developers/reviews' })), 'reviews');
  assert.equal(sectionFromLink(JSON.stringify({ link: '/developers/revenue' })), 'payments');
  assert.equal(sectionFromLink(JSON.stringify({ link: '/app/clinical-rx' })), 'updates');
  assert.equal(sectionFromLink(JSON.stringify({})), null);
  assert.equal(sectionFromLink('not-json'), null);
});

test('notifyAdmin never throws, even with a broken DB (awareness must not break actions)', async () => {
  const broken = { DB: { prepare() { throw new Error('D1 down'); } } };
  await assert.doesNotReject(() => notifyAdmin(broken, { section: 'users', title: 'x' }));
  const counts = await adminEventCounts(broken);
  assert.equal(counts.total, 0);
  const seen = await markAdminEventsSeen(broken, 'all', 'a');
  assert.equal(seen, 0);
});
