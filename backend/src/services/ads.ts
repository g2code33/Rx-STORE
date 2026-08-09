/**
 * Intro Ad Stats — server-side view/click totals for sponsored placements,
 * plus daily series and token-gated sponsor dashboards.
 *
 *  - POST /ads/track increments rounded counters + today's daily row
 *  - GET  /admin/ads/stats returns totals per ad (admin)
 *  - POST /admin/ads/shares mints a read-only sponsor link for one ad
 *  - GET  /ads/public/<token> serves that sponsor their own stats
 *
 * Tables are created lazily (no migration needed).
 */

export async function ensureAdsTables(env: any): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ad_stats (
       ad_id TEXT PRIMARY KEY,
       views INTEGER NOT NULL DEFAULT 0,
       clicks INTEGER NOT NULL DEFAULT 0,
       updated_at TEXT DEFAULT (datetime('now'))
     )`
  ).run().catch(() => {});
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ad_daily (
       ad_id TEXT NOT NULL,
       day TEXT NOT NULL,
       views INTEGER NOT NULL DEFAULT 0,
       clicks INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (ad_id, day)
     )`
  ).run().catch(() => {});
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ad_shares (
       token TEXT PRIMARY KEY,
       ad_id TEXT NOT NULL,
       label TEXT NOT NULL DEFAULT '',
       created_at TEXT DEFAULT (datetime('now'))
     )`
  ).run().catch(() => {});
}

const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,99}$/i;
const TOKEN_RE = /^[a-f0-9]{32}$/;

export async function trackAdEvent(env: any, id: string, type: string): Promise<{ ok: boolean; error?: string }> {
  if (!ID_RE.test(id || '')) return { ok: false, error: 'valid ad id required' };
  if (type !== 'view' && type !== 'click') return { ok: false, error: "type must be 'view' or 'click'" };
  await ensureAdsTables(env);
  const v = type === 'view' ? 1 : 0;
  const c = type === 'click' ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO ad_stats (ad_id, views, clicks, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(ad_id) DO UPDATE SET
       views = views + excluded.views,
       clicks = clicks + excluded.clicks,
       updated_at = datetime('now')`
  ).bind(id, v, c).run().catch(() => {});
  await env.DB.prepare(
    `INSERT INTO ad_daily (ad_id, day, views, clicks)
     VALUES (?, date('now'), ?, ?)
     ON CONFLICT(ad_id, day) DO UPDATE SET
       views = views + excluded.views,
       clicks = clicks + excluded.clicks`
  ).bind(id, v, c).run().catch(() => {});
  return { ok: true };
}

export interface AdStatRow { ad_id: string; views: number; clicks: number; updated_at?: string }

export async function getAdStats(env: any): Promise<AdStatRow[]> {
  await ensureAdsTables(env);
  const rows: any = await env.DB.prepare('SELECT ad_id, views, clicks, updated_at FROM ad_stats ORDER BY views DESC').all().catch(() => ({ results: [] }));
  return rows?.results || [];
}

// ---------------- Sponsor share links ----------------

function newToken(): string {
  // 32 hex chars — unguessable, URL-safe, cheap to validate
  const b = new Uint8Array(16);
  (globalThis as any).crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface AdShareRow { token: string; ad_id: string; label: string; created_at?: string }

export async function createAdShare(env: any, adId: string, label: string): Promise<{ ok: boolean; error?: string; share?: AdShareRow }> {
  if (!ID_RE.test(adId || '')) return { ok: false, error: 'valid ad id required' };
  await ensureAdsTables(env);
  const share: AdShareRow = { token: newToken(), ad_id: adId, label: (label || '').slice(0, 120) };
  await env.DB.prepare('INSERT INTO ad_shares (token, ad_id, label) VALUES (?, ?, ?)')
    .bind(share.token, share.ad_id, share.label).run().catch(() => {});
  return { ok: true, share };
}

export async function listAdShares(env: any): Promise<AdShareRow[]> {
  await ensureAdsTables(env);
  const rows: any = await env.DB.prepare('SELECT token, ad_id, label, created_at FROM ad_shares ORDER BY created_at DESC').all().catch(() => ({ results: [] }));
  return rows?.results || [];
}

export async function revokeAdShare(env: any, token: string): Promise<boolean> {
  if (!TOKEN_RE.test(token || '')) return false;
  await ensureAdsTables(env);
  const r: any = await env.DB.prepare('DELETE FROM ad_shares WHERE token = ?').bind(token).run().catch(() => null);
  return Number(r?.meta?.changes || 0) > 0;
}

export interface PublicShareStats {
  adId: string;
  label: string;
  createdAt?: string;
  views: number;
  clicks: number;
  /** clicks / views × 100, one decimal */
  ctr: number;
  daily: { day: string; views: number; clicks: number }[];
}

export async function getPublicShare(env: any, token: string): Promise<PublicShareStats | null> {
  if (!TOKEN_RE.test(token || '')) return null;
  await ensureAdsTables(env);
  const share: any = await env.DB.prepare('SELECT ad_id, label, created_at FROM ad_shares WHERE token = ?').bind(token).first().catch(() => null);
  if (!share) return null;
  const totals: any = await env.DB.prepare('SELECT views, clicks FROM ad_stats WHERE ad_id = ?').bind(share.ad_id).first().catch(() => null);
  const dRows: any = await env.DB.prepare(
    'SELECT day, views, clicks FROM ad_daily WHERE ad_id = ? ORDER BY day DESC LIMIT 30'
  ).bind(share.ad_id).all().catch(() => ({ results: [] }));
  const views = Number(totals?.views) || 0;
  const clicks = Number(totals?.clicks) || 0;
  return {
    adId: share.ad_id,
    label: share.label,
    createdAt: share.created_at,
    views,
    clicks,
    ctr: views > 0 ? Math.round((clicks / views) * 1000) / 10 : 0,
    daily: (dRows?.results || []).reverse(),
  };
}
