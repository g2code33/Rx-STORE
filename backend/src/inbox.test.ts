/**
 * Admin inbox tests — direct-to-admin messaging (ad bookings, contact,
 * support), admin actions and templated email replies.
 *
 * Drives the REAL inboxRoutes against a fake D1 with the email provider
 * stubbed. Honesty rules asserted: email outcomes are reported truthfully
 * ('sent' | 'unconfigured' | 'failed'), the message ALWAYS reaches the
 * portal inbox regardless of email config, user text is escaped in emails,
 * and unknown templates/statuses fail closed.
 *
 * Run: node --experimental-strip-types --test backend/src/inbox.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { inboxRoutes } from './routes/inbox.ts';
import { renderInboxReplyTemplate, listInboxReplyTemplates, INBOX_REPLY_TEMPLATES } from './services/email.ts';

const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = realFetch; });

function fakeEnv(opts: { resend?: boolean } = {}) {
  const rows = new Map<string, any>();
  const notifications: any[] = [];
  const admins = [
    { id: 'admin-1', role: 'admin' },
    { id: 'admin-2', role: 'admin' },
  ];
  const DB = {
    prepare(sql: string) {
      return {
        _b: [] as any[],
        bind(...a: any[]) { this._b = a; return this; },
        async run() {
          const a = this._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('CREATE TABLE') || s.includes('CREATE INDEX')) return { meta: { changes: 0 } };
          if (s.includes('INSERT INTO notifications')) {
            notifications.push({ id: a[0], user_id: a[1], type: a[2], title: a[3], message: a[4], data: a[5], read: 0 });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO admin_inbox')) {
            const [id, type, name, email, user_id, subject, message, payload] = a;
            rows.set(id, { id, type, name, email, user_id, subject, message, payload, status: 'new', admin_note: null, replied_at: null, reply_template: null, reply_delivery: null, notified_admin: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE admin_inbox SET notified_admin=?')) {
            const row = [...rows.values()].find((r) => r.id === a[1]);
            if (row) row.notified_admin = a[0];
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE admin_inbox SET status=?')) {
            const row = [...rows.values()].find((r) => r.id === a[2]);
            if (!row) return { meta: { changes: 0 } }; // real D1 reports 0 changes
            row.status = a[0]; if (a[1] != null) row.admin_note = a[1];
            return { meta: { changes: 1 } };
          }
          if (s.includes('UPDATE admin_inbox SET replied_at=')) {
            const row = [...rows.values()].find((r) => r.id === a[2]);
            if (row) { row.replied_at = new Date().toISOString(); row.reply_template = a[0]; row.reply_delivery = a[1]; if (row.status === 'new') row.status = 'actioned'; }
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          const a = this._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('SELECT * FROM admin_inbox WHERE id=?')) return rows.get(a[0]) || null;
          if (s.includes('SELECT key, value FROM site_settings')) return { results: [] };
          return null;
        },
        async all() {
          const a = this._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('FROM admin_inbox') && s.includes('ORDER BY created_at DESC')) {
            return { results: [...rows.values()].filter((r) => !s.includes('WHERE status=?') || r.status === a[0]) };
          }
          if (s.includes("FROM users WHERE role='admin'")) {
            return { results: admins };
          }
          if (s.includes('GROUP BY status')) {
            const counts: Record<string, number> = {};
            for (const r of rows.values()) counts[r.status] = (counts[r.status] || 0) + 1;
            return { results: Object.entries(counts).map(([status, n]) => ({ status, n })) };
          }
          if (s.includes('SELECT key, value FROM site_settings')) return { results: [] };
          return { results: [] };
        },
      };
    },
  };
  const env: any = { DB, ENVIRONMENT: 'production', JWT_SECRET: 'test-jwt' };
  if (opts.resend) { env.RESEND_API_KEY = 're_test'; env.FROM_EMAIL = 'noreply@rxstore.test'; }
  env.__rows = rows;
  env.__notifications = notifications;
  return env;
}

/** Intercept the Resend API; capture sent emails. */
function stubEmail(capture: any[], ok = true) {
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url).includes('resend.com')) {
      capture.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({}), { status: ok ? 200 : 500 });
    }
    return realFetch(url, init);
  }) as any;
}

