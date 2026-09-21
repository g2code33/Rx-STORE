/**
 * Storefront & Discovery (Phase 15).
 *
 * One public payload (`GET /storefront/home`) with every home section computed
 * from REAL marketplace data — admin curation (storefront_featured with date
 * windows + ordering), downloads, ratings, update dates and categories. No
 * fabricated app data anywhere.
 *
 * Discovery (`GET /apps/related/:slug`) scores factual signals only:
 * shared category, shared tags, shared platforms and popularity — it never
 * invents user behavior.
 *
 * Admin config routes (admin-JWT gated by index.ts) let admins manage the
 * storefront without touching source code: featured placements (ordering,
 * start/end dates, banners, promo text, enable/disable) and the hero banner
 * (stored in the existing site_settings table).
 */

import { getSetting } from '../services/settings.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function str(v: unknown, max = 500): string {
  return String(v ?? '').trim().slice(0, max);
}

function tryParse(v: any, fallback: any) {
  if (v == null) return fallback;
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : fallback; } catch { return fallback; }
}

function userIdOf(request: Request): string | null {
  return ((request as any).user as any)?.userId || null;
}

async function bodyOf(request: Request): Promise<any> {
  return await request.json().catch(() => ({}));
}

async function appSizesFor(env: any, appIds: string[]): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  if (!appIds.length) return out;
  const rows: any = await env.DB.prepare(
    `SELECT p.application_id AS app_id, p.platform, p.file_size FROM packages p
     JOIN releases r ON r.id = p.release_id
     WHERE p.application_id IN (${appIds.map(() => '?').join(',')}) AND p.status='published' AND r.status='published' AND p.file_size > 0`
  ).bind(...appIds).all().catch(() => ({ results: [] }));
  for (const r of rows?.results || []) {
    out[r.app_id] = out[r.app_id] || {};
    const display = r.platform === 'linux_deb' || r.platform === 'linux_appimage' ? 'linux' : r.platform;
    if (!out[r.app_id][display] || Number(r.file_size) > out[r.app_id][display]) out[r.app_id][display] = Number(r.file_size);
  }
  return out;
}

function normalizeApp(a: any, sizes: Record<string, number> = {}) {
  return {
    id: a.id, slug: a.slug || a.app_slug, name: a.name, description: a.description,
    category: a.category, tags: tryParse(a.tags, []), icon: a.icon, color: a.color,
    gradient: a.gradient, status: a.status, platforms: tryParse(a.platforms, []),
    developer: a.developer, developerOrgId: a.developer_org_id,
    rating: a.rating, reviewCount: a.review_count, downloadCount: a.download_count,
    currentVersion: a.current_version, isFeatured: !!a.is_featured, isNew: !!a.is_new,
    isTrending: !!a.is_trending, lastUpdated: a.last_updated || a.updated_at,
    releaseDate: a.release_date || a.created_at, sizes, website: a.website,
    privacyUrl: a.privacy_url || null, supportUrl: a.support_url || null, videoUrl: a.video_url || null,
  };
}

async function rowsToApps(env: any, rows: any[]): Promise<any[]> {
  const sizes = await appSizesFor(env, rows.map((r: any) => r.id));
  return rows.map((r: any) => normalizeApp(r, sizes[r.id] || {}));
}

const SECTION_LIMIT = 12;

// ---------------------------------------------------------------------------
// Public: GET /storefront/home
// ---------------------------------------------------------------------------

