/**
 * Admin Routes — full management (D1: SQLite)
 * Requires admin role authentication (checked in Worker fetch).
 */

// Map package platform ids → the app.platforms ids the install modal checks
function platformDisplayId(p: string): string {
  if (p === 'linux_appimage' || p === 'flatpak') return 'linux';
  return p === 'linux_deb' ? 'linux' : p;
}

// Merge the platforms a release's packages provide into applications.platforms
// (the Install modal only enables platforms listed there)
async function mergeAppPlatforms(env: any, appId: string) {
  try {
    const row: any = await env.DB.prepare(`SELECT platforms FROM applications WHERE id=?`).bind(appId).first();
    let arr: string[] = [];
    try { arr = JSON.parse(row?.platforms || '[]'); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
    const pkgs: any = await env.DB.prepare(
      `SELECT DISTINCT p.platform FROM packages p JOIN releases r ON r.id=p.release_id WHERE p.application_id=? AND r.status='published'`
    ).bind(appId).all().catch(()=>({ results: [] }));
    const next = new Set(arr.length ? arr : ['web']);
    for (const p of pkgs.results || []) next.add(platformDisplayId(p.platform));
    if (!next.has('web')) next.add('web');
    await env.DB.prepare(`UPDATE applications SET platforms=? WHERE id=?`).bind(JSON.stringify([...next]), appId).run();
  } catch {}
}

// Mirror a release's packages into the legacy app_versions row — keeps /updates/check
// and old clients working with {url, size, checksum, fileName} per platform
async function syncLegacyAppVersion(env: any, appId: string, rel: any, origin: string) {
  try {
    const pkgs: any = await env.DB.prepare(`SELECT * FROM packages WHERE release_id=? AND status='published'`).bind(rel.id).all();
    const files: Record<string, any> = {};
    for (const p of pkgs.results || []) {
      const url = `${origin}/r2/${p.storage_key}`;
      const entry = { url, fileUrl: url, fileName: p.filename, size: p.file_size, checksum: p.sha256, sha256: p.sha256 };
      files[p.platform] = entry;
      if (p.platform === 'linux_deb') files['linux'] = entry; // legacy alias old clients request
    }
    const notes = typeof rel.release_notes === 'string' ? rel.release_notes : JSON.stringify(rel.release_notes || []);
    const existing: any = await env.DB.prepare(`SELECT id FROM app_versions WHERE app_id=? AND version=?`).bind(appId, rel.version).first().catch(()=>null);
    if (existing) {
      await env.DB.prepare(`UPDATE app_versions SET files=?, release_notes=?, created_at=datetime('now') WHERE id=?`).bind(JSON.stringify(files), notes, existing.id).run();
    } else {
      await env.DB.prepare(`INSERT INTO app_versions (id, app_id, version, release_notes, files) VALUES (?,?,?,?,?)`)
        .bind(`ver_${Date.now()}`, appId, rel.version, notes, JSON.stringify(files)).run();
    }
  } catch {}
}

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
    const clean = String(pwd||'').trim();
    if (clean !== 'iseedeAdpeople#233') return { error: 'Invalid reset password. Required: iseedeAdpeople#233' };
    await env.DB.prepare(`UPDATE applications SET download_count=0, review_count=0, rating=0`).run().catch(()=>{});
    await env.DB.prepare(`DELETE FROM downloads`).run().catch(()=>{});
    await env.DB.prepare(`DELETE FROM reviews`).run().catch(()=>{});
    await env.DB.prepare(`UPDATE applications SET rating=0`).run().catch(()=>{});
    return { success: true, message: 'All stats reset to 0 — brand new site ready' };
  },

  async resetApps(request: Request, env: any) {
    const body: any = await request.json().catch(()=>({}));
    const pwd = body?.password;
    if (String(pwd||'').trim() !== 'iseedeAdpeople#233') return { error: 'Invalid password' };
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
    // Handle duplicate version gracefully — update instead of failing
    const existing: any = await env.DB.prepare(`SELECT id FROM app_versions WHERE app_id=? AND version=?`).bind(app.id, version).first().catch(()=>null);
    if (existing) {
      await env.DB.prepare(`UPDATE app_versions SET release_notes=?, mandatory=?, files=?, created_at=datetime('now') WHERE app_id=? AND version=?`)
        .bind(JSON.stringify(releaseNotes||[]), mandatory?1:0, JSON.stringify(platforms||{}), app.id, version).run();
    } else {
      await env.DB.prepare(`INSERT INTO app_versions (id, app_id, version, release_notes, mandatory, files) VALUES (?,?,?,?,?,?)`)
        .bind(id, app.id, version, JSON.stringify(releaseNotes||[]), mandatory?1:0, JSON.stringify(platforms||{})).run();
    }
    // also update current_version
    await env.DB.prepare(`UPDATE applications SET current_version=?, last_updated=datetime('now') WHERE id=?`).bind(version, app.id).run();
    return { success: true, version, appId: appSlug };
  },

  // ===== PACKAGE UPLOAD (ties Uploads → Releases → Install together) =====
  // POST /admin/releases/:id/upload  (multipart: file, platform)
  // Stores binary in R2, computes sha256 server-side, writes packages row.
  async uploadPackage(request: Request, env: any) {
    const parts = new URL(request.url).pathname.split('/'); // /admin/releases/:id/upload
    const relId = parts[3] || '';
    const rel: any = await env.DB.prepare(`SELECT r.*, a.slug as app_slug FROM releases r JOIN applications a ON a.id=r.application_id WHERE r.id=?`).bind(relId).first();
    if (!rel) return { error: 'Release not found' };

    const form = await request.formData().catch(()=>null);
    if (!form) return { error: 'Expected multipart form-data (file, platform)' };
    const file: any = form.get('file');
    let platform = String(form.get('platform') || '').toLowerCase().trim();
    if (platform === 'linux' || platform === 'deb') platform = 'linux_deb';
    if (platform === 'appimage') platform = 'linux_appimage';
    const allowed = ['android','windows','linux','linux_deb','linux_appimage','macos','flatpak','web','ios'];
    if (!allowed.includes(platform)) return { error: `Invalid platform '${platform}'. Use: ${allowed.join(', ')}` };
    if (!file || typeof file.arrayBuffer !== 'function') return { error: 'No file attached' };

    const MAX = 95 * 1024 * 1024; // Worker memory budget
    if (file.size > MAX) return { error: `${file.name} is ${(file.size/1024/1024).toFixed(1)} MB — over the 95 MB per-file limit (large installers need R2 direct upload; split or host externally)` };

    const buf = await file.arrayBuffer();
    // sha256 in the Worker — publish + install verify this
    const digest: ArrayBuffer = await (crypto as any).subtle.digest('SHA-256', buf);
    const sha256 = Array.from(new Uint8Array(digest)).map((b:number)=>b.toString(16).padStart(2,'0')).join('');

    const safeName = String(file.name || 'package.bin').replace(/[^\w.\-]+/g, '_');
    const storageKey = `apps/${rel.app_slug}/${rel.version}/${platform}/${safeName}`;
    await env.STORAGE.put(storageKey, buf, { httpMetadata: { contentType: file.type || 'application/octet-stream' } });

    const origin = new URL(request.url).origin;
    const url = `${origin}/r2/${storageKey}`;
    const pkgType = platform === 'web' ? 'zip' : (platform === 'ios' ? 'pwa' : 'installer');
    const pkgStatus = rel.status === 'published' ? 'published' : 'stored';
    const id = `pkg_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    try {
      // UNIQUE(release_id, platform) in the new schema → upsert replaces that platform's binary
      await env.DB.prepare(
        `INSERT INTO packages (id, application_id, release_id, platform, architecture, filename, storage_key, file_size, mime_type, sha256, version, package_type, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(release_id, platform) DO UPDATE SET filename=excluded.filename, storage_key=excluded.storage_key, file_size=excluded.file_size, mime_type=excluded.mime_type, sha256=excluded.sha256, status=excluded.status, created_at=datetime('now')`
      ).bind(id, rel.application_id, relId, platform, 'x64', safeName, storageKey, file.size, file.type || 'application/octet-stream', sha256, rel.version, pkgType, pkgStatus).run();
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('CHECK') || msg.includes('constraint')) {
        return { error: `DB schema needs one-time migration for platform '${platform}' — run: npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0002_packages_platforms.sql` };
      }
      // Older schema without UNIQUE(release_id, platform) → manual upsert
      if (msg.includes('ON CONFLICT')) {
        const existing: any = await env.DB.prepare(`SELECT id FROM packages WHERE release_id=? AND platform=?`).bind(relId, platform).first().catch(()=>null);
        if (existing) {
          await env.DB.prepare(`UPDATE packages SET filename=?, storage_key=?, file_size=?, mime_type=?, sha256=?, status=?, created_at=datetime('now') WHERE id=?`).bind(safeName, storageKey, file.size, file.type || 'application/octet-stream', sha256, pkgStatus, existing.id).run();
        } else {
          await env.DB.prepare(`INSERT INTO packages (id, application_id, release_id, platform, architecture, filename, storage_key, file_size, mime_type, sha256, version, package_type, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, rel.application_id, relId, platform, 'x64', safeName, storageKey, file.size, file.type || 'application/octet-stream', sha256, rel.version, pkgType, pkgStatus).run();
        }
      } else return { error: msg.slice(0, 300) };
    }

    // Release already live → keep everything in sync immediately
    if (rel.status === 'published') {
      await mergeAppPlatforms(env, rel.application_id);
      await syncLegacyAppVersion(env, rel.application_id, rel, origin);
    }
    return { success: true, package: { id, platform, filename: safeName, size: file.size, sha256, url, version: rel.version, status: pkgStatus } };
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
    const SELECT_REL = `SELECT r.*, a.slug as app_slug, a.name as app_name,
      (SELECT COUNT(*) FROM packages p WHERE p.release_id=r.id) as package_count,
      (SELECT GROUP_CONCAT(p.platform) FROM packages p WHERE p.release_id=r.id) as package_platforms
      FROM releases r JOIN applications a ON a.id=r.application_id`;
    if (appSlug) {
      const app: any = await env.DB.prepare(`SELECT id FROM applications WHERE slug=?`).bind(appSlug).first();
      if (!app) return [];
      const rows: any = await env.DB.prepare(`${SELECT_REL} WHERE r.application_id=? ORDER BY r.created_at DESC`).bind(app.id).all();
      return rows.results || [];
    }
    const rows: any = await env.DB.prepare(`${SELECT_REL} ORDER BY r.created_at DESC LIMIT 50`).all();
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
    // Flip its packages live too — the install/download endpoint only serves published packages
    await env.DB.prepare(`UPDATE packages SET status='published' WHERE release_id=?`).bind(relId).run();
    // Set as latest stable if channel stable
    if (rel.channel === 'stable') {
      await env.DB.prepare(`UPDATE applications SET current_version=?, last_updated=datetime('now') WHERE id=?`).bind(rel.version, rel.application_id).run();
    }
    // Install modal reads applications.platforms; old clients read app_versions — keep both in sync
    await mergeAppPlatforms(env, rel.application_id);
    await syncLegacyAppVersion(env, rel.application_id, rel, new URL(request.url).origin);
    await env.DB.prepare(`INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?, ?, ?)`).bind(`log_${Date.now()}`, 'publish_release', 'release', relId, JSON.stringify({ version: rel.version })).run().catch(()=>{});
    return { success: true, id: relId, version: rel.version };
  },

  async rollbackRelease(request: Request, env: any) {
    const parts = new URL(request.url).pathname.split('/');
    const relId = parts[3] || parts[parts.length-2];
    const body: any = await request.json().catch(()=>({}));
    if (String(body?.password||'').trim() !== 'iseedeAdpeople#233') return { error: 'Invalid password for rollback' };
    const rel: any = await env.DB.prepare(`SELECT * FROM releases WHERE id=?`).bind(relId).first();
    if (!rel) return { error: 'Release not found' };
    // Find previous published version for same app
    const prev: any = await env.DB.prepare(`SELECT * FROM releases WHERE application_id=? AND status='published' AND id!=? ORDER BY published_at DESC LIMIT 1`).bind(rel.application_id, relId).first();
    if (!prev) return { error: 'No previous published release to rollback to' };
    await env.DB.prepare(`UPDATE releases SET status='rolled_back', updated_at=datetime('now') WHERE id=?`).bind(relId).run();
    // Its packages stop being served; previous release's packages stay live
    await env.DB.prepare(`UPDATE packages SET status='archived' WHERE release_id=?`).bind(relId).run().catch(()=>{});
    // Optionally set prev as latest
    await env.DB.prepare(`UPDATE applications SET current_version=? WHERE id=?`).bind(prev.version, rel.application_id).run();
    await syncLegacyAppVersion(env, rel.application_id, prev, new URL(request.url).origin);
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
    // Soft delete — move to recycle bin
    await env.DB.prepare(`UPDATE applications SET status='archived', deleted_at=datetime('now'), updated_at=datetime('now') WHERE slug=?`).bind(slug).run();
    await env.DB.prepare(`INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?, ?, ?)`).bind(`log_${Date.now()}`, 'soft_delete_app', 'application', slug, JSON.stringify({ slug })).run().catch(()=>{});
    return { success: true, slug, deleted: true };
  },

  async listDeleted(request: Request, env: any) {
    const apps: any = await env.DB.prepare(`SELECT * FROM applications WHERE deleted_at IS NOT NULL OR status='archived' ORDER BY deleted_at DESC LIMIT 50`).all().catch(()=>({results:[]}));
    const rels: any = await env.DB.prepare(`SELECT r.*, a.slug as app_slug FROM releases WHERE r.deleted_at IS NOT NULL OR r.status='archived' ORDER BY deleted_at DESC LIMIT 50`).all().catch(()=>({results:[]}));
    return { apps: apps.results || [], releases: rels.results || [] };
  },

  async restoreApp(request: Request, env: any) {
    const slug = new URL(request.url).pathname.split('/')[3];
    await env.DB.prepare(`UPDATE applications SET status='active', deleted_at=NULL, updated_at=datetime('now') WHERE slug=?`).bind(slug).run();
    return { success: true, slug, restored: true };
  },

  async createApp(request: Request, env: any) {
    const data: any = await request.json();
    const id = `app_${Date.now()}`;
    let slug = data.slug || data.name?.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'') || id;
    // Ensure slug is unique
    const exists: any = await env.DB.prepare(`SELECT id FROM applications WHERE slug=?`).bind(slug).first().catch(()=>null);
    if (exists) slug = `${slug}-${Date.now().toString().slice(-4)}`;
    await env.DB.prepare(`INSERT INTO applications (id, slug, name, description, category, developer, icon, status, current_version, price_type, platforms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, slug, data.name||'New App', data.description||'', data.category||'healthcare', data.developer||'Calcitonin Technologies', data.icon||'📦', data.status||'active', data.version||'1.0.0', data.price_type||'free', JSON.stringify(data.platforms||['web'])).run();
    const app: any = await env.DB.prepare(`SELECT * FROM applications WHERE slug=?`).bind(slug).first();
    return app;
  },
};