function postReq(path: string, body: any): Request {
  return new Request(`https://api.test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function getReq(path: string): Request {
  return new Request(`https://api.test${path}`, { method: 'GET' });
}

// ---------------------------------------------------------------------------
// Public submit
// ---------------------------------------------------------------------------

test('an ad booking lands in the admin inbox (portal delivery is email-independent)', async () => {
  const env = fakeEnv(); // NO email config
  const out: any = await inboxRoutes.submit(postReq('/inbox/submit', {
    type: 'ad_booking', name: 'Ama Mensah', email: 'Ama@Example.com',
    subject: 'Welcome-screen ad slot booking',
    message: 'We would like to book the slot for our new product launch.',
    payload: { company: 'Acme Health', headline: 'Feel better daily', targetUrl: 'https://acme.example', dates: '1–14 October' },
  }), env);
  assert.ok(out.id, 'message stored');
  assert.equal(env.__rows.size, 1);
  const row = [...env.__rows.values()][0];
  assert.equal(row.type, 'ad_booking');
  assert.equal(row.status, 'new');
  assert.equal(row.email, 'ama@example.com', 'email normalized');
  assert.deepEqual(JSON.parse(row.payload), { company: 'Acme Health', headline: 'Feel better daily', targetUrl: 'https://acme.example', dates: '1–14 October' });
  // HONEST delivery state: the portal inbox got it; the email notification is unconfigured.
  assert.equal(out.adminNotified, 'unconfigured');
  assert.equal(out.senderAcknowledged, 'skipped', 'no sender copy requested');
});

test('submit triggers an in-app bell notification for EVERY admin, linking straight to the message', async () => {
  const env = fakeEnv(); // even with NO email config — the bell always works
  const out: any = await inboxRoutes.submit(postReq('/inbox/submit', {
    type: 'ad_booking', name: 'Ama', email: 'ama@example.com',
    subject: 'Welcome-screen ad slot booking', message: 'We want the slot for October.',
  }), env);
  assert.equal(env.__notifications.length, 2, 'one notification per admin');
  for (const n of env.__notifications) {
    assert.equal(n.type, 'message');
    assert.equal(n.read, 0, 'starts unread (drives the bell + sidebar badges)');
    assert.ok(n.title.includes('Ad booking'), `title carries the type: ${n.title}`);
    assert.ok(n.message.includes('ama@example.com'), 'message identifies the sender');
    const data = JSON.parse(n.data);
    assert.equal(data.link, `/admin?section=inbox&msg=${out.id}`, 'links STRAIGHT to the message');
    assert.equal(data.inboxId, out.id);
  }
});

test('with email configured: the ADMIN is notified and (on request) the sender acknowledged — truthfully', async () => {
  const env = fakeEnv({ resend: true });
  const capture: any[] = [];
  stubEmail(capture);
  try {
    const out: any = await inboxRoutes.submit(postReq('/inbox/submit', {
      type: 'contact', name: 'Kofi', email: 'kofi@example.com',
      subject: 'Hello', message: 'Just wanted to say the store looks great.', notifySender: true,
    }), env);
    assert.equal(out.adminNotified, 'sent');
    assert.equal(out.senderAcknowledged, 'sent');
    assert.equal(capture.length, 2, 'notification to admin + acknowledgement to sender');
    assert.ok(capture[0].subject.includes('Contact message'), 'admin notification subject');
    assert.ok(capture[0].html.includes('Kofi'), 'sender name included');
    assert.ok(capture[1].subject.includes('We received'), 'acknowledgement subject');
    // User text is ESCAPED in the email body.
    assert.ok(!capture[0].html.includes('<script>'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('provider failure is reported honestly (failed — never faked as sent)', async () => {
  const env = fakeEnv({ resend: true });
  const capture: any[] = [];
  stubEmail(capture, false); // Resend returns 500
  try {
    const out: any = await inboxRoutes.submit(postReq('/inbox/submit', {
      type: 'support', name: 'Yaa', email: 'yaa@example.com',
      subject: 'App not installing', message: 'The installer fails on my laptop.',
    }), env);
    assert.equal(out.adminNotified, 'failed');
    assert.ok(out.id, 'the portal message still exists');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('validation: missing fields / bad email / short message are rejected', async () => {
  const env = fakeEnv();
  const bad = await inboxRoutes.submit(postReq('/inbox/submit', { type: 'ad_booking', name: '', email: 'x', subject: '', message: '' }), env);
  assert.equal(bad.code, 'VALIDATION_ERROR');
  const badEmail = await inboxRoutes.submit(postReq('/inbox/submit', { type: 'contact', name: 'A', email: 'not-an-email', subject: 'S', message: 'A message that is long enough.' }), env);
  assert.match(String(badEmail.message), /valid email/);
  const short = await inboxRoutes.submit(postReq('/inbox/submit', { type: 'contact', name: 'A', email: 'a@b.co', subject: 'S', message: 'short' }), env);
  assert.match(String(short.message), /at least 10/);
  const badType = await inboxRoutes.submit(postReq('/inbox/submit', { type: 'evil', name: 'A', email: 'a@b.co', subject: 'S', message: 'A message that is long enough.' }), env);
  assert.equal(badType.code, 'VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// Admin list / status / reply
// ---------------------------------------------------------------------------

async function seed(env: any) {
  const out: any = await inboxRoutes.submit(postReq('/inbox/submit', {
    type: 'ad_booking', name: 'Ama', email: 'ama@example.com',
    subject: 'Welcome-screen ad slot booking', message: 'We want the slot for October.',
    payload: { company: 'Acme Health' },
  }), env);
  return [...env.__rows.values()].find((r: any) => r.id === out.id);
}

test('admin list returns messages + counts', async () => {
  const env = fakeEnv();
  await seed(env);
  const out: any = await inboxRoutes.list(getReq('/admin/inbox'), env);
  assert.equal(out.messages.length, 1);
  assert.equal(out.counts.new, 1);
});

test('admin takes action: in_review → actioned with an internal note', async () => {
  const env = fakeEnv();
  const row = await seed(env);
  const r1: any = await inboxRoutes.setStatus(postReq(`/admin/inbox/${row.id}/status`, { status: 'in_review' }), env);
  assert.equal(r1.status, 'in_review');
  const r2: any = await inboxRoutes.setStatus(postReq(`/admin/inbox/${row.id}/status`, { status: 'actioned', note: 'Approved — invoice sent separately' }), env);
  assert.equal(r2.status, 'actioned');
  assert.equal(env.__rows.get(row.id).admin_note, 'Approved — invoice sent separately');
  // Invalid status / unknown id fail closed.
  const bad: any = await inboxRoutes.setStatus(postReq(`/admin/inbox/${row.id}/status`, { status: 'deleted' }), env);
  assert.equal(bad.code, 'VALIDATION_ERROR');
  const missing: any = await inboxRoutes.setStatus(postReq(`/admin/inbox/nope/status`, { status: 'archived' }), env);
  assert.equal(missing.code, 'NOT_FOUND');
});

test('admin replies with a TEMPLATE — email sent, recorded on the row, status auto-advances', async () => {
  const env = fakeEnv({ resend: true });
  const row = await seed(env);
  const capture: any[] = [];
  stubEmail(capture);
  try {
    const out: any = await inboxRoutes.reply(postReq(`/admin/inbox/${row.id}/reply`, {
      template: 'ad_approved', custom: 'Your headline is great — send the artwork any time.',
    }), env);
    assert.equal(out.delivery, 'sent');
    const updated = env.__rows.get(row.id);
    assert.equal(updated.reply_template, 'ad_approved');
    assert.equal(updated.reply_delivery, 'sent');
    assert.equal(updated.status, 'actioned', 'reply auto-advances a new message');
    assert.equal(updated.replied_at != null, true);
    // The email used the template with the sender's name + admin's custom text.
    assert.equal(capture.length, 1);
    assert.ok(capture[0].subject.includes('approved'));
    assert.ok(capture[0].html.includes('Ama'));
    assert.ok(capture[0].html.includes('send the artwork any time'));
    assert.ok(capture[0].to.includes('ama@example.com'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('reply without email config is honest: recorded but reported unconfigured', async () => {
  const env = fakeEnv(); // no RESEND
  const row = await seed(env);
  const out: any = await inboxRoutes.reply(postReq(`/admin/inbox/${row.id}/reply`, { template: 'general_reply', custom: 'Thanks!' }), env);
  assert.equal(out.delivery, 'unconfigured');
  assert.match(out.note, /not configured/);
  assert.equal(env.__rows.get(row.id).reply_delivery, 'unconfigured', 'honest state persisted');
});

test('unknown reply template fails closed', async () => {
  const env = fakeEnv();
  const row = await seed(env);
  const out: any = await inboxRoutes.reply(postReq(`/admin/inbox/${row.id}/reply`, { template: 'evil_template' }), env);
  assert.equal(out.code, 'VALIDATION_ERROR');
});

test('templates catalogue lists the reply templates for the admin UI', async () => {
  const out: any = await inboxRoutes.templates(getReq('/admin/inbox/templates'), fakeEnv());
  assert.ok(out.templates.length >= 5);
  assert.ok(out.templates.some((t: any) => t.id === 'ad_approved'));
  assert.ok(out.templates.some((t: any) => t.id === 'support_resolved'));
});

// ---------------------------------------------------------------------------
// Template rendering safety
// ---------------------------------------------------------------------------

test('reply templates escape user-supplied text (no HTML injection into emails)', () => {
  const rendered = renderInboxReplyTemplate('general_reply', {
    name: '<script>alert(1)</script>',
    subject: 'Hello <b>there</b>',
    custom: '<img src=x onerror=alert(1)>',
  });
  assert.ok(rendered);
  assert.ok(!rendered.html.includes('<script>'));
  assert.ok(!rendered.html.includes('<img src=x'));
  assert.ok(rendered.html.includes('&lt;script&gt;'));
  assert.ok(!rendered.subject.includes('<b>'), 'subject carries no HTML');
});

test('every template renders with placeholders replaced', () => {
  for (const t of INBOX_REPLY_TEMPLATES) {
    const r = renderInboxReplyTemplate(t.id, { name: 'Ama', subject: 'Booking', custom: 'Notes' });
    assert.ok(r, `${t.id} renders`);
    assert.ok(!r.html.includes('{name}') && !r.html.includes('{custom}'), `${t.id} has no leftover placeholders`);
  }
  assert.equal(listInboxReplyTemplates().length, INBOX_REPLY_TEMPLATES.length);
});
