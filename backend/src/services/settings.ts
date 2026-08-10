/**
 * Site Settings — admin-controlled live toggles stored in D1.
 * Table is created lazily so no migration step is required.
 * Reads are cached for 30s per isolate (settings change rarely).
 */

export const SETTING_DEFAULTS: Record<string, string> = {
  platform_name: 'RX Store',
  support_email: 'support@rxstore.com',
  announcement: '',
  maintenance_mode: '0',
  ai_enabled: '1',
  allow_registration: '1',
  downloads_open: '1',
  reviews_open: '1',
  ios_recommend_pwa: '1',
  mobile_store_view: '1',
  storage_quota_gb: '10',
};

/** Keys exposed to the public (no secrets, no admin-only flags). */
export const PUBLIC_SETTING_KEYS = [
  'platform_name',
  'support_email',
  'announcement',
  'maintenance_mode',
  'ai_enabled',
  'ios_recommend_pwa',
  'mobile_store_view',
];

let cache: { at: number; map: Record<string, string> } | null = null;

export async function ensureSettingsTable(env: any): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS site_settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL DEFAULT '',
       updated_at TEXT DEFAULT (datetime('now'))
     )`
  ).run().catch(() => {});
}

export async function getAllSettings(env: any): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < 30_000) return cache.map;
  await ensureSettingsTable(env);
  const rows: any = await env.DB.prepare('SELECT key, value FROM site_settings').all().catch(() => ({ results: [] }));
  const map: Record<string, string> = {};
  for (const r of rows?.results || []) map[r.key] = r.value;
  cache = { at: Date.now(), map };
  return map;
}

export async function getSetting(env: any, key: string, fallback = ''): Promise<string> {
  const all = await getAllSettings(env);
  return all[key] ?? SETTING_DEFAULTS[key] ?? fallback;
}

export async function putSettings(env: any, updates: Record<string, string>): Promise<void> {
  await ensureSettingsTable(env);
  for (const [k, v] of Object.entries(updates)) {
    if (!(k in SETTING_DEFAULTS)) continue; // whitelist known keys only
    await env.DB.prepare(
      `INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).bind(k, String(v)).run();
  }
  cache = null; // invalidate so enforcement picks up instantly
}
