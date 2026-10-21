/**
 * Normalize an `applications` row for API consumers.
 *
 * WHY THIS EXISTS (two production crashes): several columns store JSON
 * (`platforms`, `tags`, `screenshots`, `features`, `release_notes`) but a
 * legacy/corrupted row can hold a plain comma string (e.g. 'linux,web').
 * Every API surface that returned a partially-normalized row eventually handed
 * a STRING to a component doing `.join()` / `.map()`, and the React error
 * boundary took the page down:
 *   - `(x.platforms || []).join is not a function`  (Developer App Detail)
 *   - `(a.screenshots || []).join is not a function` (Admin → Apps → editor)
 *
 * ONE normalizer, applied to EVERY app-returning endpoint, so a new field can
 * never reintroduce the class of bug. It is defensive by design: any value
 * that is not a JSON array is split on commas; junk becomes [].
 */

/** Parse a JSON-array column into a string[] — always an array, never throws. */
export function listColumn(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  const s = String(v ?? '').trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (parsed && typeof parsed === 'object') return [];
  } catch {
    // Not JSON: tolerate a legacy comma-separated string.
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/** Parse a JSON-array column that may hold objects (kept as-is). */
export function objectListColumn(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  const s = String(v ?? '').trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** True for a display platform id we keep in applications.platforms. */
const DISPLAY_PLATFORMS = new Set(['web', 'windows', 'linux', 'android', 'ios', 'macos']);

/**
 * Normalize an applications row: every JSON column becomes a real array and
 * the camelCase aliases the UI reads are filled in.
 */
export function normalizeAppRow(a: any): any {
  if (!a) return a;
  const platforms = listColumn(a.platforms).filter((p) => DISPLAY_PLATFORMS.has(String(p).toLowerCase()));
  return {
    ...a,
    // --- JSON list columns (NEVER a string again) ---
    platforms,
    tags: listColumn(a.tags),
    screenshots: listColumn(a.screenshots),
    features: listColumn(a.features),
    releaseNotes: listColumn(a.release_notes ?? a.releaseNotes),
    // --- snake_case mirrors kept for older clients ---
    release_notes: listColumn(a.release_notes ?? a.releaseNotes),
    // --- numerics / flags ---
    downloadCount: Number(a.download_count ?? a.downloadCount ?? 0),
    reviewCount: Number(a.review_count ?? a.reviewCount ?? 0),
    priceAmount: a.price_amount ?? a.priceAmount ?? 0,
    price: a.price_type || a.price || 'free',
    priceType: a.price_type || a.priceType || 'free',
    version: a.current_version || a.version || '1.0.0',
    currentVersion: a.current_version || a.version || '1.0.0',
    isFeatured: !!(a.is_featured ?? a.isFeatured),
    isNew: !!(a.is_new ?? a.isNew),
    isTrending: !!(a.is_trending ?? a.isTrending),
    // --- camelCase aliases ---
    developerOrgId: a.developer_org_id ?? a.developerOrgId ?? null,
    longDescription: a.long_description ?? a.longDescription ?? a.description ?? '',
    createdAt: a.created_at ?? a.createdAt ?? '',
    lastUpdated: a.last_updated ?? a.updated_at ?? a.lastUpdated ?? '',
    androidPackageId: a.android_package_id ?? a.androidPackageId ?? '',
    windowsUninstallKey: a.windows_uninstall_key ?? a.windowsUninstallKey ?? '',
    windowsExecutable: a.windows_executable ?? a.windowsExecutable ?? '',
    linuxPackageName: a.linux_package_name ?? a.linuxPackageName ?? '',
    linuxExecutable: a.linux_executable ?? a.linuxExecutable ?? '',
  };
}
