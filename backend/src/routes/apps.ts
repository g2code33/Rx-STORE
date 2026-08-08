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
    const normalized = apps.map((a:any)=> ({ ...a, platforms: tryParse(a.platforms, []), tags: tryParse(a.tags, []), screenshots: tryParse(a.screenshots, []), features: tryParse(a.features, []), releaseNotes: tryParse(a.release_notes, []), version: a.current_version || a.version || '1.0.0', downloadCount: a.download_count, reviewCount: a.review_count, priceAmount: a.price_amount, price: a.price_type || a.price }));
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
    if (request.method === 'POST') {
      let body: any;
      try { body = await request.json(); } catch { return { error: 'Invalid JSON' }; }
      const { rating, comment } = body || {};
      if (!rating || rating < 1 || rating > 5) return { error: 'Rating 1-5 required' };
      const auth = request.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ')) return { error: 'Please sign in to review' };
      let uid: string | null = null;
      let uname = 'User';
      try {
        const payload = JSON.parse(atob(auth.slice(7).split('.')[1]||''));
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