export const storefrontRoutes = {

  /** GET /storefront/home — every home section in one call (real data only). */
  async home(request: Request, env: any) {
    // Admin-curated featured placements live NOW (date-window + enabled aware).
    const featuredRows: any = await env.DB.prepare(
      `SELECT f.placement, f.banner_url, f.promo_text, a.*
       FROM storefront_featured f JOIN applications a ON a.id = f.app_id
       WHERE f.enabled = 1
         AND (f.starts_at IS NULL OR f.starts_at <= datetime('now'))
         AND (f.ends_at IS NULL OR f.ends_at >= datetime('now'))
         AND a.status = 'active'
       ORDER BY f.placement, f.sort_order ASC, f.created_at ASC`
    ).all().catch(() => ({ results: [] }));
    const byPlacement: Record<string, any[]> = { home_featured: [], games_featured: [], apps_featured: [] };
    for (const r of featuredRows?.results || []) {
      const placement = String(r.placement);
      if (byPlacement[placement]) byPlacement[placement].push(r);
    }

    // Hero: admin settings first (site_settings), else the first featured item.
    const hero = {
      title: await getSetting(env, 'storefront.hero.title', ''),
      subtitle: await getSetting(env, 'storefront.hero.subtitle', ''),
      bannerUrl: await getSetting(env, 'storefront.hero.banner', ''),
      ctaLabel: await getSetting(env, 'storefront.hero.ctaLabel', 'Browse apps'),
      ctaTo: await getSetting(env, 'storefront.hero.ctaTo', '/browse'),
      app: null as any,
    };

    const featuredHome = await rowsToApps(env, byPlacement.home_featured.slice(0, SECTION_LIMIT));
    if (!hero.bannerUrl && featuredHome.length) hero.app = featuredHome[0];

    // ---- Computed sections (real signals) ----
    const active = `status = 'active'`;

    const popularRows: any = await env.DB.prepare(
      `SELECT * FROM applications WHERE ${active} ORDER BY download_count DESC, rating DESC LIMIT ?`
    ).bind(SECTION_LIMIT).all().catch(() => ({ results: [] }));

    const newRows: any = await env.DB.prepare(
      `SELECT * FROM applications WHERE ${active} AND is_new = 1 ORDER BY created_at DESC LIMIT ?`
    ).bind(SECTION_LIMIT).all().catch(() => ({ results: [] }));
    // "New & noteworthy" falls back to the genuinely newest listings when the
    // is_new flag has no rows — still factual, never fabricated.
    let newNoteworthy = newRows?.results || [];
    if (!newNoteworthy.length) {
      const fallback: any = await env.DB.prepare(
        `SELECT * FROM applications WHERE ${active} ORDER BY created_at DESC LIMIT ?`
      ).bind(SECTION_LIMIT).all().catch(() => ({ results: [] }));
      newNoteworthy = fallback?.results || [];
    }

    const mostUsedRows: any = await env.DB.prepare(
      // Most used = the strongest factual usage signal the store has: total
      // downloads among recently-active apps (updated in the last 180 days).
      `SELECT * FROM applications WHERE ${active}
       AND (last_updated IS NOT NULL AND last_updated >= datetime('now', '-180 days'))
       ORDER BY download_count DESC LIMIT ?`
    ).bind(SECTION_LIMIT).all().catch(() => ({ results: [] }));

    const updatedRows: any = await env.DB.prepare(
      `SELECT * FROM applications WHERE ${active} AND last_updated IS NOT NULL
       ORDER BY last_updated DESC LIMIT ?`
    ).bind(SECTION_LIMIT).all().catch(() => ({ results: [] }));

    // Recommended: the top-rated app per category (factual quality signal —
    // no user-behavior invention). Ties broken by downloads.
    const recommendedRows: any = await env.DB.prepare(
      `SELECT * FROM applications WHERE ${active} AND review_count > 0
       ORDER BY rating DESC, download_count DESC LIMIT 40`
    ).all().catch(() => ({ results: [] }));
    const seenCategories = new Set<string>();
    const recommendedPicks: any[] = [];
    for (const r of recommendedRows?.results || []) {
      if (seenCategories.has(r.category)) continue;
      seenCategories.add(r.category);
      recommendedPicks.push(r);
      if (recommendedPicks.length >= 6) break;
    }

    const gamesRows: any = await env.DB.prepare(
      `SELECT * FROM applications WHERE ${active} AND category = 'gaming'
       ORDER BY download_count DESC LIMIT ?`
    ).bind(SECTION_LIMIT).all().catch(() => ({ results: [] }));

    const appsRows: any = await env.DB.prepare(
      `SELECT * FROM applications WHERE ${active} AND category != 'gaming'
       ORDER BY download_count DESC LIMIT ?`
    ).bind(SECTION_LIMIT).all().catch(() => ({ results: [] }));

    // Categories with REAL counts.
    const catRows: any = await env.DB.prepare(
      `SELECT category, COUNT(*) AS count FROM applications WHERE ${active} GROUP BY category ORDER BY count DESC`
    ).all().catch(() => ({ results: [] }));
    const categories = (catRows?.results || []).map((c: any) => ({
      id: c.category, name: String(c.category).charAt(0).toUpperCase() + String(c.category).slice(1),
      count: Number(c.count) || 0,
    }));

    const [featured, newNoteworthyApps, popular, mostUsed, recentlyUpdated, recommended, games, apps] = await Promise.all([
      rowsToApps(env, featuredHome),
      rowsToApps(env, newNoteworthy),
      rowsToApps(env, popularRows?.results || []),
      rowsToApps(env, mostUsedRows?.results || []),
      rowsToApps(env, updatedRows?.results || []),
      rowsToApps(env, recommendedPicks),
      rowsToApps(env, byPlacement.games_featured.length ? byPlacement.games_featured : (gamesRows?.results || [])),
      rowsToApps(env, byPlacement.apps_featured.length ? byPlacement.apps_featured : (appsRows?.results || [])),
    ]);

    return {
      hero,
      sections: {
        featured: { title: 'Featured', apps: featured },
        newNoteworthy: { title: 'New & noteworthy', apps: newNoteworthyApps },
        popular: { title: 'Popular', apps: popular },
        mostUsed: { title: 'Most used', apps: mostUsed },
        recentlyUpdated: { title: 'Recently updated', apps: recentlyUpdated },
        recommended: { title: 'Recommended', apps: recommended },
        games: { title: 'Games', apps: games },
        apps: { title: 'Apps', apps: apps },
      },
      categories,
    };
  },

  /** GET /apps/related/:slug — factual discovery (category/tags/platforms/popularity). */
  async related(request: Request, env: any) {
    const slug = decodeURIComponent(new URL(request.url).pathname.split('/').pop() || '');
    const app: any = await env.DB.prepare('SELECT * FROM applications WHERE slug=? AND status=?').bind(slug, 'active').first().catch(() => null);
    if (!app) return { error: 'Application not found', code: 'NOT_FOUND' };

    const rows: any = await env.DB.prepare(
      `SELECT * FROM applications WHERE status='active' AND id != ? LIMIT 100`
    ).bind(app.id).all().catch(() => ({ results: [] }));

    const myTags = new Set(tryParse(app.tags, []).map((t: any) => String(t).toLowerCase()));
    const myPlatforms = new Set(tryParse(app.platforms, []).map((p: any) => String(p).toLowerCase()));
    const myDeveloper = String(app.developer_org_id || '');

    const scored: Array<{ row: any; score: number; reasons: string[] }> = (rows?.results || []).map((r: any) => {
      let score = 0;
      let overlap = false; // at least ONE factual relation is REQUIRED — popularity alone never makes apps "related"
      const reasons: string[] = [];
      if (r.category === app.category) { score += 5; overlap = true; reasons.push('same category'); }
      const tags = tryParse(r.tags, []);
      const sharedTags = tags.filter((t: any) => myTags.has(String(t).toLowerCase()));
      if (sharedTags.length) { score += Math.min(3, sharedTags.length); overlap = true; reasons.push(`${sharedTags.length} shared tag${sharedTags.length === 1 ? '' : 's'}`); }
      const platforms = tryParse(r.platforms, []);
      const sharedPlatforms = platforms.filter((p: any) => myPlatforms.has(String(p).toLowerCase()));
      if (myDeveloper && r.developer_org_id === myDeveloper) { score += 4; overlap = true; reasons.push('same developer'); }
      if (!overlap) return { row: r, score: 0, reasons: [] }; // filtered below — platform overlap alone never makes apps "related"
      if (sharedPlatforms.length) { score += Math.min(2, sharedPlatforms.length); reasons.push('available on your platforms'); }
      // Popularity boost: factual marketplace signal (log-scaled downloads).
      score += Math.log10((Number(r.download_count) || 0) + 1);
      if (Number(r.rating) >= 4) score += 0.5;
      return { row: r, score, reasons };
    }).filter((x: { row: any; score: number; reasons: string[] }) => x.score > 1.5)
      .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
      .slice(0, 8);

    const apps = await rowsToApps(env, scored.map((x: { row: any }) => x.row));
    return {
      apps: apps.map((a, i) => ({ ...a, relatedReasons: scored[i].reasons })),
    };
  },
};

