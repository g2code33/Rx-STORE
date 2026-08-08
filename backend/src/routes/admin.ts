/**
 * Admin Routes — full management (D1: SQLite)
 * Requires admin role authentication (checked in Worker fetch).
 */

export const adminRoutes = {
  async dashboard(request: Request, env: any) {
    const [apps, users, payments, rating] = await Promise.all([
      env.DB.prepare(`SELECT SUM(download_count) as total FROM applications`).first(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM users`).first(),
      env.DB.prepare(`SELECT SUM(amount) as total FROM payments WHERE status='completed'`).first(),
      env.DB.prepare(`SELECT AVG(rating) as avg FROM applications WHERE review_count>0`).first(),
    ]);
    return {
      totalDownloads: (apps as any)?.total || 0,
      totalUsers: (users as any)?.count || 0,
      monthlyRevenue: (payments as any)?.total || 0,
      averageRating: (rating as any)?.avg || 0,
    };
  },

  async listUsers(request: Request, env: any) {
    const users = await env.DB.prepare(`SELECT id, name, email, role, created_at, last_login_at FROM users ORDER BY created_at DESC LIMIT 100`).all();
    return users.results || [];
  },

  async updateUserRole(request: Request, env: any) {
    const url = new URL(request.url);
    const id = url.pathname.split('/').slice(-2, -1)[0] || url.pathname.split('/').pop();
    // PATCH /admin/users/:id/role  {role}
    const { role } = await request.json().catch(()=>({})) as any;
    if (!['user','developer','admin'].includes(role)) return { error: 'Invalid role' };
    // extract id from /admin/users/:id/role
    const parts = url.pathname.split('/');
    const userId = parts[parts.length - 2];
    await env.DB.prepare(`UPDATE users SET role=?, updated_at=datetime('now') WHERE id=?`).bind(role, userId).run();
    return { success: true, id: userId, role };
  },

  async revenue(request: Request, env: any) {
    const total = await env.DB.prepare(`SELECT SUM(amount) as total, COUNT(*) as count FROM payments WHERE status='completed'`).first() as any;
    const byApp = await env.DB.prepare(`SELECT a.name as name, SUM(p.amount) as revenue FROM payments p JOIN applications a ON a.id=p.subscription_id GROUP BY a.name LIMIT 5`).all().catch(()=>({results:[]})) as any;
    const hasRevenue = !!(total?.total && Number(total.total) > 0);
    return {
      monthlyRevenue: hasRevenue ? total.total : 0,
      mrr: hasRevenue ? Math.round(Number(total.total) * 0.26) : 0,
      activeSubs: total?.count || 0,
      byApp: (byApp.results && byApp.results.length && hasRevenue) ? byApp.results.map((r:any)=>({name:r.name, revenue: r.revenue, growth:'+18%'})) : [],
      payments: hasRevenue ? await env.DB.prepare(`SELECT p.id, u.name as user, p.amount, p.provider, p.status, date(p.created_at) as date FROM payments p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 5`).all().then((r:any)=>r.results).catch(()=>[]) as any : [],
    };
  },

  async resetStats(request: Request, env: any) {
    const body: any = await request.json().catch(()=>({}));
    const pwd = body?.password || new URL(request.url).searchParams.get('password');
    if (pwd !== 'iseedeAdpeople#233') return { error: 'Invalid reset password. Required: iseedeAdpeople#233' };
    await env.DB.prepare(`UPDATE applications SET download_count=0, review_count=0, rating=0`).run().catch(()=>{});
    await env.DB.prepare(`DELETE FROM downloads`).run().catch(()=>{});
    await env.DB.prepare(`DELETE FROM reviews`).run().catch(()=>{});
    await env.DB.prepare(`UPDATE applications SET rating=0`).run().catch(()=>{});
    return { success: true, message: 'All stats reset to 0 — brand new site ready' };
  },

  async resetApps(request: Request, env: any) {
    const body: any = await request.json().catch(()=>({}));
    const pwd = body?.password;
    if (pwd !== 'iseedeAdpeople#233') return { error: 'Invalid password' };
    await env.DB.prepare(`DELETE FROM applications`).run().catch(()=>{});
    await env.DB.prepare(`DELETE FROM app_versions`).run().catch(()=>{});
    await env.DB.prepare(`DELETE FROM versions`).run().catch(()=>{});
    return { success: true, message: 'All apps cleared' };
  },

  async createRelease(request: Request, env: any) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/');
    const appSlug = parts[3]; // /admin/apps/:slug/releases
    const { version, releaseNotes, platforms, mandatory } = await request.json().catch(()=>({})) as any;
    if (!version) return { error: 'version required' };
    const app = await env.DB.prepare(`SELECT id FROM applications WHERE slug=?`).bind(appSlug).first() as any;
    if (!app) return { error: 'Application not found' };
    const id = `ver_${Date.now()}`;
    await env.DB.prepare(`INSERT INTO app_versions (id, app_id, version, release_notes, mandatory, files) VALUES (?,?,?,?,?,?)`)
      .bind(id, app.id, version, JSON.stringify(releaseNotes||[]), mandatory?1:0, JSON.stringify(platforms||{})).run();
    // also update current_version
    await env.DB.prepare(`UPDATE applications SET current_version=?, last_updated=datetime('now') WHERE id=?`).bind(version, app.id).run();
    return { success: true, version, appId: appSlug };
  },

  // ===== NEW RELEASE MANAGEMENT (Production) =====
  async createNewRelease(request: Request, env: any) {
    const body: any = await request.json().catch(()=>({}));
    const { application_id, slug, version, release_notes, releaseNotes, release_type, releaseType, channel, minimum_supported_version, minimumSupportedVersion } = body || {};
    const appSlug = slug || application_id;
    if (!appSlug || !version) return { error: 'application slug and version required' };
    const app: any = await env.DB.prepare(`SELECT id FROM applications WHERE slug=?`).bind(appSlug).first();
    if (!app) return { error: 'Application not found' };
    const existing = await env.DB.prepare(`SELECT id FROM releases WHERE application_id=? AND version=?`).bind(app.id, version).first();
    if (existing) return { error: 'Version already exists for this app' };
    const id = `rel_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    const notes = release_notes || releaseNotes || [];
    const rType = release_type || releaseType || 'patch';
    const ch = channel || 'stable';
    const minVer = minimum_supported_version || minimumSupportedVersion || null;
    await env.DB.prepare(`INSERT INTO releases (id, application_id, version, release_notes, release_type, channel, minimum_supported_version, status) VALUES (?,?,?,?,?,?,?, 'draft')`)
      .bind(id, app.id, version, JSON.stringify(notes), rType, ch, minVer).run();
    await env.DB.prepare(`INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?, ?, ?)`).bind(`log_${Date.now()}`, 'create_release', 'release', id, JSON.stringify({ app: appSlug, version })).run().catch(()=>{});
    const rel: any = await env.DB.prepare(`SELECT * FROM releases WHERE id=?`).bind(id).first();
    return rel;
  },

  async listReleases(request: Request, env: any) {
    const url = new URL(request.url);
    const appSlug = url.searchParams.get('app') || url.searchParams.get('application');
    if (appSlug) {
      const app: any = await env.DB.prepare(`SELECT id FROM applications WHERE slug=?`).bind(appSlug).first();
      if (!app) return [];
      const rows: any = await env.DB.prepare(`SELECT r.*, a.slug as app_slug, a.name as app_name FROM releases r JOIN applications a ON a.id=r.application_id WHERE r.application_id=? ORDER BY r.created_at DESC`).bind(app.id).all();
      return rows.results || [];
    }
    const rows: any = await env.DB.prepare(`SELECT r.*, a.slug as app_slug, a.name as app_name FROM releases r JOIN applications a ON a.id=r.application_id ORDER BY r.created_at DESC LIMIT 50`).all();
    return rows.results || [];
  },

  async getRelease(request: Request, env: any) {
    const id = new URL(request.url).pathname.split('/').pop() || '';
    const rel: any = await env.DB.prepare(`SELECT r.*, a.slug as app_slug, a.name as app_name FROM releases r JOIN applications a ON a.id=r.application_id WHERE r.id=?`).bind(id).first();
    if (!rel) return { error: 'Release not found' };
    const pkgs: any = await env.DB.prepare(`SELECT * FROM packages WHERE release_id=?`).all().catch(()=>({results:[]}));
    return { ...rel, packages: pkgs.results || [] };
  },

  async publishRelease(request: Request, env: any) {
    const id = new URL(request.url).pathname.split('/')[3] || new URL(request.url).pathname.split('/').pop() || '';
    // URL is /admin/releases/:id/publish -> id is 3rd segment
    const parts = new URL(request.url).pathname.split('/');
    const relId = parts[3] || parts[parts.length-2];
    const rel: any = await env.DB.prepare(`SELECT * FROM releases WHERE id=?`).bind(relId).first();
    if (!rel) return { error: 'Release not found' };
    if (rel.status === 'published') return { error: 'Already published' };
    // Verify packages exist and have sha256 and R2 file
    const pkgs: any = await env.DB.prepare(`SELECT * FROM packages WHERE release_id=?`).bind(relId).all();
    if (!pkgs.results || pkgs.results.length===0) return { error: 'No packages uploaded for this release. Upload at least one platform.' };
    for (const p of pkgs.results) {
      if (!p.sha256 || !p.storage_key) return { error: `Package ${p.platform} missing checksum or storage` };
      // Verify R2 file exists
      const obj = await env.STORAGE.head(p.storage_key).catch(()=>null);
      if (!obj) return { error: `R2 file missing for ${p.platform}: ${p.storage_key}` };
    }
    await env.DB.prepare(`UPDATE releases SET status='published', published_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).bind(relId).run();
    // Set as latest stable if channel stable
    if (rel.channel === 'stable') {
      await env.DB.prepare(`UPDATE applications SET current_version=?, last_updated=datetime('now') WHERE id=?`).bind(rel.version, rel.application_id).run();
    }
    await env.DB.prepare(`INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?, ?, ?)`).bind(`log_${Date.now()}`, 'publish_release', 'release', relId, JSON.stringify({ version: rel.version })).run().catch(()=>{});
    return { success: true, id: relId, version: rel.version };
  },

  async rollbackRelease(request: Request, env: any) {
    const parts = new URL(request.url).pathname.split('/');
    const relId = parts[3] || parts[parts.length-2];
    const body: any = await request.json().catch(()=>({}));
    if (body?.password !== 'iseedeAdpeople#233') return { error: 'Invalid password for rollback' };
    const rel: any = await env.DB.prepare(`SELECT * FROM releases WHERE id=?`).bind(relId).first();
    if (!rel) return { error: 'Release not found' };
    // Find previous published version for same app
    const prev: any = await env.DB.prepare(`SELECT * FROM releases WHERE application_id=? AND status='published' AND id!=? ORDER BY published_at DESC LIMIT 1`).bind(rel.application_id, relId).first();
    if (!prev) return { error: 'No previous published release to rollback to' };
    await env.DB.prepare(`UPDATE releases SET status='rolled_back', updated_at=datetime('now') WHERE id=?`).bind(relId).run();
    // Optionally set prev as latest
    await env.DB.prepare(`UPDATE applications SET current_version=? WHERE id=?`).bind(prev.version, rel.application_id).run();
    await env.DB.prepare(`INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?, ?, ?)`).bind(`log_${Date.now()}`, 'rollback_release', 'release', relId, JSON.stringify({ from: rel.version, to: prev.version })).run().catch(()=>{});
    return { success: true, rolledBack: rel.version, now: prev.version };
  },

  async updateReleaseStatus(request: Request, env: any) {
    const parts = new URL(request.url).pathname.split('/');
    const relId = parts[3];
    const { status } = await request.json().catch(()=>({})) as any;
    const allowed = ['draft','disabled','archived'];
    if (!allowed.includes(status)) return { error: 'Invalid status' };
    await env.DB.prepare(`UPDATE releases SET status=?, updated_at=datetime('now') WHERE id=?`).bind(status, relId).run();
    return { success: true, id: relId, status };
  },

  async updateApp(request: Request, env: any) {
    const url = new URL(request.url);
    const slug = url.pathname.split('/')[3];
    const body: any = await request.json().catch(()=>({}));
    const app: any = await env.DB.prepare(`SELECT id FROM applications WHERE slug=?`).bind(slug).first();
    if (!app) return { error: 'Application not found' };
    const fields = ['name','description','long_description','category','tags','developer','icon','color','gradient','screenshots','status','current_version','size_mb','rating','price_type','price_amount','platforms','is_featured','is_new','is_trending','release_date','last_updated'];
    const sets: string[] = [];
    const binds: any[] = [];
    for (const f of fields) {
      if (body[f] !== undefined) {
        let v: any = body[f];
        if (['tags','platforms','screenshots'].includes(f) && Array.isArray(v)) v = JSON.stringify(v);
        if (['release_notes','features'].includes(f) && Array.isArray(v)) v = JSON.stringify(v);
        sets.push(`${f} = ?`);
        binds.push(v);
      }
    }
    // also support camelCase from frontend
    const map: any = { longDescription:'long_description', currentVersion:'current_version', sizeMb:'size_mb', priceType:'price_type', priceAmount:'price_amount', isFeatured:'is_featured', isNew:'is_new', isTrending:'is_trending', releaseDate:'release_date', lastUpdated:'last_updated' };
    for (const k in map) {
      if (body[k] !== undefined) {
        sets.push(`${map[k]} = ?`);
        let v = body[k];
        if (Array.isArray(v)) v = JSON.stringify(v);
        binds.push(v);
      }
    }
    if (sets.length===0) return { error: 'No fields to update' };
    sets.push(`updated_at = datetime('now')`);
    binds.push(slug);
    await env.DB.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE slug = ?`).bind(...binds).run();
    const updated: any = await env.DB.prepare(`SELECT * FROM applications WHERE slug=?`).bind(slug).first();
    return updated;
  },

  async deleteApp(request: Request, env: any) {
    const slug = new URL(request.url).pathname.split('/')[3];
    await env.DB.prepare(`DELETE FROM applications WHERE slug=?`).bind(slug).run();
    return { success: true, slug };
  },

  async createApp(request: Request, env: any) {
    const data: any = await request.json();
    const id = `app_${Date.now()}`;
    const slug = data.slug || data.name?.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'') || id;
    await env.DB.prepare(`INSERT INTO applications (id, slug, name, description, category, developer, icon, status, current_version, price_type, platforms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, slug, data.name||'New App', data.description||'', data.category||'healthcare', data.developer||'Calcitonin Technologies', data.icon||'📦', data.status||'active', data.version||'1.0.0', data.price_type||'free', JSON.stringify(data.platforms||['web'])).run();
    const app: any = await env.DB.prepare(`SELECT * FROM applications WHERE slug=?`).bind(slug).first();
    return app;
  },
};
