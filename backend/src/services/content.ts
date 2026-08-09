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
  const saved: string[] = [];
  const skipped: string[] = [];
  for (const [k, raw] of Object.entries(updates || {})) {
    const value = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!KEY_RE.test(k) || value.length > 60000) { skipped.push(k); continue; }
    await env.DB.prepare(
      `INSERT INTO site_content (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).bind(k, value).run().catch(() => { skipped.push(k); });
    saved.push(k);
  }
  cache = null; // publish instantly
  return { saved, skipped };
}
