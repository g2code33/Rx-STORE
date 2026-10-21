/**
 * RX Store — admin awareness events.
 *
 * Every meaningful state change raises ONE row in `admin_events`, tagged with
 * the admin sidebar SECTION it belongs to. The UI turns those rows into
 * numbered badges on the matching tab; opening the tab marks its rows read so
 * the number disappears after viewing.
 *
 * Contract:
 *   - emit is ALWAYS best-effort: a notification failure must never fail the
 *     business action that raised it (callers may `void notifyAdmin(...)`).
 *   - no secrets, tokens or PII beyond ids/names/titles in `meta`.
 *   - idempotent-ish by design: duplicates are acceptable (two submissions =
 *     two events); the UI shows counts, not deduplicated threads.
 */

export type AdminEventType = 'info' | 'action_required' | 'warning' | 'success' | 'error';

/** Admin sidebar section ids that own badges. */
export const ADMIN_SECTIONS = [
  'dashboard', 'applications', 'releases', 'users', 'inbox', 'icons', 'payments',
  'community', 'reviews', 'storefront', 'developers', 'github', 'security',
  'ai', 'analytics', 'revenue', 'uploads', 'recycle', 'settings',
] as const;
export type AdminSection = typeof ADMIN_SECTIONS[number];

export interface AdminEventInput {
  /** Sidebar section that should light up. */
  section: AdminSection | string;
  type?: AdminEventType;
  title: string;
  message?: string;
  /** In-app destination, e.g. '/admin?section=releases'. */
  link?: string;
  /** Structured ids only — never secrets. */
  meta?: Record<string, unknown>;
  actorUserId?: string | null;
}

let ensured = false;

