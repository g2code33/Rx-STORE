/**
 * Email notifications via Resend (Prompt: make the "Email notifications"
 * preference real).
 *
 * The user preference `preferences.emailNotifications` (Profile → Preferences)
 * is persisted per account. This service sends best-effort notification
 * emails when a STABLE release is published, using the worker secrets
 * RESEND_API_KEY and FROM_EMAIL.
 *
 * HONESTY RULES (mirrors docs/SECURITY.md — no fake claims):
 *   - If the secrets are missing, sending is SKIPPED (reported, never faked).
 *   - Every send's real outcome is counted; the publish response reports
 *     { optedIn, emailed, failed, skipped } so the admin sees the truth.
 *   - RESEND DOMAIN CAVEAT: with Resend's shared `onboarding@resend.dev`
 *     sender, delivery only works for the account owner's own address. To
 *     email real users you must verify a sending domain in Resend and set
 *     FROM_EMAIL to it (e.g. notifications@yourdomain.com). Until then,
 *     failures are expected and are reported honestly.
 *   - Sends are capped per publish (EMAIL_CAP) to respect provider
 *     quotas/free tiers; raising the cap is a one-line change after a
 *     domain is verified.
 */

/** Max emails per publish event (bounded to respect Resend quotas). */
import { getSetting } from './settings.ts';

export const EMAIL_CAP = 50;
/** Per-request timeout so one slow send cannot stall a publish. */
const SEND_TIMEOUT_MS = 8000;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface SendEmailResult {
  ok: boolean;
  /** Machine-readable reason when not ok. */
  skipped?: 'email-not-configured';
  error?: string;
}

/** Send one email via the Resend REST API. NEVER throws. */
export async function sendEmail(
  env: any,
  input: { to: string; subject: string; html: string },
): Promise<SendEmailResult> {
  const apiKey = env?.RESEND_API_KEY;
  const from = env?.FROM_EMAIL;
  if (!apiKey || !from) return { ok: false, skipped: 'email-not-configured' };
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [input.to], subject: input.subject, html: input.html }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `resend_${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'network' };
  }
}

export interface NotifyReleaseSummary {
  /** Users found with the email preference enabled (before the cap). */
  optedIn: number;
  /** Emails actually accepted by the provider. */
  emailed: number;
  /** Emails the provider rejected (e.g. unverified sender domain). */
  failed: number;
  /** Reason nothing was sent (missing secrets / non-stable channel). */
  skipped?: string;
}

/**
 * Email every user who enabled "Email notifications" about a published STABLE
 * release. Best-effort: database/provider failures degrade to honest counts
 * and never break the publish.
 */
export async function notifyStableReleaseEmails(
  env: any,
  input: { appName: string; slug: string; version: string; channel?: string },
): Promise<NotifyReleaseSummary> {
  if (String(input.channel || 'stable') !== 'stable') return { optedIn: 0, emailed: 0, failed: 0, skipped: 'non_stable_channel' };
  if (!env?.RESEND_API_KEY || !env?.FROM_EMAIL) return { optedIn: 0, emailed: 0, failed: 0, skipped: 'email_not_configured' };

  // Opted-in users. `preferences` is stored as a JSON string
  // ({"emailNotifications":true,...}), so a LIKE match on the serialized key
  // is the portable D1 query (no JSON1 dependency).
  const rows: any = await env.DB
    .prepare('SELECT id, email FROM users WHERE preferences LIKE ? AND email IS NOT NULL AND email != \'\' LIMIT ?')
    .bind('%"emailNotifications":true%', EMAIL_CAP + 1)
    .all()
    .catch(() => ({ results: [] }));
  const users: { id: string; email: string }[] = rows?.results || [];
  const optedIn = users.length;
  const batch = users.slice(0, EMAIL_CAP);

  const name = input.appName || 'an app';
  const subject = `New on RX Store: ${name} ${input.version}`;
  const html = [
    `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto">`,
    `<h2 style="margin:0 0 8px">${escapeHtml(name)} ${escapeHtml(input.version)} is live</h2>`,
    `<p style="color:#4b5563;margin:0 0 16px">A new stable release of ${escapeHtml(name)} is now available on RX Store.</p>`,
    `<p style="margin:0 0 8px"><a href="https://rx-store-web.pages.dev/app/${encodeURIComponent(input.slug)}" style="background:#FFD600;color:#0F1419;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:700">View ${escapeHtml(name)}</a></p>`,
    `<p style="color:#9ca3af;font-size:12px;margin-top:24px">You receive this because you enabled email notifications in RX Store. Turn it off anytime in Profile → Preferences.</p>`,
    `</div>`,
  ].join('');

  const results = await Promise.all(
    batch.map((u) => sendEmail(env, { to: u.email, subject, html })),
  );
  const emailed = results.filter((r) => r.ok).length;
  return { optedIn, emailed, failed: batch.length - emailed };
}

