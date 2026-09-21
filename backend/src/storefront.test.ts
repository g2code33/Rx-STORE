/**
 * Storefront & Discovery tests (Phase 15).
 *
 * Real route handlers against an in-memory D1 fake: home payload computed
 * from real rows (sections, category counts, admin curation with date
 * windows + enable flags), factual related-app discovery (category/tags/
 * platforms/developer scoring, self-exclusion, unrelated apps filtered),
 * admin config validation, and the extended search fields.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { storefrontRoutes, adminStorefrontRoutes } from './routes/storefront.ts';
import { appsRoutes } from './routes/apps.ts';
import { clearSettingsCache } from './services/settings.ts';

// ---------------------------------------------------------------------------
// In-memory fake
// ---------------------------------------------------------------------------

function makeEnv() {
  const db: any = {
    users: [{ id: 'admin1', name: 'Admin', email: 'a@x.com', role: 'admin' }],
    applications: [
      { id: 'app_1', slug: 'clinic', name: 'Clinic Pro', description: 'Clinic management', category: 'healthcare', status: 'active',
        platforms: '["web","windows"]', tags: '["health","records"]', developer: 'Org A', developer_org_id: 'dev_a',
        icon: 'https://x/1.png', rating: 4.8, review_count: 20, download_count: 500, is_new: 1, is_featured: 0, is_trending: 0,
        current_version: '2.0.0', last_updated: '2026-09-01', release_date: '2026-08-01', created_at: '2026-08-01', website: null, privacy_url: null, support_url: null, video_url: null },
      { id: 'app_2', slug: 'medcalc', name: 'MedCalc', description: 'Medical calculator', category: 'healthcare', status: 'active',
        platforms: '["web","android"]', tags: '["health","calculator"]', developer: 'Org A', developer_org_id: 'dev_a',
        icon: 'https://x/2.png', rating: 4.5, review_count: 10, download_count: 300, is_new: 0, is_featured: 0, is_trending: 0,
        current_version: '1.1.0', last_updated: '2026-08-20', release_date: '2026-07-01', created_at: '2026-07-01', website: null, privacy_url: null, support_url: null, video_url: null },
      { id: 'app_3', slug: 'quest', name: 'Quiz Quest', description: 'Educational quiz game', category: 'gaming', status: 'active',
        platforms: '["web","android"]', tags: '["education","fun"]', developer: 'Org B', developer_org_id: 'dev_b',
        icon: 'https://x/3.png', rating: 4.9, review_count: 5, download_count: 50, is_new: 1, is_featured: 0, is_trending: 0,
        current_version: '1.0.0', last_updated: '2026-09-10', release_date: '2026-09-10', created_at: '2026-09-10', website: null, privacy_url: null, support_url: null, video_url: null },
      { id: 'app_4', slug: 'draft-app', name: 'Draft App', description: 'Not public', category: 'healthcare', status: 'draft',
        platforms: '["web"]', tags: '[]', developer: 'Org A', developer_org_id: 'dev_a', icon: null, rating: 0, review_count: 0,
        download_count: 0, is_new: 0, is_featured: 0, is_trending: 0, current_version: null, last_updated: null, release_date: null, created_at: '2026-09-01', website: null, privacy_url: null, support_url: null, video_url: null },
    ],
    releases: [{ id: 'rel_1', application_id: 'app_1', version: '2.0.0', status: 'published', channel: 'stable', published_at: '2026-09-01', created_at: '2026-09-01', release_notes: '["Big update"]' }],
    packages: [{ id: 'pkg_1', application_id: 'app_1', release_id: 'rel_1', platform: 'windows', file_size: 10485760, status: 'published' }],
    storefront_featured: [] as any[],
    site_settings: [] as any[],
    audit_logs: [] as any[],
  };

  const DB = {
    prepare(sql: string) {
      const self: any = {
        _b: [] as any[],
        bind(...a: any[]) { self._b = a; return self; },
        async first() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          const t = s.replace(/ = /g, '=').replace(/ LIKE /g, ' LIKE ');
          if (t.includes('SELECT * FROM applications WHERE slug=?AND status=?')) return db.applications.find((x: any) => x.slug === a[0] && x.status === a[1]) || null;
          if (t.includes('SELECT * FROM applications WHERE slug=?')) return db.applications.find((x: any) => x.slug === a[0]) || null;
          if (t.includes('SELECT value FROM site_settings WHERE key=?')) return db.site_settings.find((x: any) => x.key === a[0]) || null;
          if (t.includes('SELECT * FROM applications WHERE id=?')) return db.applications.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT id FROM applications WHERE id=?')) return db.applications.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT key FROM site_settings WHERE key=?')) return db.site_settings.find((x: any) => x.key === a[0]) || null;
          if (s.includes('SELECT id FROM storefront_featured WHERE id=?')) return db.storefront_featured.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT COUNT(*) as total FROM applications')) {
            // apps.list count — replicate the filter logic minimally for search/category/platform
            const search = self._searchVal; const category = self._catVal; const platform = self._platVal;
            const rows = db.applications.filter((x: any) => {
              if (x.status !== 'active') return false;
              if (category && x.category !== category) return false;
              if (platform && !String(x.platforms).includes(platform)) return false;
              if (search && ![x.name, x.description, x.category, x.developer, x.tags].some((f: any) => String(f || '').toLowerCase().includes(search.toLowerCase()))) return false;
              return true;
            });
            return { total: rows.length };
          }
          return null;
        },
        async all() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('FROM storefront_featured f JOIN applications a ON a.id = f.app_id')) {
            return { results: db.storefront_featured
              .filter((f: any) => f.enabled === 1 && (!f.starts_at || f.starts_at <= 'now') && (!f.ends_at || f.ends_at >= 'now'))
              .map((f: any) => ({ ...f, ...db.applications.find((x: any) => x.id === f.app_id) })) };
          }
          const t2 = s.replace(/status = 'active'/g, "status='active'");
          if (t2.includes("SELECT * FROM applications WHERE status='active'")) {
            // Dispatch by the ORDER BY shape used by each section query.
            let rows = db.applications.filter((x: any) => x.status === 'active');
            if (s.includes("category = 'gaming'")) rows = rows.filter((x: any) => x.category === 'gaming');
            if (s.includes("category != 'gaming'")) rows = rows.filter((x: any) => x.category !== 'gaming');
            if (s.includes('is_new = 1')) rows = rows.filter((x: any) => x.is_new === 1);
            if (s.includes('last_updated >= datetime')) rows = rows.filter((x: any) => x.last_updated && x.last_updated >= '2026-03-15');
            if (s.includes('last_updated IS NOT NULL')) rows = rows.filter((x: any) => !!x.last_updated);
            if (s.includes('review_count > 0')) rows = rows.filter((x: any) => x.review_count > 0);
            if (s.includes('AND id != ?')) rows = rows.filter((x: any) => x.id !== a[0]);
            if (self._searchVal) rows = rows.filter((x: any) => [x.name, x.description, x.category, x.developer, x.tags].some((f: any) => String(f || '').toLowerCase().includes(String(self._searchVal).toLowerCase())));
            if (self._catVal) rows = rows.filter((x: any) => x.category === self._catVal);
            if (self._platVal) rows = rows.filter((x: any) => String(x.platforms).includes(self._platVal));
            if (s.includes('LIMIT 40')) rows = rows.slice(0, 40);
            if (s.includes('ORDER BY download_count DESC')) rows = [...rows].sort((x: any, y: any) => y.download_count - x.download_count);
            if (s.includes('ORDER BY rating DESC')) rows = [...rows].sort((x: any, y: any) => y.rating - x.rating);
            if (s.includes('ORDER BY created_at DESC')) rows = [...rows].sort((x: any, y: any) => String(y.created_at).localeCompare(String(x.created_at)));
            if (s.includes('ORDER BY last_updated DESC')) rows = [...rows].sort((x: any, y: any) => String(y.last_updated || '').localeCompare(String(x.last_updated || '')));
            return { results: rows.slice(0, self._limit ?? 12) };
          }
          if (s.includes('SELECT key, value FROM site_settings')) {
            return { results: db.site_settings };
          }
          if (s.includes('SELECT category, COUNT(*) AS count FROM applications')) {
            const by: Record<string, number> = {};
            for (const x of db.applications.filter((y: any) => y.status === 'active')) by[x.category] = (by[x.category] || 0) + 1;
            return { results: Object.entries(by).map(([category, count]) => ({ category, count })) };
          }
          if (s.includes('SELECT f.*, a.name AS app_name')) {
            return { results: db.storefront_featured.map((f: any) => ({ ...f, app_name: db.applications.find((x: any) => x.id === f.app_id)?.name, app_slug: 'x', app_icon: null, app_status: 'active' })) };
          }
          if (s.includes('SELECT id, name, slug, icon, category, status FROM applications')) {
            const q = a[0] ?? '';
            return { results: db.applications.filter((x: any) => x.name.toLowerCase().includes(String(q).toLowerCase()) || x.slug.includes(String(q).toLowerCase())) };
          }
          if (s.includes('SELECT version, channel, published_at')) {
            return { results: db.releases.filter((r: any) => r.application_id === a[0] && r.status === 'published') };
          }
          if (s.includes('FROM packages p JOIN releases r ON r.id = p.release_id')) {
            return { results: db.packages.filter((p: any) => a.includes(p.application_id) && p.status === 'published')
              .map((p: any) => ({ app_id: p.application_id, platform: p.platform, file_size: p.file_size })) };
          }
          return { results: [] };
        },
        async run() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('INSERT INTO storefront_featured')) {
            const existing = db.storefront_featured.find((x: any) => x.id === a[0]);
            const row = { id: a[0], app_id: a[1], placement: a[2], sort_order: a[3], starts_at: a[4], ends_at: a[5], banner_url: a[6], promo_text: a[7], enabled: a[8], created_at: 'now', updated_at: 'now' };
            if (existing) Object.assign(existing, row); else db.storefront_featured.push(row);
            return { meta: { changes: 1 } };
          }
          if (s.includes('DELETE FROM storefront_featured')) {
            const i = db.storefront_featured.findIndex((x: any) => x.id === a[0]);
            if (i >= 0) db.storefront_featured.splice(i, 1);
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO site_settings')) {
            const [key, value] = a;
            const existing = db.site_settings.find((x: any) => x.key === key);
            if (existing) existing.value = value; else db.site_settings.push({ key, value });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO audit_logs')) { db.audit_logs.push({ id: a[0], action: a[1] }); return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  // capture LIMIT + filter values for the section queries (they bind limit last)
  const origPrepare = DB.prepare.bind(DB);
  (DB as any).prepare = (sql: string) => {
    const stmt: any = origPrepare(sql);
    const origBind = stmt.bind.bind(stmt);
    stmt.bind = (...a: any[]) => {
      const s = sql.replace(/\s+/g, ' ');
      if (/LIMIT \?$/.test(s)) stmt._limit = Number(a[a.length - 1]) || 12;
      const searchIdx = s.split('?').length - 1;
      void searchIdx;
      if (s.includes('name LIKE ?')) stmt._searchVal = String(a[0] || '').replace(/%/g, '');
      if (s.includes('category = ?') && !s.includes("= 'gaming'")) stmt._catVal = a[0];
      if (s.includes('platforms LIKE ?')) stmt._platVal = String(a[0] || '').replace(/%/g, '');
      return origBind(...a);
    };
    return stmt;
  };
  const STORAGE = { put: async () => {}, get: async () => null, head: async () => null };
  return { DB, STORAGE, db };
}

const req = (userId: string | null, body: any, path: string, method = 'GET') => {
  const r = new Request(`https://api.rxstore.com${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body || {}) });
  if (userId) (r as any).user = { userId };
  return r;
};

// ---------------------------------------------------------------------------
// Home payload
// ---------------------------------------------------------------------------

test('home: every section is computed from real rows — no fabricated apps', async () => {
  const env = makeEnv();
  const out: any = await storefrontRoutes.home(req(null, null, '/storefront/home'), env);
  const sections = out.sections;

  assert.ok(sections.popular.apps.some((a: any) => a.slug === 'clinic'), 'popular includes the most-downloaded app');
  assert.equal(sections.popular.apps[0].slug, 'clinic');
  assert.ok(sections.newNoteworthy.apps.some((a: any) => a.slug === 'quest'), 'new & noteworthy includes the is_new app');
  assert.ok(sections.games.apps.every((a: any) => a.category === 'gaming'), 'games section only gaming');
  assert.ok(sections.apps.apps.every((a: any) => a.category !== 'gaming'), 'apps section excludes gaming');
  assert.ok(sections.recentlyUpdated.apps.length > 0, 'recently updated populated');
  assert.ok(sections.recommended.apps.some((a: any) => a.slug === 'clinic'), 'recommended = top rated per category');
  // Non-active apps NEVER appear anywhere.
  const allSlugs = Object.values(sections).flatMap((v: any) => v.apps.map((a: any) => a.slug));
  assert.ok(!allSlugs.includes('draft-app'), 'draft app invisible');
  // Categories carry live counts.
  const healthcare = out.categories.find((c: any) => c.id === 'healthcare');
  assert.equal(healthcare.count, 2);
  assert.equal(out.categories.find((c: any) => c.id === 'gaming').count, 1);
});

test('home: admin curation drives the Featured row with date windows + enable flags', async () => {
  const env = makeEnv();
  // Featured: an ACTIVE app (live), an expired window (hidden), a disabled row (hidden).
  await adminStorefrontRoutes.saveFeatured(req('admin1', { appId: 'app_2', placement: 'home_featured', sortOrder: 1 }, '/admin/storefront/featured', 'POST'), env);
  await adminStorefrontRoutes.saveFeatured(req('admin1', { appId: 'app_1', placement: 'home_featured', sortOrder: 2, startsAt: '2026-01-01', endsAt: '2026-02-01' }, '/admin/storefront/featured', 'POST'), env);
  const disabled: any = await adminStorefrontRoutes.saveFeatured(req('admin1', { appId: 'app_3', placement: 'home_featured', sortOrder: 3, enabled: false }, '/admin/storefront/featured', 'POST'), env);
  void disabled;

  const out: any = await storefrontRoutes.home(req(null, null, '/storefront/home'), env);
  const slugs = out.sections.featured.apps.map((a: any) => a.slug);
  assert.deepEqual(slugs, ['medcalc'], 'only the live, enabled, active placement renders');
});

test('home: the games/apps rows use curated placements when present', async () => {
  const env = makeEnv();
  await adminStorefrontRoutes.saveFeatured(req('admin1', { appId: 'app_3', placement: 'games_featured', sortOrder: 1 }, '/admin/storefront/featured', 'POST'), env);
  const out: any = await storefrontRoutes.home(req(null, null, '/storefront/home'), env);
  assert.deepEqual(out.sections.games.apps.map((a: any) => a.slug), ['quest'], 'curated games placement wins over the computed row');
});

test('home: hero falls back to the first featured app when no banner is configured', async () => {
  const env = makeEnv();
  await adminStorefrontRoutes.saveFeatured(req('admin1', { appId: 'app_2', placement: 'home_featured', sortOrder: 1 }, '/admin/storefront/featured', 'POST'), env);
  const out: any = await storefrontRoutes.home(req(null, null, '/storefront/home'), env);
  assert.equal(out.hero.app?.slug, 'medcalc');
  assert.equal(out.hero.ctaTo, '/browse', 'hero defaults');
});

test('home: sizes are derived from REAL published packages', async () => {
  const env = makeEnv();
  const out: any = await storefrontRoutes.home(req(null, null, '/storefront/home'), env);
  const clinic = out.sections.popular.apps.find((a: any) => a.slug === 'clinic');
  assert.equal(clinic.sizes.windows, 10485760, 'auto-detected size from the published package');
});

// ---------------------------------------------------------------------------
// Admin config validation
// ---------------------------------------------------------------------------

test('admin storefront config: validates placement, app existence and dates', async () => {
  const env = makeEnv();
  const badPlacement: any = await adminStorefrontRoutes.saveFeatured(req('admin1', { appId: 'app_1', placement: '_everywhere' }, '/admin/storefront/featured', 'POST'), env);
  assert.equal(badPlacement.code, 'VALIDATION_ERROR');
  const badApp: any = await adminStorefrontRoutes.saveFeatured(req('admin1', { appId: 'missing', placement: 'home_featured' }, '/admin/storefront/featured', 'POST'), env);
  assert.equal(badApp.code, 'NOT_FOUND');
  const badDate: any = await adminStorefrontRoutes.saveFeatured(req('admin1', { appId: 'app_1', placement: 'home_featured', startsAt: 'yesterday' }, '/admin/storefront/featured', 'POST'), env);
  assert.equal(badDate.code, 'VALIDATION_ERROR');
  const ok: any = await adminStorefrontRoutes.saveFeatured(req('admin1', { appId: 'app_1', placement: 'home_featured', startsAt: '2026-01-01', endsAt: '2026-12-31' }, '/admin/storefront/featured', 'POST'), env);
  assert.ok(ok.featured.id);
  assert.ok(env.db.audit_logs.some((l: any) => l.action === 'storefront_featured_saved'));
});

test('admin hero settings persist through site_settings', async () => {
  clearSettingsCache(); // getSetting caches for 30s — reset so this test sees fresh writes
  const env = makeEnv();
  const out: any = await adminStorefrontRoutes.saveHero(req('admin1', { title: 'Healthcare, delivered', subtitle: 'Professional tools', banner: 'https://x/banner.png', ctaLabel: 'Browse', ctaTo: '/browse' }, '/admin/storefront/hero', 'PUT'), env);
  assert.equal(out.success, true);
  const saved = env.db.site_settings.find((s: any) => s.key === 'storefront.hero.title');
  assert.equal(saved.value, 'Healthcare, delivered');
  clearSettingsCache();
  const home: any = await storefrontRoutes.home(req(null, null, '/storefront/home'), env);
  assert.equal(home.hero.title, 'Healthcare, delivered');
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('related: factual scoring — same category/tags/developer rank highest; self excluded', async () => {
  const env = makeEnv();
  const out: any = await storefrontRoutes.related(req(null, null, '/apps/related/clinic'), env);
  const slugs = out.apps.map((a: any) => a.slug);
  assert.ok(!slugs.includes('clinic'), 'the app itself is never related to itself');
  assert.equal(slugs[0], 'medcalc', 'same category + same developer + shared tag wins');
  assert.ok(out.apps[0].relatedReasons.some((r: string) => r.includes('category')));
});

test('related: unrelated apps are filtered out (score floor)', async () => {
  const env = makeEnv();
  // quest: different category (gaming vs healthcare), no shared tags, different developer — only platforms overlap slightly.
  const out: any = await storefrontRoutes.related(req(null, null, '/apps/related/clinic'), env);
  assert.ok(!out.apps.some((a: any) => a.slug === 'quest'), 'nothing-in-common apps are not "related"');
});

test('related: unknown app 404s', async () => {
  const env = makeEnv();
  const out: any = await storefrontRoutes.related(req(null, null, '/apps/related/nope'), env);
  assert.equal(out.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Extended search (apps.list)
// ---------------------------------------------------------------------------

test('search now spans developer and tags, not just name/description/category', async () => {
  const env = makeEnv();
  // By developer name
  const byDev: any = await appsRoutes.list(req(null, null, '/apps?search=Org B'), env);
  assert.ok(byDev.apps.some((a: any) => a.slug === 'quest'), 'found by developer');
  // By tag
  const byTag: any = await appsRoutes.list(req(null, null, '/apps?search=calculator'), env);
  assert.ok(byTag.apps.some((a: any) => a.slug === 'medcalc'), 'found by tag');
  // Draft apps never appear
  const byName: any = await appsRoutes.list(req(null, null, '/apps?search=Draft'), env);
  assert.equal(byName.apps.length, 0, 'draft app not searchable');
});

test('detail exposes the new metadata + published version history', async () => {
  const env = makeEnv();
  const out: any = await appsRoutes.detail(req(null, null, '/apps/clinic'), env);
  assert.ok(Array.isArray(out.versions) && out.versions.length === 1, 'version history from published releases');
  assert.equal(out.versions[0].version, '2.0.0');
  assert.equal(out.developerOrgId, 'dev_a', 'developer profile link data');
  // privacy/support/video surface (null when unset)
  assert.equal(out.privacyUrl, null);
  assert.equal(out.supportUrl, null);
  assert.equal(out.videoUrl, null);
});