export async function ensureAdminEventTable(env: any): Promise<void> {
  if (ensured) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_events (
    id TEXT PRIMARY KEY, section TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', link TEXT, meta TEXT,
    actor_user_id TEXT, read_at TEXT, read_by TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`).run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_admin_events_section ON admin_events(section, read_at)').run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_admin_events_unread ON admin_events(read_at)').run().catch(() => {});
  ensured = true;
}

/** Raise one admin event. NEVER throws. */
export async function notifyAdmin(env: any, event: AdminEventInput): Promise<void> {
  try {
    if (!env?.DB?.prepare) return;
    await ensureAdminEventTable(env);
    await env.DB.prepare(
      `INSERT INTO admin_events (id, section, type, title, message, link, meta, actor_user_id)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(
      `ae_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      String(event.section || 'dashboard'), event.type || 'info',
      String(event.title || '').slice(0, 300), String(event.message || '').slice(0, 2000),
      event.link ? String(event.link).slice(0, 500) : null,
      event.meta ? JSON.stringify(event.meta).slice(0, 4000) : null,
      event.actorUserId || null,
    ).run();
  } catch { /* awareness must never break the action */ }
}

export interface AdminCounts { total: number; bySection: Record<string, number>; unreadOldest: string | null }

/** Unread counts per section (the badge numbers). */
export async function adminEventCounts(env: any): Promise<AdminCounts> {
  try {
    await ensureAdminEventTable(env);
    const rows: any = await env.DB.prepare(
      `SELECT section, COUNT(*) AS n FROM admin_events WHERE read_at IS NULL GROUP BY section`
    ).all().catch(() => ({ results: [] }));
    const bySection: Record<string, number> = {};
    let total = 0;
    for (const r of rows?.results || []) {
      bySection[r.section] = Number(r.n || 0);
      total += Number(r.n || 0);
    }
    const oldest: any = await env.DB.prepare(
      `SELECT created_at FROM admin_events WHERE read_at IS NULL ORDER BY created_at ASC LIMIT 1`
    ).first().catch(() => null);
    return { total, bySection, unreadOldest: oldest?.created_at || null };
  } catch {
    return { total: 0, bySection: {}, unreadOldest: null };
  }
}

export interface AdminEventRow {
  id: string; section: string; type: string; title: string; message: string;
  link: string | null; meta: string | null; read_at: string | null; created_at: string;
}

export async function adminEventList(env: any, opts: { section?: string; unreadOnly?: boolean; limit?: number } = {}): Promise<AdminEventRow[]> {
  try {
    await ensureAdminEventTable(env);
    const where: string[] = [];
    const binds: any[] = [];
    if (opts.section && opts.section !== 'all') { where.push('section=?'); binds.push(opts.section); }
    if (opts.unreadOnly) where.push('read_at IS NULL');
    const sql = `SELECT * FROM admin_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
    binds.push(Math.min(Math.max(Number(opts.limit) || 100, 1), 300));
    const rows: any = await env.DB.prepare(sql).bind(...binds).all().catch(() => ({ results: [] }));
    return rows?.results || [];
  } catch {
    return [];
  }
}

/**
 * Mark a section's events as read (numbers disappear after viewing).
 * `section='all'` clears everything.
 */
export async function markAdminEventsSeen(env: any, section: string, adminUserId: string): Promise<number> {
  try {
    await ensureAdminEventTable(env);
    const res: any = section === 'all'
      ? await env.DB.prepare(
          `UPDATE admin_events SET read_at=datetime('now'), read_by=? WHERE read_at IS NULL`
        ).bind(adminUserId).run()
      : await env.DB.prepare(
          `UPDATE admin_events SET read_at=datetime('now'), read_by=? WHERE section=? AND read_at IS NULL`
        ).bind(adminUserId, section).run();
    return Number(res?.meta?.changes || 0);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Per-user (profile / developer center) notifications — counts + seen
// ---------------------------------------------------------------------------

/**
 * Unread notifications per SECTION for one user. Sections are derived from the
 * stored `section` column (new rows) or, for legacy rows, from the link inside
 * the data JSON — so old notifications still badge the right tab.
 */
export async function userNotificationCounts(env: any, userId: string): Promise<{ total: number; bySection: Record<string, number> }> {
  try {
    const rows: any = await env.DB.prepare(
      `SELECT section, data FROM notifications WHERE user_id=? AND read=0`
    ).bind(userId).all().catch(() => ({ results: [] }));
    const bySection: Record<string, number> = {};
    let total = 0;
    for (const r of rows?.results || []) {
      const section = String(r.section || sectionFromLink(r.data) || 'general');
      bySection[section] = (bySection[section] || 0) + 1;
      total++;
    }
    return { total, bySection };
  } catch {
    return { total: 0, bySection: {} };
  }
}

/** Map a stored notification link to a UI section (legacy rows). */
export function sectionFromLink(data: unknown): string | null {
  let link = '';
  try {
    const d = typeof data === 'string' ? JSON.parse(data) : (data as any);
    link = String(d?.link || '');
  } catch { return null; }
  if (!link) return null;
  if (link.includes('/developers/messages') || link.includes('/profile?tab=notifications')) return 'messages';
  if (link.includes('/developers/releases') || link.includes('/developers/apps')) return 'releases';
  if (link.includes('/developers/reviews')) return 'reviews';
  if (link.includes('/developers/revenue') || link.includes('/developers/payouts') || link.includes('/profile?tab=purchases')) return 'payments';
  if (link.includes('/profile?tab=settings')) return 'settings';
  if (link.startsWith('/app/')) return 'updates';
  return null;
}

/** Mark a user's notifications read for one section ('all' = everything). */
export async function markUserNotificationsSeen(env: any, userId: string, section: string): Promise<number> {
  try {
    if (section === 'all') {
      const res: any = await env.DB.prepare('UPDATE notifications SET read=1 WHERE user_id=? AND read=0').bind(userId).run();
      return Number(res?.meta?.changes || 0);
    }
    // Rows with the section column first…
    const byCol: any = await env.DB.prepare(
      'UPDATE notifications SET read=1 WHERE user_id=? AND read=0 AND section=?'
    ).bind(userId, section).run().catch(() => null);
    let changed = Number(byCol?.meta?.changes || 0);
    // …then legacy rows whose section is only derivable from their link.
    const legacy: any = await env.DB.prepare(
      'SELECT id, data FROM notifications WHERE user_id=? AND read=0 AND section IS NULL'
    ).bind(userId).all().catch(() => ({ results: [] }));
    for (const row of legacy?.results || []) {
      if (sectionFromLink(row.data) === section) {
        const res: any = await env.DB.prepare('UPDATE notifications SET read=1 WHERE id=?').bind(row.id).run().catch(() => null);
        changed += Number(res?.meta?.changes || 0);
      }
    }
    return changed;
  } catch {
    return 0;
  }
}
