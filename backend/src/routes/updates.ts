/**
 * Update Check Routes
 * 
 * GET /updates/check?app=clinical-rx&currentVersion=3.2.0&platform=windows
 * Returns update information if a newer version is available.
 */

import { compareSemver } from '../services/releases';

export const updatesRoutes = {
  async checkUpdate(request: Request, env: any) {
    const url = new URL(request.url);
    const appId = url.searchParams.get('app');
    const currentVersion = url.searchParams.get('currentVersion');
    const platform = url.searchParams.get('platform');

    if (!appId || !currentVersion || !platform) {
      return { error: 'Missing required parameters: app, currentVersion, platform' };
    }

    let plat = String(platform).toLowerCase();
    if (plat === 'deb') plat = 'linux_deb';
    if (plat === 'appimage') plat = 'linux_appimage';

    const app = await env.DB.prepare('SELECT * FROM applications WHERE slug = ?').bind(appId).first().catch(()=>null);
    if (!app) return { error: 'Application not found' };

    // Compare versions
    const isUpdateAvailable = compareVersions(app.current_version || '0.0.0', currentVersion) > 0;

    if (!isUpdateAvailable) {
      return {
        app: app.name,
        currentVersion,
        latestVersion: app.current_version,
        updateAvailable: false,
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

    return {
      app: app.name,
      currentVersion,
      latestVersion: app.current_version,
      updateAvailable: true,
      downloadURL,
      mandatory: !!release?.mandatory,
      releaseNotes: (()=>{ try { const n = JSON.parse(release?.release_notes || '[]'); return Array.isArray(n) ? n : [String(n)]; } catch { return release?.release_notes ? [release.release_notes] : []; } })(),
      fileSize: file?.size || file?.file_size || null,
      checksum: file?.checksum || file?.sha256 || null,
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