/**
 * Email the members of one developer organization who enabled "Email
 * notifications" (Profile -> Preferences) about a review decision. Uses the
 * same preference + provider as release emails; best-effort and bounded.
 */
export async function notifyOrgMembersEmail(
  env: any,
  input: { developerId: string; subject: string; bodyText: string; ctaUrl?: string },
): Promise<{ emailed: number; skipped?: string }> {
  if (!env?.RESEND_API_KEY || !env?.FROM_EMAIL) return { emailed: 0, skipped: 'email_not_configured' };
  const rows: any = await env.DB
    .prepare("SELECT u.email FROM developer_members m JOIN users u ON u.id = m.user_id WHERE m.developer_id = ? AND u.preferences LIKE ? AND u.email IS NOT NULL AND u.email != '' LIMIT 20")
    .bind(input.developerId, '%"emailNotifications":true%')
    .all()
    .catch(() => ({ results: [] }));
  const emails: string[] = (rows?.results || []).map((r: any) => r.email);
  if (!emails.length) return { emailed: 0, skipped: 'no_opted_in_members' };
  const html = [
    `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto">`,
    `<p style="color:#4b5563">${escapeHtml(input.bodyText)}</p>`,
    input.ctaUrl ? `<p style="margin:12px 0"><a href="${escapeHtml(input.ctaUrl)}" style="background:#FFD600;color:#0F1419;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:700">Open RX Store Developer Center</a></p>` : '',
    `<p style="color:#9ca3af;font-size:12px;margin-top:24px">You receive this because you enabled email notifications in RX Store. Turn it off anytime in Profile → Preferences.</p>`,
    `</div>`,
  ].join('');
  const results = await Promise.all(emails.map((to) => sendEmail(env, { to, subject: input.subject, html })));
  return { emailed: results.filter((r) => r.ok).length };
}

/** Minimal HTML escaping for user-controlled names in email bodies. */
function escapeHtml(s: string): string {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// ---------------------------------------------------------------------------
// Admin inbox templates — "directly to admin" notifications + admin replies.
// Every builder escapes user-supplied text; delivery outcomes are reported
// honestly by the caller (sent / unconfigured / failed — never faked).
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' } as any)[c] as string);
}

const BRAND_STYLE = `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;border-radius:16px;background:#111827;color:#f9fafb;border:1px solid rgba(255,255,255,.08)">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">
      <span style="width:34px;height:34px;border-radius:10px;background:#FFD600;color:#111827;font-weight:800;display:flex;align-items:center;justify-content:center">RX</span>
      <span style="font-weight:800;letter-spacing:.4px">RX <span style="color:#FFD600">Store</span></span>
    </div>`;

/** Notification TO THE ADMIN when a new inbox message arrives (direct-to-admin). */
export async function notifyAdminInboxMessage(
  env: any,
  input: { type: string; name: string; email: string; subject: string; message: string },
): Promise<SendEmailResult> {
  const adminTo = await getSetting(env, 'support_email', '');
  if (!adminTo) return { ok: false, skipped: 'email-not-configured' };
  const typeLabel: Record<string, string> = { ad_booking: 'Advertisement booking', contact: 'Contact message', support: 'Support request', sponsor: 'Sponsor request' };
  return sendEmail(env, {
    to: adminTo,
    subject: `[RX Store Inbox] ${typeLabel[input.type] || 'Message'}: ${input.subject.slice(0, 80)}`,
    html: `${BRAND_STYLE}
      <h2 style="margin:0 0 12px;font-size:18px">New ${esc(typeLabel[input.type] || 'message')} in the admin inbox</h2>
      <p style="margin:0 0 10px;color:#9ca3af;font-size:13px">From: <b style="color:#f9fafb">${esc(input.name)}</b> &lt;${esc(input.email)}&gt;</p>
      <p style="margin:0 0 14px;color:#9ca3af;font-size:13px">Subject: <b style="color:#f9fafb">${esc(input.subject)}</b></p>
      <div style="background:rgba(255,255,255,.05);border-radius:12px;padding:14px;font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(input.message)}</div>
      <p style="margin:16px 0 0;font-size:13px;color:#9ca3af">Reply directly from <b style="color:#f9fafb">Admin → Inbox</b> in the RX Store portal.</p>
    </div>`,
  });
}

