/**
 * Applications Routes — D1 (SQLite) compatible
 */
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
    const normalized = apps.map((a:any)=> ({ ...a, platforms: tryParse(a.platforms, []), tags: tryParse(a.tags, []), downloadCount: a.download_count, reviewCount: a.review_count, priceAmount: a.price_amount, price: a.price_type || a.price }));
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
    row.size = app.size || (app.size_mb ? `${app.size_mb} MB` : '—');
    row.version = app.current_version || app.version || '1.0.0';
    row.releaseDate = app.release_date || app.created_at;
    row.lastUpdated = app.last_updated || app.updated_at || app.created_at;
    row.developer = app.developer || 'Calcitonin Technologies';
    row.status = app.status || 'active';
    row.category = app.category || 'healthcare';
    return row;
  },
  async reviews(request: Request, env: any) {
    const url = new URL(request.url);
    const slug = url.pathname.split('/').filter(Boolean)[1];
    const app: any = await env.DB.prepare(`SELECT id FROM applications WHERE slug = ?`).bind(slug).first();
    if (!app) return { error: 'Application not found' };
    const reviews: any = await env.DB.prepare(`SELECT r.*, u.name as user_name, u.avatar_url FROM reviews r LEFT JOIN users u ON r.user_id = u.id WHERE r.app_id = ? ORDER BY r.created_at DESC`).bind(app.id).all();
    return reviews.results || [];
  },
};
function tryParse(v: any, fallback: any) { if (!v) return fallback; if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch { return fallback; } }
