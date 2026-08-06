/**
 * Admin Routes
 * Requires admin role authentication.
 */

export const adminRoutes = {
  async dashboard(request: Request, env: any) {
    const stats = await Promise.all([
      env.DB.prepare('SELECT SUM(download_count) as total FROM apps').first(),
      env.DB.prepare('SELECT COUNT(*) as count FROM users').first(),
      env.DB.prepare('SELECT SUM(amount) as total FROM payments WHERE status = ? AND created_at > date_trunc(\'month\', NOW())').bind('completed').first(),
      env.DB.prepare('SELECT AVG(rating) as avg FROM apps WHERE review_count > 0').first(),
    ]);

    return {
      totalDownloads: stats[0]?.total || 0,
      totalUsers: stats[1]?.count || 0,
      monthlyRevenue: stats[2]?.total || 0,
      averageRating: stats[3]?.avg || 0,
    };
  },

  async createApp(request: Request, env: any) {
    const data = await request.json();
    const app = await env.DB.prepare(
      'INSERT INTO apps (slug, name, description, category, developer_id) VALUES (?, ?, ?, ?, ?) RETURNING *'
    ).bind(data.slug, data.name, data.description, data.category, data.developerId).first();
    return app;
  },

  async listUsers(request: Request, env: any) {
    const users = await env.DB.prepare(
      'SELECT id, name, email, role, created_at, last_login_at FROM users ORDER BY created_at DESC LIMIT 100'
    ).all();
    return users.results;
  },
};
