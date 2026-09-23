/**
 * Applications Routes — D1 (SQLite) compatible
 */
import { getSetting } from '../services/settings.ts';
import { verifyToken } from '../services/auth.ts';
import { paginationMeta } from '../services/releases.ts';

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

    // WHERE clause + bindings are shared by the page query AND the COUNT query so
    // `total` reflects the whole filtered set, not just this page's length.
    let filterSql = '';
    const filterBindings: any[] = [];
    if (category) { filterSql += ` AND category = ?`; filterBindings.push(category); }
    if (search) { filterSql += ` AND (name LIKE ? OR description LIKE ? OR category LIKE ?)`; const p = `%${search}%`; filterBindings.push(p,p,p); }
    if (platform) { filterSql += ` AND platforms LIKE ?`; filterBindings.push(`%${platform}%`); }

    let orderSql: string;
    switch (sort) {
      case 'rating': orderSql = ` ORDER BY rating DESC`; break;
      case 'newest': orderSql = ` ORDER BY release_date DESC`; break;
      case 'name': orderSql = ` ORDER BY name ASC`; break;
      default: orderSql = ` ORDER BY download_count DESC`; break;
    }
    const safePage = Math.max(1, page || 1);
    const query = `SELECT * FROM applications WHERE status='active'${filterSql}${orderSql} LIMIT ? OFFSET ?`;
    const bindings: any[] = [...filterBindings, limit, (safePage - 1) * limit];

    const result: any = await env.DB.prepare(query).bind(...bindings).all();
    const apps = result.results || [];
    const sizesByApp = await appSizesFor(env, apps.map((a: any) => a.id));
    const normalized = apps.map((a:any)=> {
      const row: any = { ...a, platforms: tryParse(a.platforms, []), tags: tryParse(a.tags, []), screenshots: tryParse(a.screenshots, []), features: tryParse(a.features, []), releaseNotes: tryParse(a.release_notes, []), version: a.current_version || a.version || '1.0.0', downloadCount: a.download_count, reviewCount: a.review_count, priceAmount: a.price_amount, price: a.price_type || a.price };
      return withSize(env, a.id, row, sizesByApp[a.id] || {});
    });

    // The TRUE total requires a separate COUNT with the same filters — the page
    // length is only how many rows this page returned. Returning the page length
    // as `total` (the previous behaviour) made pagination controls wrong.
    const countQuery = `SELECT COUNT(*) as total FROM applications WHERE status='active'` + filterSql;
    const countRow: any = await env.DB.prepare(countQuery).bind(...filterBindings).first().catch(() => ({ total: normalized.length }));
    const total = Number(countRow?.total ?? normalized.length);
    const meta = paginationMeta({ page, limit, total });

    return {
      apps: normalized,
      pagination: {
        page: meta.page,
        limit: meta.pageSize,
        pageSize: meta.pageSize,
        total: meta.total,
        totalPages: meta.totalPages,
        hasNext: meta.hasNext,
        hasPrevious: meta.hasPrevious,
      },
    };
  },
  async detail(request: Request, env: any) {
    const url = new URL(request.url);
    const slug = url.pathname.split('/').filter(Boolean).pop() || '';
    const app: any = await env.DB.prepare(`SELECT * FROM applications WHERE slug = ?`).bind(slug).first();
    if (!app) return { error: 'Application not found' };
    // PUBLIC MARKETPLACE RULE (Phase 12 §18): developer drafts, submissions,
    // changes-requested, rejected and suspended apps are NEVER publicly
    // reachable — not even by guessing the slug. Admins preview via the
    // admin endpoints instead.
    if (!['active', 'beta', 'coming-soon'].includes(String(app.status || 'active'))) {
      return { error: 'Application not found' };
    }
    const row = { ...app, platforms: tryParse(app.platforms, []), tags: tryParse(app.tags, []), downloadCount: app.download_count, reviewCount: app.review_count, priceAmount: app.price_amount, price: app.price_type || app.price || 'free' };
    // Provide frontend defaults for fields not stored in D1
    row.longDescription = app.long_description || app.description || '';
    row.features = tryParse(app.features, null) || ['Secure & Verified', 'Cross-platform', 'Auto-updates', 'Cloud sync'];
    row.releaseNotes = tryParse(app.release_notes, null) || ['Latest stable release'];
    row.screenshots = tryParse(app.screenshots, []);
    row.gradient = app.gradient || 'from-rx-dark to-rx-dark-secondary';
    row.color = app.color || '#FFD600';
    row.version = app.current_version || app.version || '1.0.0';
    row.privacyUrl = app.privacy_url || null;
    row.supportUrl = app.support_url || null;
    row.videoUrl = app.video_url || null;
    row.developerOrgId = app.developer_org_id || null;
    row.releaseDate = app.release_date || app.created_at;
    row.lastUpdated = app.last_updated || app.updated_at || app.created_at;
    row.developer = app.developer || 'Calcitonin Technologies';
    row.status = app.status || 'active';
    row.category = app.category || 'healthcare';
    const sizes = await appSizesFor(env, [app.id]);
    // Phase 15: published version history (release channel + dates).
    const versionRows: any = await env.DB.prepare(
      `SELECT version, channel, published_at, created_at, release_notes FROM releases
       WHERE application_id = ? AND status = 'published' ORDER BY published_at DESC, created_at DESC LIMIT 10`
    ).bind(app.id).all().catch(() => ({ results: [] }));
    row.versions = (versionRows?.results || []).map((v: any) => ({
      version: v.version, channel: v.channel, publishedAt: v.published_at || v.created_at,
      releaseNotes: tryParse(v.release_notes, []),
    }));
    return withSize(env, app.id, row, sizes[app.id] || {});
  },
  // Reviews moved to backend/src/routes/reviews.ts (Phase 17): list/submit
  // are dispatched from index.ts; the old handler was removed.

};
function tryParse(v: any, fallback: any) { if (!v) return fallback; if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch { return fallback; } }
