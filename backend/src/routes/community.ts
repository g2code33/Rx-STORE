/**
 * Developer community + API tokens (Phase 20).
 *
 * A REAL public forum for the developer ecosystem (categories, discussions,
 * replies, reporting, moderation with audit) — completely separate from the
 * private developer↔admin communication threads (Phase 14). Anyone signed in
 * may participate; developer org members get their org name attributed.
 *
 * Moderation follows the Phase 17 review model: hide/remove are statuses
 * (rows are never silently deleted), reasons are required and audited, open
 * reports resolve with the moderation decision.
 *
 * API tokens: scoped (analytics.read / apps.read / releases.read), revocable
 * and rotatable; the raw token is returned exactly ONCE at creation — only
 * its SHA-256 hash is stored. Tokens authenticate via `Authorization: Bearer
 * rxs_...` on the documented read endpoints.
 */

import { verifyAccessToken } from '../services/auth.ts';
import { resolveMembership, auditDev } from './developers.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

async function bodyOf(request: Request): Promise<any> {
  return await request.json().catch(() => ({}));
}

async function globalAudit(env: any, action: string, resourceType: string, resourceId: string, details: Record<string, unknown> = {}) {
  await env.DB.prepare('INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?,?,?)')
    .bind(rid('log'), action, resourceType, resourceId, JSON.stringify(details)).run().catch(() => {});
}

async function sha256Hex(text: string): Promise<string> {
  const digest: ArrayBuffer = await (crypto as any).subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b: number) => b.toString(16).padStart(2, '0')).join('');
}

/** Resolve the caller: (userId, orgId | null, orgName | null). */
async function callerOrg(env: any, userId: string): Promise<{ orgId: string | null; orgName: string | null }> {
  const ms = await resolveMembership(env, userId).catch(() => null);
  if (!ms) return { orgId: null, orgName: null };
  const profile: any = await env.DB.prepare('SELECT publisher_name FROM developer_profiles WHERE developer_id=?')
    .bind(ms.developer.id).first().catch(() => null);
  return { orgId: ms.developer.id, orgName: profile?.publisher_name || null };
}

/** Text quality gate for posts (short, explainable, unit-tested). */
export function communityTextCheck(kind: 'discussion' | 'reply', title: string, body: string): string | null {
  if (kind === 'discussion') {
    if (title.length < 5) return 'Titles need at least 5 characters.';
    if (title.length > 150) return 'Titles are limited to 150 characters.';
  }
  if (body.length < 10) return 'Posts need at least 10 characters of real content.';
  if (body.length > 5000) return 'Posts are limited to 5000 characters.';
  if (/(.)\1{11,}/.test(body)) return 'This looks like filler text — please write a real post.';
  return null;
}

// ---------------------------------------------------------------------------
// Public community routes (read = public, write = signed in)
// ---------------------------------------------------------------------------

