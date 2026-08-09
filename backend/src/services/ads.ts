/**
 * Intro Ad Stats — server-side view/click totals for the welcome-intro
 * sponsored cards. The public beacon increments rounded counters; the admin
 * reads totals per ad. Table created lazily (no migration needed).
 */

export async function ensureAdsTable(env: any): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ad_stats (
       ad_id TEXT PRIMARY KEY,
       views INTEGER NOT NULL DEFAULT 0,
       clicks INTEGER NOT NULL DEFAULT 0,
       updated_at TEXT DEFAULT (datetime('now'))
     )`
  ).run().catch(() => {});
}

const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,99}$/i;

export async function trackAdEvent(env: any, id: string, type: string): Promise<{ ok: boolean; error?: string }> {
  if (!ID_RE.test(id || '')) return { ok: false, error: 'valid ad id required' };
  if (type !== 'view' && type !== 'click') return { ok: false, error: "type must be 'view' or 'click'" };
  await ensureAdsTable(env);
  await env.DB.prepare(
    `INSERT INTO ad_stats (ad_id, views, clicks, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(ad_id) DO UPDATE SET
       views = views + excluded.views,
       clicks = clicks + excluded.clicks,
       updated_at = datetime('now')`
  ).bind(id, type === 'view' ? 1 : 0, type === 'click' ? 1 : 0).run().catch(() => {});
  return { ok: true };
}

export interface AdStatRow { ad_id: string; views: number; clicks: number; updated_at?: string }

export async function getAdStats(env: any): Promise<AdStatRow[]> {
  await ensureAdsTable(env);
  const rows: any = await env.DB.prepare('SELECT ad_id, views, clicks, updated_at FROM ad_stats ORDER BY views DESC').all().catch(() => ({ results: [] }));
  return rows?.results || [];
}
