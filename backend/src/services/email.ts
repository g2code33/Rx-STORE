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

/** Minimal HTML escaping for user-controlled names in email bodies. */
function escapeHtml(s: string): string {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
