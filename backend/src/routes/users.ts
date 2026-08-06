/**
 * User Routes (Authenticated)
 * 
 * GET /users/me - Get current user profile
 * PATCH /users/me - Update profile
 * GET /users/me/apps - Installed apps
 * GET /users/me/subscriptions - Active subscriptions
 * GET /users/me/notifications - Notifications
 */

export const usersRoutes = {
  async getProfile(request: Request, env: any) {
    // request.user is set by auth middleware
    const userId = (request as any).user?.userId;
    const user = await env.DB.prepare(
      'SELECT id, name, email, avatar_url, role, preferences, created_at FROM users WHERE id = ?'
    ).bind(userId).first();
    return user;
  },

  async updateProfile(request: Request, env: any) {
    const userId = (request as any).user?.userId;
    const { name, avatar_url, preferences } = await request.json();
    
    await env.DB.prepare(
      'UPDATE users SET name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url), preferences = COALESCE(?, preferences), updated_at = NOW() WHERE id = ?'
    ).bind(name, avatar_url, JSON.stringify(preferences), userId).run();

    return { success: true };
  },

  async getNotifications(request: Request, env: any) {
    const userId = (request as any).user?.userId;
    const notifications = await env.DB.prepare(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    ).bind(userId).all();
    return notifications.results;
  },
};
