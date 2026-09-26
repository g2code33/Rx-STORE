/**
 * Admin inbox routes — direct-to-admin messaging (ad bookings, contact,
 * support, sponsor requests).
 *
 * PUBLIC  POST /inbox/submit         — anyone (signed in or not) sends a
 *                                      message straight to the admin portal.
 *                                      Email notification to the admin +
 *                                      acknowledgement to the sender are both
 *                                      attempted and reported HONESTLY
 *                                      ('sent' | 'unconfigured' | 'failed') —
 *                                      never faked (same rule as password
 *                                      recovery).
 * ADMIN   GET  /admin/inbox?status=  — list + counts (admin JWT enforced by
 *                                      index.ts's /admin gate).
 *         GET  /admin/inbox/templates — reply template catalogue.
 *         POST /admin/inbox/:id/status — take action (in_review / actioned /
 *                                      archived + optional internal note).
 *         POST /admin/inbox/:id/reply — reply to the sender using a template
 *                                      (or custom text); delivery recorded.
 */
import { verifyAccessToken } from '../services/auth.ts';
import { validateEmail } from '../utils/validation.ts';
import {
  notifyAdminInboxMessage, acknowledgeInboxMessage,
  listInboxReplyTemplates, renderInboxReplyTemplate,
} from '../services/email.ts';

const TYPES = ['ad_booking', 'contact', 'support', 'sponsor'];
const STATUSES = ['new', 'in_review', 'actioned', 'archived'];

