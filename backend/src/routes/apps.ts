/**
 * Applications Routes
 * 
 * GET /apps - List applications (with filters)
 * GET /apps/:slug - Get app details
 * GET /apps/:slug/reviews - Get app reviews
 * GET /apps/:slug/releases - Get version history
 * GET /categories - List categories
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

    let query = 'SELECT * FROM apps WHERE status = \'active\'';
    const bindings: any[] = [];

    if (category) {
      query += ' AND category = ?';
      bindings.push(category);
    }
    if (platform) {
      query += ' AND ? = ANY(platforms)';
      bindings.push(platform);
    }
    if (search) {
      query += ' AND (name ILIKE ? OR description ILIKE ?)';
      bindings.push(`%${search}%`, `%${search}%`);
    }

    switch (sort) {
      case 'rating': query += ' ORDER BY rating DESC'; break;
      case 'newest': query += ' ORDER BY release_date DESC'; break;
      case 'name': query += ' ORDER BY name ASC'; break;
      default: query += ' ORDER BY download_count DESC';
    }

    query += ' LIMIT ? OFFSET ?';
    bindings.push(limit, (page - 1) * limit);

    const apps = await env.DB.prepare(query).bind(...bindings).all();
    return { apps: apps.results, pagination: { page, limit, total: apps.results.length } };
  },

  async detail(request: Request, env: any) {
    const url = new URL(request.url);
    const slug = url.pathname.split('/').pop();
    
    const app = await env.DB.prepare('SELECT * FROM apps WHERE slug = ?').bind(slug).first();
    if (!app) return { error: 'Application not found' };
    return app;
  },

  async reviews(request: Request, env: any) {
    const url = new URL(request.url);
    const slug = url.pathname.split('/')[2];
    
    const app = await env.DB.prepare('SELECT id FROM apps WHERE slug = ?').bind(slug).first();
    if (!app) return { error: 'Application not found' };

    const reviews = await env.DB.prepare(
      'SELECT r.*, u.name as user_name, u.avatar_url FROM reviews r JOIN users u ON r.user_id = u.id WHERE r.app_id = ? ORDER BY r.created_at DESC'
    ).bind(app.id).all();

    return reviews.results;
  },
};
