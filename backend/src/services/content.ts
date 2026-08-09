/**
 * Site Content — public website copy & design tokens edited in the Live Website
 * Builder. Key→value store in D1; table created lazily (no migration needed).
 * Values are strings (JSON-encoded for lists/objects). Reads cached 30s.
 */

let cache: { at: number; map: Record<string, string> } | null = null;

export async function ensureContentTable(env: any): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS site_content (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL DEFAULT '',
       updated_at TEXT DEFAULT (datetime('now'))
     )`
  ).run().catch(() => {});
}

export async function ensureHistoryTable(env: any): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS site_content_history (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       key TEXT NOT NULL,
       value TEXT NOT NULL DEFAULT '',
       created_at TEXT DEFAULT (datetime('now'))
     )`
  ).run().catch(() => {});
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_content_history_key ON site_content_history (key, id DESC)`
  ).run().catch(() => {});
}

export async function getAllContent(env: any): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < 30_000) return cache.map;
  await ensureContentTable(env);
  const rows: any = await env.DB.prepare('SELECT key, value FROM site_content').all().catch(() => ({ results: [] }));
  const map: Record<string, string> = {};
  for (const r of rows?.results || []) map[r.key] = r.value;
  cache = { at: Date.now(), map };
  return map;
}

const KEY_RE = /^[a-z0-9][a-z0-9._:-]{0,119}$/i;

export async function putContent(env: any, updates: Record<string, unknown>): Promise<{ saved: string[]; skipped: string[] }> {
  await ensureContentTable(env);
  await ensureHistoryTable(env);
  const saved: string[] = [];
  const skipped: string[] = [];
  for (const [k, raw] of Object.entries(updates || {})) {
    const value = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!KEY_RE.test(k) || value.length > 60000) { skipped.push(k); continue; }
    const r = await env.DB.prepare(
      `INSERT INTO site_content (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).bind(k, value).run().catch(() => ({ success: false }));
    if ((r as any)?.success === false) { skipped.push(k); continue; }
    // Revision history: keep the last 30 versions of each key
    await env.DB.prepare(`INSERT INTO site_content_history (key, value) VALUES (?, ?)`).bind(k, value).run().catch(() => {});
    await env.DB.prepare(
      `DELETE FROM site_content_history WHERE key = ? AND id NOT IN (
         SELECT id FROM site_content_history WHERE key = ? ORDER BY id DESC LIMIT 30
       )`
    ).bind(k, k).run().catch(() => {});
    saved.push(k);
  }
  cache = null; // publish instantly
  return { saved, skipped };
}

export interface ContentRevision { id: number; key: string; value: string; created_at: string }

export async function getContentHistory(env: any, key: string, limit = 30): Promise<ContentRevision[]> {
  await ensureHistoryTable(env);
  const rows: any = await env.DB.prepare(
    `SELECT id, key, value, created_at FROM site_content_history WHERE key = ? ORDER BY id DESC LIMIT ?`
  ).bind(key, limit).all().catch(() => ({ results: [] }));
  return (rows?.results || []) as ContentRevision[];
}

/** Restore a key to an earlier revision (the revert itself becomes a new revision). */
export async function revertContent(env: any, key: string, historyId: number): Promise<{ ok: boolean; value?: string }> {
  await ensureHistoryTable(env);
  const row: any = await env.DB.prepare(
    `SELECT value FROM site_content_history WHERE id = ? AND key = ?`
  ).bind(historyId, key).first().catch(() => null);
  if (!row) return { ok: false };
  const res = await putContent(env, { [key]: row.value });
  return res.saved.includes(key) ? { ok: true, value: row.value } : { ok: false };
}
