/**
 * Applications Routes — D1 (SQLite) compatible
 */
import { getSetting } from '../services/settings';
import { verifyToken } from '../services/auth';

/** Display label per stored package platform (used for the auto-derived size). */
const SIZE_LABEL: Record<string, string> = {
  windows: 'Windows',
  linux_deb: 'Linux',
  linux: 'Linux',
  linux_appimage: 'Linux',
  flatpak: 'Linux',
  android: 'Android',
  macos: 'macOS',
  ios: 'iOS',
  web: 'Web',
};

/** Format a byte count as a human size. '' for missing/zero. */
function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Per-platform installed package sizes (in bytes), derived from the ACTUAL
 * uploaded files of published packages. The latest published package per
 * platform wins, so this stays in sync automatically when a new build / update
 * is published. Always auto-generated — never manually configured.
 */
async function appSizesFor(env: any, appIds: string[]): Promise<Record<string, Record<string, number>>> {
  if (!appIds.length) return {};
  const placeholders = appIds.map(() => '?').join(',');
  const rows: any = await env.DB.prepare(
    `SELECT p.application_id, p.platform, p.file_size
     FROM packages p JOIN releases r ON r.id = p.release_id
     WHERE p.application_id IN (${placeholders}) AND p.status='published' AND r.status='published' AND p.file_size > 0
     ORDER BY COALESCE(r.published_at, r.updated_at, r.created_at) ASC`
  ).bind(...appIds).all().catch(() => ({ results: [] }));
  const map: Record<string, Record<string, number>> = {};
  for (const r of rows.results || []) {
    (map[r.application_id] = map[r.application_id] || {})[r.platform] = r.file_size; // last = latest
  }
  return map;
}

/** Human, per-platform size summary from a sizes map. e.g. "Windows 105 MB · Android 6 MB". */
function sizeSummary(sizes: Record<string, number>): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const [platform, bytes] of Object.entries(sizes || {})) {
    const label = SIZE_LABEL[platform] || platform;
    if (seen.has(label)) continue; // dedupe linux_deb / linux_appimage / linux
    seen.add(label);
    const s = formatSize(bytes);
    if (s) parts.push(`${label} ${s}`);
  }
  return parts.join(' · ');
}

/** Wrap a raw applications row with the auto-derived size + per-platform sizes. */
function withSize(env: any, appId: string, row: any, sizes: Record<string, number>) {
  const size = sizeSummary(sizes);
  row.sizes = sizes || {};
  row.size = size || (row.size_mb ? `${row.size_mb} MB` : '—');
  return row;
}