async function ensureInboxTable(env: any): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS admin_inbox (
       id TEXT PRIMARY KEY,
       type TEXT NOT NULL CHECK (type IN ('ad_booking','contact','support','sponsor')),
       name TEXT NOT NULL, email TEXT NOT NULL,
       user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
       subject TEXT NOT NULL, message TEXT NOT NULL, payload TEXT DEFAULT '{}',
       status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_review','actioned','archived')),
       admin_note TEXT, replied_at TEXT, reply_template TEXT, reply_delivery TEXT, notified_admin TEXT,
       created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
     )`
  ).run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_admin_inbox_status ON admin_inbox(status)').run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_admin_inbox_created ON admin_inbox(created_at)').run().catch(() => {});
}

function rid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** Honest email outcome — identical semantics to the password-recovery flow. */
function deliveryOf(r: { ok: boolean; skipped?: string }): string {
  if (r.ok) return 'sent';
  if (r.skipped) return 'unconfigured';
  return 'failed';
}

export const inboxRoutes = {
  /** POST /inbox/submit — public, rate-limited (see rateLimiter /inbox rule). */
  async submit(request: Request, env: any) {
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const type = TYPES.includes(String(body?.type)) ? String(body.type) : null;
    const name = String(body?.name || '').trim();
    const email = String(body?.email || '').trim().toLowerCase();
    const subject = String(body?.subject || '').trim();
    const message = String(body?.message || '').trim();
    if (!type || !name || !email || !subject || !message) {
      return { code: 'VALIDATION_ERROR', message: 'name, email, subject and message are required' };
    }
    if (name.length > 120 || subject.length > 200) return { code: 'VALIDATION_ERROR', message: 'Name or subject is too long' };
    if (!validateEmail(email)) return { code: 'VALIDATION_ERROR', message: 'A valid email address is required' };
    if (message.length < 10) return { code: 'VALIDATION_ERROR', message: 'Message must be at least 10 characters' };
    if (message.length > 5000) return { code: 'VALIDATION_ERROR', message: 'Message must be at most 5000 characters' };
    // Optional structured extras (ad booking: company, headline, targetUrl, dates…)
    const payload: Record<string, string> = {};
    if (body?.payload && typeof body.payload === 'object') {
      for (const [k, v] of Object.entries(body.payload as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim() && k.length <= 40) payload[k.slice(0, 40)] = v.trim().slice(0, 500);
      }
    }
    // Signed-in senders are linked to their account (optional, best-effort).
    let userId: string | null = null;
    const auth = request.headers.get('Authorization') || '';
    if (auth.startsWith('Bearer ')) {
      try { userId = (await verifyAccessToken(auth.slice(7), env.JWT_SECRET))?.userId || null; } catch { /* anonymous */ }
    }

    await ensureInboxTable(env);
    const id = rid('inbx');
    await env.DB.prepare(
      `INSERT INTO admin_inbox (id, type, name, email, user_id, subject, message, payload, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,'new',datetime('now'),datetime('now'))`
    ).bind(id, type, name, email, userId, subject, message, JSON.stringify(payload)).run();

    // Emails: notify the ADMIN (always attempted) + acknowledge the SENDER
    // (only when they asked for email correspondence). Honest outcomes only.
    const notify = await notifyAdminInboxMessage(env, { type, name, email, subject, message });
    const acknowledged = body?.notifySender === true
      ? await acknowledgeInboxMessage(env, { to: email, type, subject })
      : null;
    await env.DB.prepare(`UPDATE admin_inbox SET notified_admin=? WHERE id=?`).bind(deliveryOf(notify), id).run().catch(() => {});

    return {
      id,
      status: 'new',
      // Truthful states — the message is in the admin portal regardless; the
      // email side depends on the deployment's email configuration.
      adminNotified: deliveryOf(notify),
      senderAcknowledged: acknowledged ? deliveryOf(acknowledged) : 'skipped',
      message: 'Your message has been delivered to the RX Store admin inbox.',
    };
  },

  /** GET /admin/inbox?status= — list (+ counts by status). */
  async list(request: Request, env: any) {
    await ensureInboxTable(env);
    const status = new URL(request.url).searchParams.get('status') || '';
    const where = STATUSES.includes(status) ? 'WHERE status=?' : '';
    const rows: any = await env.DB.prepare(
      `SELECT id, type, name, email, user_id, subject, message, payload, status, admin_note,
              replied_at, reply_template, reply_delivery, notified_admin, created_at, updated_at
       FROM admin_inbox ${where} ORDER BY created_at DESC LIMIT 200`
    ).bind(...(where ? [status] : [])).all().catch(() => ({ results: [] }));
    const counts: any = await env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM admin_inbox GROUP BY status`
    ).all().catch(() => ({ results: [] }));
    const byStatus: Record<string, number> = { new: 0, in_review: 0, actioned: 0, archived: 0 };
    for (const r of counts.results || []) byStatus[r.status] = Number(r.n) || 0;
    return { messages: rows.results || [], counts: byStatus };
  },

  /** GET /admin/inbox/templates — the reply template catalogue for the UI. */
  async templates(request: Request, env: any) {
    void request; void env;
    return { templates: listInboxReplyTemplates() };
  },

  /** POST /admin/inbox/:id/status — admin takes (or changes) action. */
  async setStatus(request: Request, env: any) {
    await ensureInboxTable(env);
    // /admin/inbox/:id/status → the id is the segment BEFORE the action.
    const parts = new URL(request.url).pathname.split('/').filter(Boolean);
    const id = parts[2] || '';
    let body: any;
    try { body = await request.json(); } catch { body = {}; }
    const status = String(body?.status || '');
    if (!STATUSES.includes(status)) return { code: 'VALIDATION_ERROR', message: `status must be one of ${STATUSES.join(', ')}` };
    const note = body?.note !== undefined && body?.note !== null ? String(body.note).slice(0, 2000) : null;
    const res: any = await env.DB.prepare(
      `UPDATE admin_inbox SET status=?, admin_note=COALESCE(?, admin_note), updated_at=datetime('now') WHERE id=?`
    ).bind(status, note, id).run();
    if ((res?.meta?.changes || 0) === 0) return { code: 'NOT_FOUND', message: 'Message not found' };
    return { success: true, id, status };
  },

  /**
   * POST /admin/inbox/:id/reply — reply to the sender with a TEMPLATE (or a
   * plain custom message). The rendered email is sent through the provider
   * boundary; the delivery outcome is recorded honestly on the row.
   */
  async reply(request: Request, env: any) {
    await ensureInboxTable(env);
    // /admin/inbox/:id/reply → the id is the segment BEFORE the action.
    const parts = new URL(request.url).pathname.split('/').filter(Boolean);
    const id = parts[2] || '';
    let body: any;
    try { body = await request.json(); } catch { return { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }; }
    const templateId = String(body?.template || 'general_reply');
    const custom = String(body?.custom || '').trim();
    if (custom.length > 5000) return { code: 'VALIDATION_ERROR', message: 'Reply is too long' };

    const row: any = await env.DB.prepare(`SELECT * FROM admin_inbox WHERE id=?`).bind(id).first().catch(() => null);
    if (!row) return { code: 'NOT_FOUND', message: 'Message not found' };

    const rendered = renderInboxReplyTemplate(templateId, {
      name: row.name, subject: row.subject, custom: custom || '(no additional notes)',
    });
    if (!rendered) return { code: 'VALIDATION_ERROR', message: `Unknown template '${templateId}'` };

    const { sendEmail } = await import('../services/email.ts');
    const sent = await sendEmail(env, { to: row.email, subject: rendered.subject, html: rendered.html });
    const delivery = deliveryOf(sent);
    await env.DB.prepare(
      `UPDATE admin_inbox SET replied_at=datetime('now'), reply_template=?, reply_delivery=?, status=CASE WHEN status='new' THEN 'actioned' ELSE status END, updated_at=datetime('now') WHERE id=?`
    ).bind(templateId, delivery, id).run();

    return {
      success: true,
      id,
      delivery,
      // Honest explanation when no email went out.
      note: delivery === 'unconfigured'
        ? 'Email delivery is not configured on this deployment (set RESEND_API_KEY + FROM_EMAIL). The reply was recorded here; use the sender\'s email address directly.'
        : delivery === 'failed'
          ? 'The provider rejected the send — check FROM_EMAIL (an unverified Resend sender domain fails delivery). The reply was recorded here.'
          : 'Reply sent.',
    };
  },
};
