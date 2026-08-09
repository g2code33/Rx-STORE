import { App } from '../../types';

/**
 * Pure search-suggestion engine — no React, importable from tests/harness.
 *
 * rankSuggestions scores every app (and category) against the live query and
 * returns the best few, prefix matches first. The dropdown under every search
 * box on the site is fed by this.
 */

export interface SearchHit {
  kind: 'app' | 'category';
  id: string;
  title: string;
  /** Router destination when the user picks this hit. */
  to: string;
  /** Sub line under the title (category + downloads for apps, "Category" otherwise). */
  sub: string;
  app?: App;
  catColor?: string;
  score: number;
}

interface CategoryLike {
  id: string;
  name?: string;
  color?: string;
}

function scoreApp(app: any, q: string, catName: string): number | null {
  const name = String(app?.name || '').toLowerCase();
  if (!name) return null;
  let score: number | null = null;
  if (name.startsWith(q)) score = 100;
  else if (name.split(/[\s\-_:+]/).some((w) => w.startsWith(q))) score = 80;
  else if (name.includes(q)) score = 60;
  if (score === null) {
    const tags: string[] = Array.isArray(app?.tags) ? app.tags : [];
    if (tags.some((t) => String(t).toLowerCase().includes(q))) score = 40;
  }
  if (score === null && catName && catName.toLowerCase().includes(q)) score = 30;
  if (score === null && String(app?.description || '').toLowerCase().includes(q)) score = 20;
  return score;
}

function scoreCategory(cat: CategoryLike, q: string): number | null {
  const name = String(cat?.name || '').toLowerCase();
  if (!name) return null;
  if (name.startsWith(q)) return 75;
  if (name.includes(q)) return 55;
  return null;
}

/** Best `limit` hits for a non-empty trimmed query (empty → []). */
export function rankSuggestions(apps: App[], categories: CategoryLike[], query: string, limit = 7): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const catNameById = new Map<string, string>();
  for (const c of categories || []) if (c?.id && c?.name) catNameById.set(c.id, c.name);

  const hits: SearchHit[] = [];
  for (const app of apps || []) {
    const catName = catNameById.get((app as any).category) || '';
    const score = scoreApp(app, q, catName);
    if (score === null) continue;
    hits.push({
      kind: 'app',
      id: String((app as any).id),
      title: (app as any).name,
      to: `/app/${(app as any).slug}`,
      sub: `${catName || 'App'} • ${formatDl((app as any).downloadCount)} downloads`,
      app,
      score,
    });
  }
  for (const cat of categories || []) {
    const score = scoreCategory(cat, q);
    if (score === null) continue;
    hits.push({
      kind: 'category',
      id: `cat-${cat.id}`,
      title: cat.name || cat.id,
      to: `/categories/${cat.id}`,
      sub: 'Category',
      catColor: cat.color,
      score,
    });
  }
  hits.sort((a, b) =>
    b.score - a.score ||
    ((b.app as any)?.downloadCount || 0) - ((a.app as any)?.downloadCount || 0) ||
    a.title.localeCompare(b.title)
  );
  // One row per destination (an app matching via several fields appears once)
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    if (seen.has(h.to)) continue;
    seen.add(h.to);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

function formatDl(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}
