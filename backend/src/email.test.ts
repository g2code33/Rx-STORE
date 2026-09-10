/**
 * Email notification service tests (Resend).
 *
 * Hermetic: global fetch is stubbed; D1 is an in-memory fake. Verifies the
 * HONESTY contract: no secrets -> reported skip (never a fake send), real
 * counts for accepted/rejected sends, bounded batches, non-stable channels
 * skipped, and nothing ever throws into the publish flow.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { sendEmail, notifyStableReleaseEmails, EMAIL_CAP } from './services/email.ts';

const realFetch = globalThis.fetch;
let fetchCalls: { url: string; init: any }[] = [];
let fetchBehavior: (url: string, init: any) => Promise<Response> = async () => new Response('{"id":"x"}', { status: 200 });

beforeEach(() => {
  fetchCalls = [];
  fetchBehavior = async () => new Response('{"id":"x"}', { status: 200 });
  globalThis.fetch = (async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    return fetchBehavior(String(url), init);
  }) as any;
});

function envWith(overrides: Record<string, any> = {}) {
  return {
    RESEND_API_KEY: 're_test_key',
    FROM_EMAIL: 'notifications@rxstore.com',
    DB: fakeDb([]),
    ...overrides,
  };
}

function fakeDb(users: { id: string; email: string }[]) {
  return {
    prepare(sql: string) {
      const self: any = {
        _b: [] as any[],
        bind(...a: any[]) { self._b = a; return self; },
        async all() {
          if (sql.includes('FROM users WHERE preferences LIKE')) return { results: self._b[1] > users.length ? users : users.slice(0, self._b[1]) };
          return { results: [] };
        },
      };
      return self;
    },
  };
}

test('sendEmail: skipped honestly when secrets are missing (and no request is made)', async () => {
  const res = await sendEmail({ RESEND_API_KEY: '', FROM_EMAIL: '' }, { to: 'a@b.com', subject: 's', html: '<p>x</p>' });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'email-not-configured');
  assert.equal(fetchCalls.length, 0, 'no provider call without secrets');
});

test('sendEmail: ok on a 200 response; carries the API key and sender', async () => {
  const res = await sendEmail(envWith(), { to: 'user@example.com', subject: 'Hi', html: '<p>Hi</p>' });
  assert.equal(res.ok, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://api.resend.com/emails');
  assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer re_test_key');
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.equal(body.from, 'notifications@rxstore.com');
  assert.deepEqual(body.to, ['user@example.com']);
  assert.equal(body.subject, 'Hi');
});

test('sendEmail: provider rejections are reported, never thrown', async () => {
  fetchBehavior = async () => new Response('{"message":"unverified domain"}', { status: 403 });
  const res = await sendEmail(envWith(), { to: 'user@example.com', subject: 's', html: 'h' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'resend_403');
});

test('sendEmail: network failures are reported, never thrown', async () => {
  fetchBehavior = async () => { throw new Error('offline'); };
  const res = await sendEmail(envWith(), { to: 'user@example.com', subject: 's', html: 'h' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'network');
});

test('notifyStableReleaseEmails: skips non-stable channels without querying or sending', async () => {
  const res = await notifyStableReleaseEmails(envWith(), { appName: 'App', slug: 'app', version: '2.0.0', channel: 'beta' });
  assert.deepEqual(res, { optedIn: 0, emailed: 0, failed: 0, skipped: 'non_stable_channel' });
  assert.equal(fetchCalls.length, 0);
});

test('notifyStableReleaseEmails: skips (honestly) when email is not configured', async () => {
  const res = await notifyStableReleaseEmails(
    envWith({ RESEND_API_KEY: '', FROM_EMAIL: '', DB: fakeDb([{ id: 'u1', email: 'a@b.com' }]) }),
    { appName: 'App', slug: 'app', version: '2.0.0', channel: 'stable' },
  );
  assert.equal(res.skipped, 'email_not_configured');
  assert.equal(fetchCalls.length, 0);
});

test('notifyStableReleaseEmails: emails every opted-in user and reports real counts', async () => {
  const users = [
    { id: 'u1', email: 'one@example.com' },
    { id: 'u2', email: 'two@example.com' },
  ];
  const res = await notifyStableReleaseEmails(envWith({ DB: fakeDb(users) }), { appName: 'CGPA Pilot', slug: 'cgpa-pilot', version: '1.1.0', channel: 'stable' });
  assert.deepEqual(res, { optedIn: 2, emailed: 2, failed: 0 });
  assert.equal(fetchCalls.length, 2);
  const subjects = fetchCalls.map((c) => JSON.parse(c.init.body).subject);
  assert.ok(subjects.every((s) => s.includes('CGPA Pilot') && s.includes('1.1.0')));
});

test('notifyStableReleaseEmails: partial provider failures are counted, not hidden', async () => {
  let n = 0;
  fetchBehavior = async () => {
    n += 1;
    return n === 1
      ? new Response('{"id":"ok"}', { status: 200 })
      : new Response('{"message":"blocked"}', { status: 403 });
  };
  const users = [
    { id: 'u1', email: 'one@example.com' },
    { id: 'u2', email: 'two@example.com' },
  ];
  const res = await notifyStableReleaseEmails(envWith({ DB: fakeDb(users) }), { appName: 'App', slug: 'app', version: '1.0.0', channel: 'stable' });
  assert.equal(res.emailed, 1);
  assert.equal(res.failed, 1);
});

test('notifyStableReleaseEmails: the batch is capped to protect provider quotas', async () => {
  const many = Array.from({ length: EMAIL_CAP + 30 }, (_, i) => ({ id: `u${i}`, email: `u${i}@example.com` }));
  const res = await notifyStableReleaseEmails(envWith({ DB: fakeDb(many) }), { appName: 'App', slug: 'app', version: '1.0.0', channel: 'stable' });
  assert.ok(res.optedIn > EMAIL_CAP, 'optedIn reports the real (uncapped) count');
  assert.equal(fetchCalls.length, EMAIL_CAP, 'but only EMAIL_CAP emails are attempted');
  assert.equal(res.emailed + res.failed, EMAIL_CAP);
});

test('notifyStableReleaseEmails: app names are HTML-escaped in the email body', async () => {
  await notifyStableReleaseEmails(envWith({ DB: fakeDb([{ id: 'u1', email: 'a@b.com' }]) }),
    { appName: 'Evil <script>alert(1)</script>', slug: 'x', version: '1.0.0', channel: 'stable' });
  const body = JSON.parse(fetchCalls[0].init.body).html;
  assert.ok(!body.includes('<script>'), 'raw script tag must not appear');
  assert.ok(body.includes('&lt;script&gt;'), 'name is escaped');
});

test('notifyStableReleaseEmails: a database failure degrades to zero, never throws', async () => {
  const brokenDb = {
    prepare() {
      return { bind() { return this; }, async all() { throw new Error('D1 down'); } };
    },
  };
  const res = await notifyStableReleaseEmails(envWith({ DB: brokenDb }), { appName: 'App', slug: 'app', version: '1.0.0', channel: 'stable' });
  assert.equal(res.optedIn, 0);
  assert.equal(fetchCalls.length, 0);
});
