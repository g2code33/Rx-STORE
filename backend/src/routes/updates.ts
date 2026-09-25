/**
 * Update Check Routes — the ONE canonical update API consumed by the RX Store
 * Developer SDK (sdk/) and any host application.
 *
 * GET /updates/check?app=clinical-rx&currentVersion=3.2.0&platform=windows[&arch=x64][&channel=stable]
 * Aliases (unchanged, dispatched in index.ts): /update/check,
 * /api/updates/check, /api/update/check. No duplicate endpoint exists.
 *
 * Response contract (see docs/API.md): the SERVER is authoritative for every
 * value — updateAvailable, latestVersion, mandatory, minimumSupportedVersion,
 * checksum. The client's job is to display, never to decide. Downloading,
 * checksum verification, entitlement checks and installation stay inside RX
 * Store: for PAID applications this unauthenticated endpoint never exposes a
 * binary download URL (Phase 22) — the SDK only needs the store/deep-link
 * destination.
 */

import { compareSemver } from '../services/releases.ts';

export const updatesRoutes = {
  async checkUpdate(request: Request, env: any) {
    const url = new URL(request.url);
    const appId = url.searchParams.get('app');
    const currentVersion = url.searchParams.get('currentVersion');
    const platform = url.searchParams.get('platform');
    const architecture = url.searchParams.get('arch') || url.searchParams.get('architecture');
    const channel = url.searchParams.get('channel') || 'stable';

    if (!appId || !currentVersion || !platform) {
      // 400 VALIDATION_ERROR (dispatched in index.ts) — matches the SDK contract.
      return { code: 'VALIDATION_ERROR', error: 'Missing required parameters: app, currentVersion, platform' };
    }

    let plat = String(platform).toLowerCase();
    if (plat === 'deb') plat = 'linux_deb';
    if (plat === 'appimage') plat = 'linux_appimage';
    let arch: string | null = architecture ? String(architecture).toLowerCase() : null;

    const app = await env.DB.prepare('SELECT * FROM applications WHERE slug = ?').bind(appId).first().catch(()=>null);
    if (!app) return { code: 'NOT_FOUND', error: 'Application not found' };

    // Canonical release metadata for THIS version (channel + minimum supported
    // version are release-level policy, stored on the canonical `releases`
    // table). `mandatory` lives on the synced app_versions row (see below).
    const releaseRow: any = await env.DB.prepare(
      "SELECT channel, minimum_supported_version FROM releases WHERE application_id = ? AND version = ? AND status = 'published' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1"
    ).bind(app.id, app.current_version).first().catch(() => null);

    // Web origin for the store page / SDK fallback link. Explicit var wins
    // (wrangler.toml RX_STORE_WEB_URL), otherwise the production Pages domain.
    const webBase = String(env?.RX_STORE_WEB_URL || 'https://rx-store-web.pages.dev').replace(/\/+$/, '');
    const slug = String(app.slug || appId);
    const storeUrl = `${webBase}/app/${encodeURIComponent(slug)}`;
    const deepLink = `rxstore://app/${encodeURIComponent(slug)}`;
    const checkedAt = new Date().toISOString();

    // Compare versions (SemVer-aware incl. prereleases — services/releases.ts)
    const isUpdateAvailable = compareVersions(app.current_version || '0.0.0', currentVersion) > 0;

    // Release-level policy values (server-authoritative).
    const minimumSupportedVersion = releaseRow?.minimum_supported_version
      ? String(releaseRow.minimum_supported_version)
      : null;
    // A version below the minimum supported version is treated as mandatory:
    // the host app must send the user to RX Store to update.
    const belowMinimum = minimumSupportedVersion ? compareVersions(currentVersion, minimumSupportedVersion) < 0 : false;
    const channelOut = String(releaseRow?.channel || channel || 'stable').toLowerCase();

    if (!isUpdateAvailable) {
      return {
        appId: app.id,
        app: app.name,
        slug,
        currentVersion,
        latestVersion: app.current_version,
        platform: plat,
        architecture: arch,
        channel: channelOut,
        updateAvailable: false,
        mandatory: false,
        minimumSupportedVersion,
        updateRequired: belowMinimum,
        releaseNotes: [],
        fileSize: null,
        checksum: null,
        storeUrl,
        deepLink,
        checkedAt,
      };
    }

    // Latest release files — app_versions is kept in sync on publish {url, fileUrl, size, checksum}
    const release = await env.DB.prepare(
      'SELECT * FROM app_versions WHERE app_id = ? AND version = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(app.id, app.current_version).first().catch(()=>null);

    let files: any = {};
    try { files = release?.files ? JSON.parse(release.files) : {}; } catch {}
    const file = files[plat] || (plat === 'linux' ? (files['linux_deb'] || files['linux_appimage']) : null) || files.generic;
    const origin = new URL(request.url).origin;
    let downloadURL = file?.url || file?.fileUrl || null;
    if (downloadURL && (downloadURL.startsWith('apps/') || downloadURL.startsWith('assets/'))) downloadURL = `${origin}/r2/${downloadURL}`;

    // PHASE 22 — paid applications must NEVER expose a public download URL
    // here (this endpoint is unauthenticated). Update metadata (version,
    // notes, checksum) is fine; the binary comes only through the authorized
    // download flow (entitlement -> short-lived grant). Old legacy rows may
    // still contain raw URLs, so enforce this regardless of what was stored.
    const appIsPaidRow = ['paid', 'subscription'].includes(String(app.price_type || 'free')) && Number(app.price_amount) > 0;
    if (appIsPaidRow) downloadURL = null;

    // Checksum is metadata, not a capability: normalise to sha256:<hex>.
    let checksum: string | null = file?.checksum || file?.sha256 || null;
    if (checksum && /^[0-9a-f]{64}$/i.test(String(checksum))) checksum = `sha256:${String(checksum).toLowerCase()}`;

    const releaseNotes = (()=>{ try { const n = JSON.parse(release?.release_notes || '[]'); return Array.isArray(n) ? n : [String(n)]; } catch { return release?.release_notes ? [release.release_notes] : []; } })();

    return {
      appId: app.id,
      app: app.name,
      slug,
      currentVersion,
      latestVersion: app.current_version,
      platform: plat,
      architecture: arch,
      channel: channelOut,
      updateAvailable: true,
      // app_versions.mandatory is the synced publish flag; a version below the
      // release's minimum supported version is also treated as mandatory.
      mandatory: !!release?.mandatory || belowMinimum,
      minimumSupportedVersion,
      updateRequired: belowMinimum,
      releaseNotes,
      fileSize: file?.size || file?.file_size || null,
      checksum,
      storeUrl,
      deepLink,
      checkedAt,
      // Binary access stays inside RX Store: present for FREE apps (public
      // packages), always null for paid ones (entitlement + grant flow).
      downloadURL,
    };
  },
};

/**
 * Version comparison is centralized in services/releases.ts (SemVer-aware).
 * The previous local implementation could not distinguish a prerelease from a
 * final release (`1.3.0-beta` and `1.3.0` both parsed to [1,3,0] and compared
 * equal), which could suppress a legitimate update.
 */
function compareVersions(a: string, b: string): number {
  return compareSemver(a, b);
}