export const communityRoutes = {

  /** GET /community/categories */
  async categories(request: Request, env: any) {
    const cats: any = await env.DB.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM community_discussions d WHERE d.category_id = c.id AND d.status='visible') AS discussion_count
       FROM community_categories c ORDER BY c.sort_order ASC`
    ).all().catch(() => ({ results: [] }));
    return { categories: cats?.results || [] };
  },

  /** GET /community/discussions?category=&page=&limit= — visible discussions, newest activity first. */
  async listDiscussions(request: Request, env: any) {
    const url = new URL(request.url);
    const category = url.searchParams.get('category') || '';
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1') || 1);
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20') || 20));

    const rows: any = await env.DB.prepare(
      `SELECT d.id, d.title, d.body, d.reply_count, d.last_activity_at, d.created_at,
              u.name AS author_name, p.publisher_name AS author_org
       FROM community_discussions d
       LEFT JOIN users u ON u.id = d.author_user_id
       LEFT JOIN developer_profiles p ON p.developer_id = d.developer_org_id
       WHERE d.status='visible' ${category ? 'AND d.category_id=?' : ''}
       ORDER BY d.last_activity_at DESC LIMIT ? OFFSET ?`
    ).bind(...(category ? [category, limit, (page - 1) * limit] : [limit, (page - 1) * limit])).all().catch(() => ({ results: [] }));

    const totalRow: any = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM community_discussions WHERE status='visible' ${category ? 'AND category_id=?' : ''}`
    ).bind(...(category ? [category] : [])).first().catch(() => ({ total: 0 }));
    const total = Number(totalRow?.total) || 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return {
      discussions: (rows?.results || []).map((d: any) => ({
        id: d.id, title: d.title, excerpt: String(d.body || '').slice(0, 180),
        replyCount: Number(d.reply_count) || 0,
        author: d.author_org || d.author_name || 'Member',
        isOrgPost: !!d.author_org,
        lastActivityAt: d.last_activity_at, createdAt: d.created_at,
      })),
      pagination: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrevious: page > 1 },
    };
  },

  /** GET /community/discussions/:id — the discussion + visible replies. */
  async getDiscussion(request: Request, env: any) {
    const id = decodeURIComponent(new URL(request.url).pathname.split('/')[3] || '');
    const d: any = await env.DB.prepare(
      `SELECT d.*, u.name AS author_name, p.publisher_name AS author_org, c.slug AS category_slug, c.name AS category_name
       FROM community_discussions d
       LEFT JOIN users u ON u.id = d.author_user_id
       LEFT JOIN developer_profiles p ON p.developer_id = d.developer_org_id
       LEFT JOIN community_categories c ON c.id = d.category_id
       WHERE d.id=?`
    ).bind(id).first().catch(() => null);
    if (!d || d.status !== 'visible') return { error: 'Discussion not found', code: 'NOT_FOUND' };

    const replies: any = await env.DB.prepare(
      `SELECT r.id, r.body, r.created_at, u.name AS author_name, p.publisher_name AS author_org
       FROM community_replies r
       LEFT JOIN users u ON u.id = r.author_user_id
       LEFT JOIN developer_profiles p ON p.developer_id = r.developer_org_id
       WHERE r.discussion_id=? AND r.status='visible'
       ORDER BY r.created_at ASC LIMIT 200`
    ).bind(id).all().catch(() => ({ results: [] }));

    return {
      discussion: {
        id: d.id, title: d.title, body: d.body,
        category: { id: d.category_id, slug: d.category_slug, name: d.category_name },
        author: d.author_org || d.author_name || 'Member', isOrgPost: !!d.author_org,
        replyCount: Number(d.reply_count) || 0, createdAt: d.created_at, lastActivityAt: d.last_activity_at,
      },
      replies: (replies?.results || []).map((r: any) => ({
        id: r.id, body: r.body, author: r.author_org || r.author_name || 'Member',
        isOrgPost: !!r.author_org, createdAt: r.created_at,
      })),
    };
  },

  /** POST /community/discussions {categoryId, title, body} — signed in. */
  async createDiscussion(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Sign in to post', code: 'UNAUTHORIZED' };
    const body = await bodyOf(request);
    const categoryId = str(body.categoryId, 60);
    const title = str(body.title, 150);
    const text = str(body.body, 5000);

    const cat: any = await env.DB.prepare('SELECT id FROM community_categories WHERE id=? OR slug=?').bind(categoryId, categoryId).first().catch(() => null);
    if (!cat) return { error: 'Pick a valid category.', code: 'VALIDATION_ERROR' };
    const gate = communityTextCheck('discussion', title, text);
    if (gate) return { error: gate, code: 'VALIDATION_ERROR' };

    // Cooldown: max 5 posts per hour per user.
    const recent: any = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM community_discussions WHERE author_user_id=? AND created_at >= datetime('now','-1 hour'))
            + (SELECT COUNT(*) FROM community_replies WHERE author_user_id=? AND created_at >= datetime('now','-1 hour')) AS c`
    ).bind(userId, userId).first().catch(() => ({ c: 0 }));
    if (Number(recent?.c || 0) >= 5) return { error: 'You are posting too quickly — please wait a while.', code: 'RATE_LIMITED' };

    const org = await callerOrg(env, userId);
    const id = rid('cd');
    await env.DB.prepare(
      `INSERT INTO community_discussions (id, category_id, author_user_id, developer_org_id, title, body, last_activity_at)
       VALUES (?,?,?,?,?,?,datetime('now'))`
    ).bind(id, cat.id, userId, org.orgId, title, text).run();
    return { discussion: { id, title } };
  },

  /** POST /community/discussions/:id/replies {body} — signed in. */
  async createReply(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Sign in to reply', code: 'UNAUTHORIZED' };
    const discussionId = decodeURIComponent(new URL(request.url).pathname.split('/')[3] || '');
    const d: any = await env.DB.prepare('SELECT id, status FROM community_discussions WHERE id=?').bind(discussionId).first().catch(() => null);
    if (!d || d.status !== 'visible') return { error: 'Discussion not found', code: 'NOT_FOUND' };

    const text = str((await bodyOf(request)).body, 5000);
    const gate = communityTextCheck('reply', '', text);
    if (gate) return { error: gate, code: 'VALIDATION_ERROR' };

    const recent: any = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM community_discussions WHERE author_user_id=? AND created_at >= datetime('now','-1 hour'))
            + (SELECT COUNT(*) FROM community_replies WHERE author_user_id=? AND created_at >= datetime('now','-1 hour')) AS c`
    ).bind(userId, userId).first().catch(() => ({ c: 0 }));
    if (Number(recent?.c || 0) >= 5) return { error: 'You are posting too quickly — please wait a while.', code: 'RATE_LIMITED' };

    const org = await callerOrg(env, userId);
    const id = rid('cr');
    await env.DB.prepare(
      'INSERT INTO community_replies (id, discussion_id, author_user_id, developer_org_id, body) VALUES (?,?,?,?,?)'
    ).bind(id, discussionId, userId, org.orgId, text).run();
    await env.DB.prepare(
      'UPDATE community_discussions SET reply_count = reply_count + 1, last_activity_at=datetime(\'now\') WHERE id=?'
    ).bind(discussionId).run();
    return { reply: { id } };
  },

  /** POST /community/reports {targetType, targetId, reason, details?} — signed in, one report per target+user. */
  async report(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Sign in to report', code: 'UNAUTHORIZED' };
    const body = await bodyOf(request);
    const targetType = str(body.targetType, 20);
    const targetId = str(body.targetId, 60);
    const reason = str(body.reason, 30).toLowerCase();
    const REASONS = ['spam', 'harassment', 'irrelevant', 'malicious_content', 'other'];
    if (!['discussion', 'reply'].includes(targetType) || !targetId) {
      return { error: 'targetType (discussion|reply) and targetId are required.', code: 'VALIDATION_ERROR' };
    }
    if (!REASONS.includes(reason)) return { error: `Reason must be one of: ${REASONS.join(', ')}.`, code: 'VALIDATION_ERROR' };

    const table = targetType === 'discussion' ? 'community_discussions' : 'community_replies';
    const target: any = await env.DB.prepare(`SELECT id FROM ${table} WHERE id=?`).bind(targetId).first().catch(() => null);
    if (!target) return { error: 'Not found', code: 'NOT_FOUND' };

    const dup: any = await env.DB.prepare(
      'SELECT id, status FROM community_reports WHERE target_type=? AND target_id=? AND reporter_user_id=?'
    ).bind(targetType, targetId, userId).first().catch(() => null);
    if (dup) return { error: 'You have already reported this.', code: 'VALIDATION_ERROR' };

    const id = rid('crep');
    await env.DB.prepare(
      'INSERT INTO community_reports (id, target_type, target_id, reporter_user_id, reason, details) VALUES (?,?,?,?,?,?)'
    ).bind(id, targetType, targetId, userId, reason, str(body.details, 500) || null).run();
    return { report: { id, reason } };
  },
};