export const appsRoutes = {
  async list(request: Request, env: any) {
    const url = new URL(request.url);
    const category = url.searchParams.get('category');
    const platform = url.searchParams.get('platform');
    const search = url.searchParams.get('search');
    const sort = url.searchParams.get('sort') || 'popular';
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);

    let query = `SELECT * FROM applications WHERE status='active'`;
    const bindings: any[] = [];

    if (category) { query += ` AND category = ?`; bindings.push(category); }
    if (search) { query += ` AND (name LIKE ? OR description LIKE ? OR category LIKE ?)`; const p = `%${search}%`; bindings.push(p,p,p); }
    if (platform) { query += ` AND platforms LIKE ?`; bindings.push(`%${platform}%`); }

    switch (sort) {
      case 'rating': query += ` ORDER BY rating DESC`; break;
      case 'newest': query += ` ORDER BY release_date DESC`; break;
      case 'name': query += ` ORDER BY name ASC`; break;
      default: query += ` ORDER BY download_count DESC`; break;
    }
    query += ` LIMIT ? OFFSET ?`;
    bindings.push(limit, (page - 1) * limit);

    const result: any = await env.DB.prepare(query).bind(...bindings).all();
    const apps = result.results || [];
    const sizesByApp = await appSizesFor(env, apps.map((a: any) => a.id));
    const normalized = apps.map((a:any)=> {
      const row: any = { ...a, platforms: tryParse(a.platforms, []), tags: tryParse(a.tags, []), screenshots: tryParse(a.screenshots, []), features: tryParse(a.features, []), releaseNotes: tryParse(a.release_notes, []), version: a.current_version || a.version || '1.0.0', downloadCount: a.download_count, reviewCount: a.review_count, priceAmount: a.price_amount, price: a.price_type || a.price };
      return withSize(env, a.id, row, sizesByApp[a.id] || {});
    });
    return { apps: normalized, pagination: { page, limit, total: normalized.length } };
  },
  async detail(request: Request, env: any) {
    const url = new URL(request.url);
    const slug = url.pathname.split('/').filter(Boolean).pop() || '';
    const app: any = await env.DB.prepare(`SELECT * FROM applications WHERE slug = ?`).bind(slug).first();
    if (!app) return { error: 'Application not found' };
    const row = { ...app, platforms: tryParse(app.platforms, []), tags: tryParse(app.tags, []), downloadCount: app.download_count, reviewCount: app.review_count, priceAmount: app.price_amount, price: app.price_type || app.price || 'free' };
    // Provide frontend defaults for fields not stored in D1
    row.longDescription = app.long_description || app.description || '';
    row.features = tryParse(app.features, null) || ['Secure & Verified', 'Cross-platform', 'Auto-updates', 'Cloud sync'];
    row.releaseNotes = tryParse(app.release_notes, null) || ['Latest stable release'];
    row.screenshots = tryParse(app.screenshots, []);
    row.gradient = app.gradient || 'from-rx-dark to-rx-dark-secondary';
    row.color = app.color || '#FFD600';
    row.version = app.current_version || app.version || '1.0.0';
    row.releaseDate = app.release_date || app.created_at;
    row.lastUpdated = app.last_updated || app.updated_at || app.created_at;
    row.developer = app.developer || 'Calcitonin Technologies';
    row.status = app.status || 'active';
    row.category = app.category || 'healthcare';
    const sizes = await appSizesFor(env, [app.id]);
    return withSize(env, app.id, row, sizes[app.id] || {});
  },
  async reviews(request: Request, env: any) {
    const url = new URL(request.url);
    const slug = url.pathname.split('/').filter(Boolean)[1];
    const app: any = await env.DB.prepare(`SELECT id FROM applications WHERE slug = ?`).bind(slug).first();
    if (!app) return { error: 'Application not found' };
    if (request.method === 'POST') {
      // Live admin toggle: reviews can be paused from Admin → Settings
      if (await getSetting(env, 'reviews_open', '1') === '0') return { error: 'Reviews are temporarily disabled by the administrator.' };
      let body: any;
      try { body = await request.json(); } catch { return { error: 'Invalid JSON' }; }
      const { rating, comment } = body || {};
      if (!rating || rating < 1 || rating > 5) return { error: 'Rating 1-5 required' };
      const auth = request.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ')) return { error: 'Please sign in to review' };
      let uid: string | null = null;
      let uname = 'User';
      try {
        const payload = await verifyToken(auth.slice(7), env.JWT_SECRET);
        uid = payload.userId;
        const u: any = await env.DB.prepare('SELECT name FROM users WHERE id=?').bind(uid).first().catch(()=>null);
        if (u?.name) uname = u.name;
      } catch {}
      if (!uid) return { error: 'Invalid token' };
      const id = `rev_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      try {
        await env.DB.prepare(`INSERT INTO reviews (id, app_id, user_id, rating, comment, helpful_count) VALUES (?,?,?,?,?,0)`).bind(id, app.id, uid, rating, comment||'').run();
      } catch (e:any) {
        if (String(e.message).includes('UNIQUE')) {
          await env.DB.prepare(`UPDATE reviews SET rating=?, comment=?, updated_at=datetime('now') WHERE app_id=? AND user_id=?`).bind(rating, comment||'', app.id, uid).run();
        } else throw e;
      }
      const agg: any = await env.DB.prepare(`SELECT AVG(rating) as avg, COUNT(*) as cnt FROM reviews WHERE app_id=?`).bind(app.id).first().catch(()=>null);
      if (agg) await env.DB.prepare(`UPDATE applications SET rating=?, review_count=? WHERE id=?`).bind(agg.avg||0, agg.cnt||0, app.id).run().catch(()=>{});
      const created: any = await env.DB.prepare(`SELECT r.*, u.name as user_name FROM reviews r LEFT JOIN users u ON r.user_id=u.id WHERE r.id=?`).bind(id).first().catch(()=>({ id, rating, comment, user_name: uname }));
      return created || { id, rating, comment, user_name: uname };
    }
    const reviews: any = await env.DB.prepare(`SELECT r.*, u.name as user_name, u.avatar_url FROM reviews r LEFT JOIN users u ON r.user_id = u.id WHERE r.app_id = ? ORDER BY r.created_at DESC`).bind(app.id).all();
    return reviews.results || [];
  },
};
function tryParse(v: any, fallback: any) { if (!v) return fallback; if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch { return fallback; } }
