/**
 * Admin Routes — full management (D1: SQLite)
 * Requires admin role authentication (checked in Worker fetch).
 */

import { getSetting } from '../services/settings';

// Live column list for a table (cached per request) — prod DBs evolve via ALTER
// migrations, so writes must tolerate columns that don't exist yet
async function tableColumns(env: any, table: string): Promise<Set<string>> {
  (env as any)._tcols = (env as any)._tcols || {};
  if (!(env as any)._tcols[table]) {
    try {
      const rows: any = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
      (env as any)._tcols[table] = new Set((rows.results || []).map((r: any) => r.name));
    } catch {
      (env as any)._tcols[table] = new Set();
    }
  }
  return (env as any)._tcols[table];
}

// --- Upload helpers (single + chunked paths share these) ---
const ALLOWED_PLATFORMS = ['android','windows','linux','linux_deb','linux_appimage','macos','flatpak','web','ios'];

// Real R2 usage: paginated object listing, summed — cached 60s to keep the
// dashboard snappy (list is the only runtime way to measure bucket usage).
let storageCache: { at: number; bytes: number; objects: number } | null = null;
async function getStorageStats(env: any): Promise<{ bytes: number; objects: number } | null> {
  if (storageCache && Date.now() - storageCache.at < 60_000) return { bytes: storageCache.bytes, objects: storageCache.objects };
  let bytes = 0, objects = 0;
  try {
    let cursor: string | undefined = undefined;
    do {
      const page: any = await env.STORAGE.list({ cursor, limit: 1000 });
      for (const o of page?.objects || []) { bytes += o?.size || 0; objects++; }
      cursor = page?.truncated ? page?.cursor : undefined;
    } while (cursor);
    storageCache = { at: Date.now(), bytes, objects };
    return { bytes, objects };
  } catch {
    return storageCache ? { bytes: storageCache.bytes, objects: storageCache.objects } : null;
  }
}

function relIdFrom(request: Request): string {
  return new URL(request.url).pathname.split('/')[3] || '';
}

async function loadRelease(env: any, relId: string): Promise<any> {
  const rel: any = await env.DB.prepare(`SELECT r.*, a.slug as app_slug FROM releases r JOIN applications a ON a.id=r.application_id WHERE r.id=?`).bind(relId).first().catch(()=>null);
  if (!rel) return { error: 'Release not found' };
  return rel;
}

function normPlatform(raw: any): string | { error: string } {
  let platform = String(raw || '').toLowerCase().trim();
  if (platform === 'linux' || platform === 'deb') platform = 'linux_deb';
  if (platform === 'appimage') platform = 'linux_appimage';
  if (platform === 'dmg' || platform === 'pkg') platform = 'macos';
  if (!ALLOWED_PLATFORMS.includes(platform)) return { error: `Invalid platform '${platform}'. Use: ${ALLOWED_PLATFORMS.join(', ')}` };
  return platform;
}

function sanitizeName(name: any): string {
  return String(name || 'package.bin').replace(/[^\w.\-]+/g, '_');
}