/** Acknowledgement TO THE SENDER — confirms the message reached the admin. */
export async function acknowledgeInboxMessage(
  env: any,
  input: { to: string; type: string; subject: string },
): Promise<SendEmailResult> {
  const typeLabel: Record<string, string> = { ad_booking: 'advertisement booking request', contact: 'message', support: 'support request', sponsor: 'sponsor request' };
  return sendEmail(env, {
    to: input.to,
    subject: `We received your ${typeLabel[input.type] || 'message'} — RX Store`,
    html: `${BRAND_STYLE}
      <h2 style="margin:0 0 12px;font-size:18px">Thank you, we got it ✅</h2>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6">Your ${esc(typeLabel[input.type] || 'message')} (“${esc(input.subject)}”) has landed in the RX Store admin inbox and the team has been notified.</p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#9ca3af">We usually reply within one business day. If you don't hear from us, reply to this email and it will reach us.</p>
      <p style="margin:0;font-size:13px;color:#9ca3af">— The RX Store team, Calcitonin Technologies</p>
    </div>`,
  });
}

export interface InboxReplyTemplate {
  id: string;
  label: string;
  subject: string;
  body: string; // {name} / {subject} / {custom} placeholders
}

/**
 * Admin-selectable reply templates (Admin → Inbox → Reply). `custom` in the
 * body is replaced with the admin's own message; everything user-supplied is
 * escaped at build time.
 */
export const INBOX_REPLY_TEMPLATES: InboxReplyTemplate[] = [
  {
    id: 'ad_approved',
    label: 'Ad booking — approved 🎉',
    subject: 'Your RX Store ad slot is approved',
    body: `Hi {name},

Great news — your advertisement booking (“{subject}”) is approved! We're scheduling your sponsored card onto the RX Store welcome screen.

Next steps:
• We'll confirm your final headline, banner art and target link.
• Your card goes live after creative hand-off (usually within a day).
• Views and clicks are counted server-side and shared with you — no estimates.

{custom}

Welcome to the first 3 seconds of RX Store 🚀
— The RX Store team, Calcitonin Technologies`,
  },
  {
    id: 'ad_declined',
    label: 'Ad booking — declined',
    subject: 'About your RX Store ad booking',
    body: `Hi {name},

Thank you for your interest in the RX Store welcome-screen slot (“{subject}”).

After review we won't be able to run this booking as requested. {custom}

We'd be glad to reconsider a future campaign — just reply to this email.
— The RX Store team, Calcitonin Technologies`,
  },
  {
    id: 'ad_ack',
    label: 'Ad booking — received, in review',
    subject: 'We received your ad booking — RX Store',
    body: `Hi {name},

Thanks for booking the RX Store welcome-screen slot (“{subject}”). Your request is in review right now.

We'll come back to you with a decision, scheduling and pricing details — usually within one business day. {custom}

— The RX Store team, Calcitonin Technologies`,
  },
  {
    id: 'general_reply',
    label: 'General reply',
    subject: 'Re: {subject}',
    body: `Hi {name},

Thanks for reaching out to RX Store about “{subject}”.

{custom}

— The RX Store team, Calcitonin Technologies`,
  },
  {
    id: 'support_resolved',
    label: 'Support — resolved',
    subject: 'Resolved: {subject}',
    body: `Hi {name},

Your support request (“{subject}”) has been handled. {custom}

If anything is still not working, just reply to this email and it lands straight back with us.

— The RX Store team, Calcitonin Technologies`,
  },
];

/** Template ids + labels for the admin UI dropdown. */
export function listInboxReplyTemplates(): Array<{ id: string; label: string; subject: string }> {
  return INBOX_REPLY_TEMPLATES.map((t) => ({ id: t.id, label: t.label, subject: t.subject }));
}

/** Render a reply template for a specific message (all user text escaped). */
export function renderInboxReplyTemplate(
  templateId: string,
  ctx: { name: string; subject: string; custom: string },
): { subject: string; html: string } | null {
  const t = INBOX_REPLY_TEMPLATES.find((x) => x.id === templateId);
  if (!t) return null;
  const body = t.body.replace(/\{name\}/g, esc(ctx.name)).replace(/\{subject\}/g, esc(ctx.subject)).replace(/\{custom\}/g, esc(ctx.custom));
  // Subject lines are PLAIN TEXT headers — strip any angle brackets so a
  // user-supplied subject can never inject HTML/markup into them.
  const plainSubject = ctx.subject.replace(/[<>]/g, '').slice(0, 80);
  return {
    subject: t.subject.replace(/\{subject\}/g, plainSubject),
    html: `${BRAND_STYLE}
      <div style="font-size:14px;line-height:1.7;white-space:pre-wrap">${body}</div>
    </div>`,
  };
}