// ---------------------------------------------------------------------------
// Admin moderation (admin JWT enforced by index.ts)
// ---------------------------------------------------------------------------

export const adminCommunityRoutes = {

  /** GET /admin/community/reports?status=open */
  async reports(request: Request, env: any) {
    const status = new URL(request.url).searchParams.get('status') || 'open';
    const rows: any = await env.DB.prepare(
      `SELECT rp.id AS report_id, rp.reason, rp.details, rp.status AS report_status, rp.created_at AS reported_at,
              rp.target_type, rp.target_id, ru.name AS reporter_name,
              au.name AS author_name,
              CASE WHEN rp.target_type='discussion' THEN d.title ELSE SUBSTR(r.body, 1, 120) END AS target_preview,
              CASE WHEN rp.target_type='discussion' THEN d.status ELSE r.status END AS target_status
       FROM community_reports rp
       LEFT JOIN users ru ON ru.id = rp.reporter_user_id
       LEFT JOIN community_discussions d ON rp.target_type='discussion' AND d.id = rp.target_id
       LEFT JOIN community_replies r ON rp.target_type='reply' AND r.id = rp.target_id
       LEFT JOIN users au ON au.id = COALESCE(d.author_user_id, r.author_user_id)
       WHERE rp.status = ?
       ORDER BY rp.created_at DESC LIMIT 200`
    ).bind(status).all().catch(() => ({ results: [] }));
    return { reports: rows?.results || [] };
  },

  /**
   * POST /admin/community/:targetType/:id/moderate {action: hide|restore|remove, reason}
   * Reason REQUIRED; rows are never deleted; open reports resolve; audited.
   */
  async moderate(request: Request, env: any) {
    const adminId = ((request as any).user as any)?.userId || null;
    if (!adminId) return { error: 'Admin identity required', code: 'UNAUTHORIZED' };
    const segs = new URL(request.url).pathname.split('/');
    const targetType = decodeURIComponent(segs[3] || '');
    const targetId = decodeURIComponent(segs[4] || '');
    if (!['discussion', 'reply'].includes(targetType)) return { error: 'targetType must be discussion or reply', code: 'VALIDATION_ERROR' };

    const body = await bodyOf(request);
    const action = str(body.action, 10).toLowerCase();
    if (!['hide', 'restore', 'remove'].includes(action)) {
      return { error: 'action must be hide, restore or remove', code: 'VALIDATION_ERROR' };
    }
    const reason = str(body.reason, 1000);
    if (reason.length < 10) return { error: 'A moderation reason of at least 10 characters is required.', code: 'VALIDATION_ERROR' };

    const table = targetType === 'discussion' ? 'community_discussions' : 'community_replies';
    const target: any = await env.DB.prepare(`SELECT id, status FROM ${table} WHERE id=?`).bind(targetId).first().catch(() => null);
    if (!target) return { error: 'Not found', code: 'NOT_FOUND' };

    const newStatus = action === 'hide' ? 'hidden' : action === 'remove' ? 'removed' : 'visible';
    if (target.status === newStatus) return { error: `Already ${newStatus}.`, code: 'VALIDATION_ERROR' };

    await env.DB.prepare(
      `UPDATE ${table} SET status=?, moderation_reason=?, moderated_at=datetime('now'), moderated_by=? WHERE id=?`
    ).bind(newStatus, reason, adminId, targetId).run();

    await env.DB.prepare(
      `UPDATE community_reports SET status='resolved', resolved_by=?, resolved_at=datetime('now')
       WHERE target_type=? AND target_id=? AND status='open'`
    ).bind(adminId, targetType, targetId).run().catch(() => {});

    const actionName = action === 'restore' ? 'community_restored' : action === 'hide' ? 'community_hidden' : 'community_removed';
    await globalAudit(env, actionName, targetType, targetId, { reason, adminId });
    return { target: { id: targetId, status: newStatus } };
  },
};