// ---------------------------------------------------------------------------
// Admin: storefront configuration (admin JWT gated by index.ts)
// ---------------------------------------------------------------------------

export const adminStorefrontRoutes = {

  /** GET /admin/storefront — hero settings + featured placements. */
  async get(request: Request, env: any) {
    const rows: any = await env.DB.prepare(
      `SELECT f.*, a.name AS app_name, a.slug AS app_slug, a.icon AS app_icon, a.status AS app_status
       FROM storefront_featured f LEFT JOIN applications a ON a.id = f.app_id
       ORDER BY f.placement, f.sort_order ASC`
    ).all().catch(() => ({ results: [] }));
    const hero = {
      title: await getSetting(env, 'storefront.hero.title', ''),
      subtitle: await getSetting(env, 'storefront.hero.subtitle', ''),
      banner: await getSetting(env, 'storefront.hero.banner', ''),
      ctaLabel: await getSetting(env, 'storefront.hero.ctaLabel', ''),
      ctaTo: await getSetting(env, 'storefront.hero.ctaTo', ''),
    };
    return {
      hero,
      featured: (rows?.results || []).map((f: any) => ({
        id: f.id, appId: f.app_id, appName: f.app_name, appSlug: f.app_slug, appIcon: f.app_icon,
        appStatus: f.app_status, placement: f.placement, sortOrder: Number(f.sort_order) || 0,
        startsAt: f.starts_at, endsAt: f.ends_at, bannerUrl: f.banner_url, promoText: f.promo_text,
        enabled: !!f.enabled,
      })),
    };
  },

  /** POST /admin/storefront/featured — create/update a placement. */
  async saveFeatured(request: Request, env: any) {
    const body = await bodyOf(request);
    const id = str(body.id, 60) || rid('sf');
    const appId = str(body.appId, 60);
    const placement = str(body.placement, 30);
    if (!appId) return { error: 'appId is required', code: 'VALIDATION_ERROR' };
    if (!['home_featured', 'games_featured', 'apps_featured'].includes(placement)) {
      return { error: 'placement must be home_featured, games_featured or apps_featured', code: 'VALIDATION_ERROR' };
    }
    const app: any = await env.DB.prepare('SELECT id FROM applications WHERE id=?').bind(appId).first().catch(() => null);
    if (!app) return { error: 'App not found', code: 'NOT_FOUND' };
    for (const key of ['startsAt', 'endsAt']) {
      const v = str(body[key], 40);
      if (v && !/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(v)) {
        return { error: `${key} must be a date (YYYY-MM-DD) or datetime`, code: 'VALIDATION_ERROR' };
      }
    }
    const sortOrder = Number.isFinite(Number(body.sortOrder)) ? Math.max(0, Math.min(9999, Math.trunc(Number(body.sortOrder)))) : 0;
    const bannerUrl = str(body.bannerUrl, 500);
    if (bannerUrl && !/^https?:\/\//i.test(bannerUrl)) return { error: 'bannerUrl must be an http(s) URL', code: 'VALIDATION_ERROR' };
    const promoText = str(body.promoText, 200);

    await env.DB.prepare(
      `INSERT INTO storefront_featured (id, app_id, placement, sort_order, starts_at, ends_at, banner_url, promo_text, enabled, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         app_id=excluded.app_id, placement=excluded.placement, sort_order=excluded.sort_order,
         starts_at=excluded.starts_at, ends_at=excluded.ends_at, banner_url=excluded.banner_url,
         promo_text=excluded.promo_text, enabled=excluded.enabled, updated_at=datetime('now')`
    ).bind(id, appId, placement, sortOrder,
      str(body.startsAt, 40) || null, str(body.endsAt, 40) || null, bannerUrl || null,
      promoText || null, body.enabled === false ? 0 : 1).run();

    await env.DB.prepare('INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?,?,?)')
      .bind(rid('log'), 'storefront_featured_saved', 'placement', id, JSON.stringify({ appId, placement })).run().catch(() => {});
    return { featured: { id, appId, placement, sortOrder, enabled: body.enabled !== false } };
  },

  /** DELETE /admin/storefront/featured/:id */
  async deleteFeatured(request: Request, env: any) {
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').pop() || '');
    const existing: any = await env.DB.prepare('SELECT id FROM storefront_featured WHERE id=?').bind(id).first().catch(() => null);
    if (!existing) return { error: 'Placement not found', code: 'NOT_FOUND' };
    await env.DB.prepare('DELETE FROM storefront_featured WHERE id=?').bind(id).run();
    await env.DB.prepare('INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?,?,?)')
      .bind(rid('log'), 'storefront_featured_removed', 'placement', id, '{}').run().catch(() => {});
    return { success: true };
  },

  /** PUT /admin/storefront/hero — hero banner settings (site_settings). */
  async saveHero(request: Request, env: any) {
    const body = await bodyOf(request);
    const sets: Array<[string, string]> = [
      ['storefront.hero.title', str(body.title, 120)],
      ['storefront.hero.subtitle', str(body.subtitle, 300)],
      ['storefront.hero.banner', str(body.banner, 500)],
      ['storefront.hero.ctaLabel', str(body.ctaLabel, 60)],
      ['storefront.hero.ctaTo', str(body.ctaTo, 200)],
    ];
    for (const [key, value] of sets) {
      if (value) {
        await env.DB.prepare('INSERT INTO site_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, value).run().catch(async () => {
          // Older deployments without the unique index: update-or-insert manually.
          const has: any = await env.DB.prepare('SELECT key FROM site_settings WHERE key=?').bind(key).first().catch(() => null);
          if (has) await env.DB.prepare('UPDATE site_settings SET value=? WHERE key=?').bind(value, key).run();
          else await env.DB.prepare('INSERT INTO site_settings (key, value) VALUES (?,?)').bind(key, value).run();
        });
      }
    }
    if (str(body.banner, 500) && !/^https?:\/\//i.test(str(body.banner, 500))) {
      return { error: 'banner must be an http(s) URL', code: 'VALIDATION_ERROR' };
    }
    await env.DB.prepare('INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?,?,?)')
      .bind(rid('log'), 'storefront_hero_saved', 'settings', 'storefront.hero', '{}').run().catch(() => {});
    return { success: true };
  },
};

/** Admin app picker for the storefront panel: GET /admin/storefront/apps?q= */
export async function adminStorefrontAppSearch(env: any, q: string) {
  const like = `%${q.trim().toLowerCase()}%`;
  const rows: any = await env.DB.prepare(
    `SELECT id, name, slug, icon, category, status FROM applications
     WHERE LOWER(name) LIKE ? OR slug LIKE ? ORDER BY name ASC LIMIT 20`
  ).bind(like, like).all().catch(() => ({ results: [] }));
  return { apps: rows?.results || [] };
}
void userIdOf;