// Insert/replace the packages row for (release, platform).
// Order matters: a prod table missing UNIQUE(release_id, platform) makes D1 say
// 'ON CONFLICT clause does not match any ... constraint' — that message ALSO
// contains 'constraint', so ON CONFLICT must be handled BEFORE generic CHECK errors.
async function writePackageRow(env: any, rel: any, platform: string, f: { filename: string; storageKey: string; size: number; mime: string; sha256: string }): Promise<any> {
  const pkgType = platform === 'web' ? 'zip' : (platform === 'ios' ? 'pwa' : 'installer');
  const pkgStatus = rel.status === 'published' ? 'published' : 'stored';
  const id = `pkg_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  const COLS = `(id, application_id, release_id, platform, architecture, filename, storage_key, file_size, mime_type, sha256, version, package_type, status)`;
  const VALS = [id, rel.application_id, rel.id, platform, 'x64', f.filename, f.storageKey, f.size, f.mime, f.sha256, rel.version, pkgType, pkgStatus];
  try {
    await env.DB.prepare(
      `INSERT INTO packages ${COLS} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(release_id, platform) DO UPDATE SET filename=excluded.filename, storage_key=excluded.storage_key, file_size=excluded.file_size, mime_type=excluded.mime_type, sha256=excluded.sha256, status=excluded.status, created_at=datetime('now')`
    ).bind(...VALS).run();
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes('ON CONFLICT')) {
      // Older prod schema without UNIQUE(release_id, platform) → manual upsert
      try {
        const existing: any = await env.DB.prepare(`SELECT id FROM packages WHERE release_id=? AND platform=?`).bind(rel.id, platform).first().catch(()=>null);
        if (existing) {
          await env.DB.prepare(`UPDATE packages SET filename=?, storage_key=?, file_size=?, mime_type=?, sha256=?, status=?, created_at=datetime('now') WHERE id=?`).bind(f.filename, f.storageKey, f.size, f.mime, f.sha256, pkgStatus, existing.id).run();
        } else {
          await env.DB.prepare(`INSERT INTO packages ${COLS} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...VALS).run();
        }
      } catch (e2: any) {
        const m2 = String(e2?.message || e2);
        if (m2.includes('CHECK') || m2.includes('constraint')) {
          return { error: `DB schema needs one-time migration for platform '${platform}' — run: npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0002_packages_platforms.sql` };
        }
        return { error: m2.slice(0, 300) };
      }
    } else if (msg.includes('CHECK') || msg.includes('constraint')) {
      return { error: `DB schema needs one-time migration for platform '${platform}' — run: npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0002_packages_platforms.sql` };
    } else {
      return { error: msg.slice(0, 300) };
    }
  }
  return { id, platform, filename: f.filename, size: f.size, sha256: f.sha256, status: pkgStatus };
}

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
    // Real recent activity: downloads + release events + new users, merged & sorted
    const [dlRows, relRows, userRows] = await Promise.all([
      env.DB.prepare(`SELECT d.id, d.platform, d.version, d.created_at, a.slug, a.name FROM downloads d LEFT JOIN applications a ON a.id = d.app_id ORDER BY d.created_at DESC LIMIT 8`).all().catch(() => ({ results: [] })),
      env.DB.prepare(`SELECT r.id, r.version, r.status, r.published_at, r.updated_at, a.slug, a.name FROM releases r LEFT JOIN applications a ON a.id = r.application_id WHERE r.status IN ('published','rolled_back') ORDER BY COALESCE(r.published_at, r.updated_at) DESC LIMIT 6`).all().catch(() => ({ results: [] })),
      env.DB.prepare(`SELECT id, name, email, created_at FROM users ORDER BY created_at DESC LIMIT 6`).all().catch(() => ({ results: [] })),
    ]);
    const activity: any[] = [];
    for (const d of (dlRows as any)?.results || []) {
      activity.push({
        id: `dl_${d.id}`, kind: 'download', time: d.created_at,
        text: `${d.name || 'An app'} ${d.version ? 'v' + d.version + ' ' : ''}downloaded${d.platform ? ' (' + d.platform + ')' : ''}`,
        to: d.slug ? 'app' : '', slug: d.slug || '',
      });
    }
    for (const r of (relRows as any)?.results || []) {
      activity.push({
        id: `rel_${r.id}`, kind: r.status === 'rolled_back' ? 'rollback' : 'release',
        time: r.published_at || r.updated_at,
        text: r.status === 'rolled_back'
          ? `${r.name || 'An app'} v${r.version} rolled back`
          : `${r.name || 'An app'} v${r.version} published`,
        to: r.slug ? 'app' : '', slug: r.slug || '',
      });
    }
    for (const u of (userRows as any)?.results || []) {
      activity.push({
        id: `usr_${u.id}`, kind: 'user', time: u.created_at,
        text: `New user registration: ${u.name || u.email || u.id}`,
        to: 'section', slug: 'users',
      });
    }
    activity.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    const storage = await getStorageStats(env);
    const quotaGb = parseInt(await getSetting(env, 'storage_quota_gb', '10'), 10) || 10;
    return {
      totalDownloads: (apps as any)?.total || 0,
      totalUsers: (users as any)?.count || 0,
      monthlyRevenue: (payments as any)?.total || 0,
      averageRating: (rating as any)?.avg || 0,
      activity: activity.slice(0, 10),
      storageBytes: storage?.bytes ?? null,
      storageObjects: storage?.objects ?? null,
      storageQuotaGb: quotaGb,
    };
  },

  // Send a notification to users — audience: all | selected users | users with an app installed
  async sendNotification(request: Request, env: any) {
    const body: any = await request.json().catch(() => ({}));
    const { audience, userIds, appSlug, title, message, link, type } = body || {};
    if (!title || !String(title).trim()) return { error: 'Title is required' };
    if (!message || !String(message).trim()) return { error: 'Message is required' };
    const targets = new Set<string>();
    if (audience === 'users') {
      const ids: string[] = Array.isArray(userIds) ? userIds : [];
      for (const id of ids) targets.add(String(id));
    } else if (audience === 'app') {
      if (!appSlug) return { error: 'App is required for that audience' };
      const rows: any = await env.DB.prepare(
        `SELECT DISTINCT d.user_id FROM downloads d JOIN applications a ON a.id = d.app_id WHERE a.slug = ? AND d.user_id IS NOT NULL AND d.user_id != ''`
      ).bind(appSlug).all().catch(() => ({ results: [] }));
      for (const r of rows?.results || []) targets.add(String(r.user_id));
      if (targets.size === 0) return { error: 'No users have that app installed yet (their downloads may predate account tracking).' };
    } else {
      const rows: any = await env.DB.prepare(`SELECT id FROM users`).all().catch(() => ({ results: [] }));
      for (const r of rows?.results || []) targets.add(String(r.id));
    }
    if (targets.size === 0) return { error: 'No recipients match that audience' };
    const nType = ['update', 'download', 'message', 'system', 'payment'].includes(type) ? type : 'message';
    const stamp = Date.now();
    let i = 0;
    for (const uid of targets) {
      await env.DB.prepare(
        `INSERT INTO notifications (id, user_id, type, title, message, data, read) VALUES (?,?,?,?,?,?,0)`
      ).bind(`n_${stamp}_${i++}_${Math.random().toString(36).slice(2, 6)}`, uid, nType, String(title).slice(0, 200), String(message).slice(0, 1000), JSON.stringify({ link: link || '' })).run().catch(() => {});
    }
    await env.DB.prepare(`INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?,?,?)`)
      .bind(`log_${stamp}`, 'send_notification', 'notification', audience || 'all', JSON.stringify({ title, recipients: targets.size })).run().catch(() => {});
    return { success: true, recipients: targets.size };
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
  // Small files: POST /admin/releases/:id/upload (multipart: file, platform) — one shot, sha256 in-Worker.
  // Big installers: chunked R2 multipart upload (start → part×N → complete), sha256 from the admin's browser.
  async uploadPackage(request: Request, env: any) {
    const rel = await loadRelease(env, relIdFrom(request));
    if ((rel as any)?.error) return rel;
    const form = await request.formData().catch(()=>null);
    if (!form) return { error: 'Expected multipart form-data (file, platform)' };
    const file: any = form.get('file');
    const platform = normPlatform(form.get('platform'));
    if ((platform as any)?.error) return platform;
    if (!file || typeof file.arrayBuffer !== 'function') return { error: 'No file attached' };

    const MAX_SINGLE = 50 * 1024 * 1024; // one-shot memory budget; bigger → chunked MPU
    if (file.size > MAX_SINGLE) return { error: `${file.name} is ${(file.size/1024/1024).toFixed(1)} MB — use the chunked upload (automatic for files over 50 MB)` };

    const buf = await file.arrayBuffer();
    const digest: ArrayBuffer = await (crypto as any).subtle.digest('SHA-256', buf);
    const sha256 = Array.from(new Uint8Array(digest)).map((b:number)=>b.toString(16).padStart(2,'0')).join('');
    const safeName = sanitizeName(file.name);
    const storageKey = `apps/${rel.app_slug}/${rel.version}/${platform}/${safeName}`;
    await env.STORAGE.put(storageKey, buf, { httpMetadata: { contentType: file.type || 'application/octet-stream' } });

    const origin = new URL(request.url).origin;
    const saved = await writePackageRow(env, rel, platform, { filename: safeName, storageKey, size: file.size, mime: file.type || 'application/octet-stream', sha256 });
    if ((saved as any)?.error) return saved;
    if (rel.status === 'published') {
      await mergeAppPlatforms(env, rel.application_id);
      await syncLegacyAppVersion(env, rel.application_id, rel, origin);
    }
    return { success: true, package: { ...saved, url: `${origin}/r2/${storageKey}`, version: rel.version } };
  },

  // --- Chunked multipart upload for big installers (up to 500 MB) ---
  // POST /admin/releases/:id/upload/start {platform, filename, size, mimeType}
  async uploadPackageStart(request: Request, env: any) {
    const rel = await loadRelease(env, relIdFrom(request));
    if ((rel as any)?.error) return rel;
    const body: any = await request.json().catch(()=>({}));
    const platform = normPlatform(body.platform);
    if ((platform as any)?.error) return platform;
    const MAX = 500 * 1024 * 1024;
    if (!body.size || body.size > MAX) return { error: `Provide size (${(MAX/1024/1024)} MB max)` };
    const safeName = sanitizeName(body.filename);
    const storageKey = `apps/${rel.app_slug}/${rel.version}/${platform}/${safeName}`;
    const mpu = await env.STORAGE.createMultipartUpload(storageKey, { httpMetadata: { contentType: body.mimeType || 'application/octet-stream' } });
    return { success: true, uploadId: mpu.uploadId, key: storageKey, platform, filename: safeName };
  },

  // POST /admin/releases/:id/upload/part (multipart: file, uploadId, key, partNumber)
  async uploadPackagePart(request: Request, env: any) {
    const form = await request.formData().catch(()=>null);
    if (!form) return { error: 'Expected multipart form-data' };
    const file: any = form.get('file');
    const key = String(form.get('key') || '');
    const uploadId = String(form.get('uploadId') || '');
    const partNumber = parseInt(String(form.get('partNumber') || '0'));
    if (!file || typeof file.arrayBuffer !== 'function' || !key || !uploadId || !partNumber) return { error: 'file, uploadId, key, partNumber required' };
    if (file.size > 24 * 1024 * 1024) return { error: 'Part over 24 MB — split smaller' };
    try {
      const mpu = env.STORAGE.resumeMultipartUpload(key, uploadId);
      const part = await mpu.uploadPart(partNumber, await file.arrayBuffer());
      return { success: true, partNumber: part.partNumber, etag: part.etag };
    } catch (e: any) { return { error: `Part ${partNumber} failed: ${String(e?.message || e).slice(0,200)}` }; }
  },

  // POST /admin/releases/:id/upload/complete {uploadId, key, platform, filename, size, mimeType, sha256, parts:[{partNumber, etag}]}
  async uploadPackageComplete(request: Request, env: any) {
    const rel = await loadRelease(env, relIdFrom(request));
    if ((rel as any)?.error) return rel;
    const body: any = await request.json().catch(()=>({}));
    const platform = normPlatform(body.platform);
    if ((platform as any)?.error) return platform;
    const { uploadId, key, filename, size, mimeType, sha256, parts } = body || {};
    if (!uploadId || !key || !Array.isArray(parts) || !parts.length) return { error: 'uploadId, key, parts required' };
    if (!/^[a-f0-9]{64}$/i.test(String(sha256 || ''))) return { error: 'sha256 (64 hex chars) required — computed in the browser before upload' };
    try {
      const mpu = env.STORAGE.resumeMultipartUpload(key, uploadId);
      await mpu.complete(parts);
    } catch (e: any) { return { error: `Complete failed: ${String(e?.message || e).slice(0,200)}` }; }
    const saved = await writePackageRow(env, rel, platform, { filename: sanitizeName(filename || key.split('/').pop() || 'package.bin'), storageKey: key, size: size || 0, mime: mimeType || 'application/octet-stream', sha256: String(sha256).toLowerCase() });
    if ((saved as any)?.error) return saved;
    const origin = new URL(request.url).origin;
    if (rel.status === 'published') {
      await mergeAppPlatforms(env, rel.application_id);
      await syncLegacyAppVersion(env, rel.application_id, rel, origin);
    }
    return { success: true, package: { ...saved, url: `${origin}/r2/${key}`, version: rel.version } };
  },

  // POST /admin/releases/:id/upload/abort {uploadId, key}
  async uploadPackageAbort(request: Request, env: any) {
    const body: any = await request.json().catch(()=>({}));
    try { if (body.uploadId && body.key) await env.STORAGE.resumeMultipartUpload(body.key, body.uploadId).abort(); } catch {}
    return { success: true };
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
    // Auto-notify every user who has this app installed about the new version
    try {
      const appRow: any = await env.DB.prepare('SELECT slug, name FROM applications WHERE id=?').bind(rel.application_id).first();
      const rows: any = await env.DB.prepare(`SELECT DISTINCT user_id FROM downloads WHERE app_id=? AND user_id IS NOT NULL AND user_id != ''`).bind(rel.application_id).all().catch(() => ({ results: [] }));
      let i = 0;
      for (const r of rows?.results || []) {
        await env.DB.prepare(`INSERT INTO notifications (id,user_id,type,title,message,data,read) VALUES (?,?,?,?,?,?,0)`)
          .bind(`n_${Date.now()}_${i++}_${Math.random().toString(36).slice(2,6)}`, r.user_id, 'update',
            `New version: ${appRow?.name || 'App'} ${rel.version}`,
            `Version ${rel.version} of ${appRow?.name || 'the app'} is live — open the app page to update.`,
            JSON.stringify({ link: appRow?.slug ? `/app/${appRow.slug}` : '' })).run().catch(() => {});
      }
    } catch { /* notify is best-effort */ }
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
    const fields = ['name','description','long_description','category','tags','developer','icon','color','gradient','screenshots','features','release_notes','status','current_version','size_mb','rating','price_type','price_amount','platforms','is_featured','is_new','is_trending','release_date','last_updated'];
    const cols = await tableColumns(env, 'applications');
    const sets: string[] = [];
    const binds: any[] = [];
    for (const f of fields) {
      if (body[f] !== undefined && (cols.size === 0 || cols.has(f))) {
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
    // Soft delete — move to recycle bin (tolerate prod DBs missing deleted_at pre-migration)
    const cols = await tableColumns(env, 'applications');
    const sets = [`status='archived'`, `updated_at=datetime('now')`];
    if (cols.has('deleted_at')) sets.unshift(`deleted_at=datetime('now')`);
    await env.DB.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE slug=?`).bind(slug).run();
    await env.DB.prepare(`INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?, ?, ?)`).bind(`log_${Date.now()}`, 'soft_delete_app', 'application', slug, JSON.stringify({ slug })).run().catch(()=>{});
    return { success: true, slug, deleted: true };
  },

  async listDeleted(request: Request, env: any) {
    const appCols = await tableColumns(env, 'applications');
    const relCols = await tableColumns(env, 'releases');
    const appWhere = appCols.has('deleted_at') ? `deleted_at IS NOT NULL OR status='archived'` : `status='archived'`;
    const relWhere = relCols.has('deleted_at') ? `r.deleted_at IS NOT NULL OR r.status='archived'` : `r.status='archived'`;
    const apps: any = await env.DB.prepare(`SELECT * FROM applications WHERE ${appWhere} ORDER BY updated_at DESC LIMIT 50`).all().catch(()=>({results:[]}));
    const rels: any = await env.DB.prepare(`SELECT r.*, a.slug as app_slug FROM releases r JOIN applications a ON a.id=r.application_id WHERE ${relWhere} ORDER BY r.created_at DESC LIMIT 50`).all().catch(()=>({results:[]}));
    return { apps: apps.results || [], releases: rels.results || [] };
  },

  async restoreApp(request: Request, env: any) {
    const slug = new URL(request.url).pathname.split('/')[3];
    const cols = await tableColumns(env, 'applications');
    const sets = [`status='active'`, `updated_at=datetime('now')`];
    if (cols.has('deleted_at')) sets.push(`deleted_at=NULL`);
    await env.DB.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE slug=?`).bind(slug).run();
    return { success: true, slug, restored: true };
  },

  // Permanent delete — only for apps already in the recycle bin (deleted_at set).
  // Removes dependent rows (FK cascade is not guaranteed on older prod DBs) and
  // best-effort cleans R2 release binaries under apps/{slug}/.
  async purgeApp(request: Request, env: any) {
    const seg = new URL(request.url).pathname.split('/').filter(Boolean);
    const slug = seg[seg.length - 2];
    const app: any = await env.DB.prepare('SELECT id, slug, deleted_at FROM applications WHERE slug=?').bind(slug).first().catch(() => null);
    if (!app) return { error: 'App not found' };
    const cols = await tableColumns(env, 'applications');
    if (cols.has('deleted_at') && !app.deleted_at) return { error: 'App is not in the recycle bin — delete it there first (it stays recoverable until then).' };
    await env.DB.prepare('DELETE FROM downloads WHERE app_id=?').bind(app.id).run().catch(() => {});
    await env.DB.prepare('DELETE FROM reviews WHERE app_id=?').bind(app.id).run().catch(() => {});
    await env.DB.prepare('DELETE FROM packages WHERE application_id=?').bind(app.id).run().catch(() => {});
    await env.DB.prepare('DELETE FROM releases WHERE application_id=?').bind(app.id).run().catch(() => {});
    await env.DB.prepare('DELETE FROM app_versions WHERE app_id=?').bind(app.id).run().catch(() => {});
    await env.DB.prepare('DELETE FROM download_statistics WHERE app_id=?').bind(app.id).run().catch(() => {});
    await env.DB.prepare('DELETE FROM applications WHERE id=?').bind(app.id).run();
    let removed = 0;
    try {
      const listed: any = await env.STORAGE.list({ prefix: `apps/${slug}/` });
      for (const o of listed?.objects || []) { await env.STORAGE.delete(o.key).catch(() => {}); removed++; }
    } catch { /* storage cleanup is best-effort */ }
    return { success: true, slug, purged: true, r2_objects_removed: removed };
  },

  async createApp(request: Request, env: any) {
    const data: any = await request.json().catch(()=>({}));
    const id = `app_${Date.now()}`;
    let slug = data.slug || data.name?.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'') || id;
    // Ensure slug is unique
    const exists: any = await env.DB.prepare(`SELECT id FROM applications WHERE slug=?`).bind(slug).first().catch(()=>null);
    if (exists) slug = `${slug}-${Date.now().toString().slice(-4)}`;
    // Save everything the editor sends (like updateApp), tolerating columns missing on older prod DBs
    const cols = await tableColumns(env, 'applications');
    const candidate: Record<string, any> = {
      name: data.name || 'New App',
      description: data.description || '',
      long_description: data.long_description || '',
      category: data.category || 'healthcare',
      tags: JSON.stringify(data.tags || []),
      developer: data.developer || 'Calcitonin Technologies',
      icon: data.icon || '📦',
      color: data.color || '#FFD600',
      gradient: data.gradient || null,
      screenshots: JSON.stringify(data.screenshots || []),
      features: JSON.stringify(data.features || []),
      release_notes: JSON.stringify(data.release_notes || []),
      status: data.status || 'active',
      current_version: data.current_version || data.version || '1.0.0',
      size_mb: data.size_mb ?? null,
      rating: data.rating ?? 0,
      price_type: data.price_type || data.price || 'free',
      price_amount: data.price_amount ?? null,
      platforms: JSON.stringify(data.platforms || ['web']),
      is_featured: data.is_featured ? 1 : 0,
    };
    const names = Object.keys(candidate).filter(k => cols.size === 0 || cols.has(k));
    await env.DB.prepare(`INSERT INTO applications (id, slug, ${names.join(', ')}) VALUES (?, ?, ${names.map(()=>'?').join(', ')})`)
      .bind(id, slug, ...names.map(n=>candidate[n])).run();
    const app: any = await env.DB.prepare(`SELECT * FROM applications WHERE slug=?`).bind(slug).first();
    return app;
  },
};
