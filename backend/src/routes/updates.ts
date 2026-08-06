/**
 * Update Check Routes
 * 
 * GET /updates/check?app=clinical-rx&currentVersion=3.2.0&platform=windows
 * Returns update information if a newer version is available.
 */

export const updatesRoutes = {
  async checkUpdate(request: Request, env: any) {
    const url = new URL(request.url);
    const appId = url.searchParams.get('app');
    const currentVersion = url.searchParams.get('currentVersion');
    const platform = url.searchParams.get('platform');

    if (!appId || !currentVersion || !platform) {
      return { error: 'Missing required parameters: app, currentVersion, platform' };
    }

    const app = await env.DB.prepare('SELECT * FROM apps WHERE slug = ?').bind(appId).first();
    if (!app) return { error: 'Application not found' };

    // Compare versions
    const isUpdateAvailable = compareVersions(app.current_version, currentVersion) > 0;

    if (!isUpdateAvailable) {
      return {
        app: app.name,
        currentVersion,
        latestVersion: app.current_version,
        updateAvailable: false,
      };
    }

    // Get latest release info
    const release = await env.DB.prepare(
      'SELECT * FROM app_versions WHERE app_id = ? AND version = ? ORDER BY release_date DESC LIMIT 1'
    ).bind(app.id, app.current_version).first();

    const files = release?.files ? JSON.parse(release.files) : {};
    const file = files[platform];

    return {
      app: app.name,
      currentVersion,
      latestVersion: app.current_version,
      updateAvailable: true,
      downloadURL: file?.url || null,
      mandatory: release?.mandatory || false,
      releaseNotes: release?.release_notes || [],
      fileSize: file?.size || null,
      checksum: file?.checksum || null,
    };
  },
};

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}