// ---------------------------------------------------------------------------
// Developer API tokens (Phase 20 §8)
// ---------------------------------------------------------------------------

/** The scopes an API token may hold (read-only, least privilege). */
export const API_TOKEN_SCOPES = ['analytics.read', 'apps.read', 'releases.read'] as const;

export const developerTokenRoutes = {

  /** GET /developers/tokens — list tokens (metadata only, never the secret). */
  async list(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const rows: any = await env.DB.prepare(
      'SELECT id, name, token_prefix, scopes, last_used_at, revoked_at, created_at FROM developer_api_tokens WHERE developer_id=? ORDER BY created_at DESC'
    ).bind(ms.developer.id).all().catch(() => ({ results: [] }));
    return {
      tokens: (rows?.results || []).map((t: any) => ({
        id: t.id, name: t.name, prefix: t.token_prefix,
        scopes: (() => { try { return JSON.parse(t.scopes || '[]'); } catch { return []; } })(),
        lastUsedAt: t.last_used_at, revokedAt: t.revoked_at, createdAt: t.created_at,
      })),
    };
  },

  /**
   * POST /developers/tokens {name, scopes[]} — creates a token. The RAW token
   * is returned exactly ONCE; only its SHA-256 hash is stored.
   */
  async create(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    // Only roles with security visibility may mint tokens.
    if (!['OWNER', 'ADMIN'].includes(ms.member.role)) {
      return { error: 'Only Owner or Admin roles can create API tokens.', code: 'FORBIDDEN' };
    }
    const body = await bodyOf(request);
    const name = str(body.name, 60) || 'API token';
    const requested: string[] = Array.isArray(body.scopes) ? body.scopes.map((s: any) => String(s)) : [];
    const scopes = [...new Set(requested)].filter((s) => (API_TOKEN_SCOPES as readonly string[]).includes(s));
    if (!scopes.length) return { error: `Pick at least one scope: ${API_TOKEN_SCOPES.join(', ')}.`, code: 'VALIDATION_ERROR' };

    // Bound live tokens per org.
    const live: any = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM developer_api_tokens WHERE developer_id=? AND revoked_at IS NULL'
    ).bind(ms.developer.id).first().catch(() => ({ c: 0 }));
    if (Number(live?.c || 0) >= 10) return { error: 'Token limit reached — revoke an unused token first.', code: 'VALIDATION_ERROR' };

    const raw = `rxs_${Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b: number) => b.toString(16).padStart(2, '0')).join('')}`;
    const tokenHash = await sha256Hex(raw);
    const id = rid('tok');
    await env.DB.prepare(
      'INSERT INTO developer_api_tokens (id, developer_id, created_by, name, token_hash, token_prefix, scopes) VALUES (?,?,?,?,?,?,?)'
    ).bind(id, ms.developer.id, userId, name, tokenHash, raw.slice(0, 11), JSON.stringify(scopes)).run();
    await auditDev(env, ms.developer.id, userId, 'api_token_created', { tokenId: id, scopes });
    return { token: { id, name, prefix: raw.slice(0, 11), scopes }, secret: raw, note: 'Store this token now — it is shown only once and cannot be recovered.' };
  },

  /** POST /developers/tokens/:id/revoke */
  async revoke(request: Request, env: any) {
    const userId = ((request as any).user as any)?.userId || null;
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    if (!['OWNER', 'ADMIN'].includes(ms.member.role)) {
      return { error: 'Only Owner or Admin roles can revoke API tokens.', code: 'FORBIDDEN' };
    }
    const id = decodeURIComponent(new URL(request.url).pathname.split('/')[3] || '');
    const tok: any = await env.DB.prepare('SELECT * FROM developer_api_tokens WHERE id=? AND developer_id=?')
      .bind(id, ms.developer.id).first().catch(() => null);
    if (!tok) return { error: 'Token not found', code: 'NOT_FOUND' };
    if (tok.revoked_at) return { error: 'Already revoked', code: 'VALIDATION_ERROR' };
    await env.DB.prepare('UPDATE developer_api_tokens SET revoked_at=datetime(\'now\') WHERE id=?').bind(id).run();
    await auditDev(env, ms.developer.id, userId, 'api_token_revoked', { tokenId: id });
    return { success: true };
  },
};

/**
 * Authenticate a request via API token (rxs_...). Returns
 * { developerId, scopes, tokenId } or null. Used by the documented
 * token-authenticated read endpoints.
 */
export async function authenticateApiToken(request: Request, env: any): Promise<{ developerId: string; scopes: string[]; tokenId: string } | null> {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer rxs_')) return null;
  const raw = auth.slice(7);
  const tokenHash = await sha256Hex(raw);
  const tok: any = await env.DB.prepare(
    'SELECT * FROM developer_api_tokens WHERE token_hash=? AND revoked_at IS NULL'
  ).bind(tokenHash).first().catch(() => null);
  if (!tok) return null;
  let scopes: string[] = [];
  try { scopes = JSON.parse(tok.scopes || '[]'); } catch { scopes = []; }
  await env.DB.prepare('UPDATE developer_api_tokens SET last_used_at=datetime(\'now\') WHERE id=?').bind(tok.id).run().catch(() => {});
  return { developerId: tok.developer_id, scopes, tokenId: tok.id };
}
