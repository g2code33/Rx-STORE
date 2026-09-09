/**
 * Device + Installation Routes (Authenticated).
 *
 * Each RX Store client (Electron desktop, Android Capacitor, web/PWA) owns a
 * persistent device identity. This module lets an authenticated user:
 *   - register / update the current device
 *   - heartbeat (update `last_seen_at`)
 *   - list their own devices
 *   - revoke one of their own devices
 *   - report the current device's per-application installation state
 *   - list installation state across all of their devices
 *
 * CRITICAL RULE: the cloud is LAST-KNOWN info for *other* devices. The local
 * device's native detection is authoritative for the current device. The
 * frontend enforces this by only trusting `detect` for the current device and
 * using this data purely to say "installed on N other devices".
 *
 * ALL queries are scoped to the authenticated user — a user can only ever see
 * their own devices and installations.
 */

async function ensureDeviceTables(env: any): Promise<void> {
  // Lazy, idempotent — matches the existing convention (settings table).
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS devices (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       device_name TEXT,
       platform TEXT,
       device_type TEXT,
       os_version TEXT,
       rx_store_version TEXT,
       app_version TEXT,
       last_seen_at TEXT DEFAULT (datetime('now')),
       created_at TEXT DEFAULT (datetime('now')),
       updated_at TEXT DEFAULT (datetime('now')),
       revoked_at TEXT,
       status TEXT DEFAULT 'active' CHECK (status IN ('active','revoked'))
     )`
  ).run().catch(() => {});
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS app_installations (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       device_id TEXT NOT NULL,
       application_id TEXT NOT NULL,
       platform TEXT,
       installed_version TEXT,
       status TEXT DEFAULT 'not_installed',
       detection_source TEXT,
       last_detected_at TEXT,
       installed_at TEXT,
       updated_at TEXT DEFAULT (datetime('now')),
       UNIQUE(device_id, application_id)
     )`
  ).run().catch(() => {});
  // Best-effort robust idempotent index creation.
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id)').run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_app_installations_user ON app_installations(user_id)').run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_app_installations_device ON app_installations(device_id)').run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_app_installations_app ON app_installations(application_id)').run().catch(() => {});
}

function userIdOf(request: Request): string | null {
  return ((request as any).user as any)?.userId || null;
}

function normDeviceType(raw: any): string {
  const t = String(raw || 'desktop').toLowerCase();
  return ['phone', 'tablet', 'desktop', 'pwa'].includes(t) ? t : 'desktop';
}

function normPlatform(raw: any): string {
  const p = String(raw || 'web').toLowerCase();
  return ['windows', 'linux', 'android', 'web'].includes(p) ? p : 'web';
}

export const devicesRoutes = {
  /** POST /devices/register — create or upsert the current device. */
  async register(request: Request, env: any) {
    await ensureDeviceTables(env);
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const body: any = await request.json().catch(() => ({}));
    const deviceId = String(body.deviceId || '').trim();
    if (!deviceId || deviceId.length > 128) return { error: 'A valid deviceId is required', code: 'VALIDATION_ERROR' };

    const now = new Date().toISOString();
    try {
      await env.DB.prepare(
        `INSERT INTO devices (id, user_id, device_name, platform, device_type, os_version, rx_store_version, app_version, last_seen_at, created_at, updated_at, status)
         VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'),datetime('now'),'active')
         ON CONFLICT(id) DO UPDATE SET
           user_id=excluded.user_id,
           device_name=COALESCE(excluded.device_name, devices.device_name),
           platform=COALESCE(excluded.platform, devices.platform),
           device_type=COALESCE(excluded.device_type, devices.device_type),
           os_version=COALESCE(excluded.os_version, devices.os_version),
           rx_store_version=COALESCE(excluded.rx_store_version, devices.rx_store_version),
           app_version=COALESCE(excluded.app_version, devices.app_version),
           last_seen_at=datetime('now'),
           updated_at=datetime('now'),
           revoked_at=NULL,
           status='active'`
      ).bind(
        deviceId,
        userId,
        String(body.deviceName || '') || null,
        normPlatform(body.platform),
        normDeviceType(body.deviceType),
        String(body.osVersion || '') || null,
        String(body.rxStoreVersion || body.rx_store_version || '') || null,
        String(body.appVersion || '') || null,
      ).run();
    } catch (e: any) {
      // DB may lack the FK to users on older schemas — still record without it.
      if (String(e?.message || '').includes('FOREIGN KEY')) {
        await env.DB.prepare(
          `INSERT INTO devices (id, user_id, device_name, platform, device_type, os_version, rx_store_version, app_version, last_seen_at, created_at, updated_at, status)
           VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'),datetime('now'),'active')
           ON CONFLICT(id) DO UPDATE SET last_seen_at=datetime('now'), updated_at=datetime('now'), status='active'`
        ).bind(deviceId, userId, null, normPlatform(body.platform), normDeviceType(body.deviceType), null, null, null).run();
      } else throw e;
    }
    const device: any = await env.DB.prepare('SELECT * FROM devices WHERE id=? AND user_id=?').bind(deviceId, userId).first();
    return { device };
  },

  /** POST /devices/heartbeat — bump `last_seen_at` for the current device. */
  async heartbeat(request: Request, env: any) {
    await ensureDeviceTables(env);
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const body: any = await request.json().catch(() => ({}));
    const deviceId = String(body.deviceId || '').trim();
    if (!deviceId) return { error: 'deviceId required', code: 'VALIDATION_ERROR' };
    const res: any = await env.DB.prepare(
      `UPDATE devices SET last_seen_at=datetime('now'), updated_at=datetime('now'),
        rx_store_version=COALESCE(?, rx_store_version), app_version=COALESCE(?, app_version)
       WHERE id=? AND user_id=? AND status='active'`
    ).bind(
      String(body.rxStoreVersion || body.rx_store_version || '') || null,
      String(body.appVersion || '') || null,
      deviceId,
      userId,
    ).run().catch(() => ({ meta: { changes: 0 } }));
    return { updated: (res?.meta?.changes || 0) > 0 };
  },

  /** GET /devices — list the user's own devices. */
  async listDevices(request: Request, env: any) {
    await ensureDeviceTables(env);
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const rows: any = await env.DB.prepare(
      `SELECT id, device_name, platform, device_type, os_version, rx_store_version, app_version, last_seen_at, created_at, status, revoked_at
       FROM devices WHERE user_id=? ORDER BY last_seen_at DESC`
    ).bind(userId).all();
    return { devices: rows.results || [] };
  },

  /** POST /devices/:id/revoke — revoke one of the user's devices. */
  async revokeDevice(request: Request, env: any) {
    await ensureDeviceTables(env);
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const id = new URL(request.url).pathname.split('/').filter(Boolean).pop() || '';
    if (!id) return { error: 'deviceId required', code: 'VALIDATION_ERROR' };
    const res: any = await env.DB.prepare(
      `UPDATE devices SET status='revoked', revoked_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND user_id=?`
    ).bind(id, userId).run().catch(() => ({ meta: { changes: 0 } }));
    if (!(res?.meta?.changes > 0)) return { error: 'Device not found or already revoked', code: 'NOT_FOUND' };
    return { revoked: true, deviceId: id };
  },

  /**
   * POST /devices/installations — upsert the current device's installation state
   * for a single application. Idempotent: one record per (device, application).
   */
  async reportInstallation(request: Request, env: any) {
    await ensureDeviceTables(env);
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const body: any = await request.json().catch(() => ({}));
    const deviceId = String(body.deviceId || '').trim();
    const appSlug = String(body.appSlug || body.slug || body.applicationId || '').trim();
    if (!deviceId || !appSlug) return { error: 'deviceId and appSlug are required', code: 'VALIDATION_ERROR' };

    // Resolve the application id from the slug (or accept an explicit id).
    let appId = String(body.applicationId || '').trim();
    if (!appId) {
      const ap: any = await env.DB.prepare('SELECT id FROM applications WHERE slug=?').bind(appSlug).first().catch(() => null);
      if (!ap) return { error: 'Unknown application', code: 'NOT_FOUND' };
      appId = ap.id;
    }

    const installed = !!body.installed;
    const version = String(body.installedVersion || body.version || '') || null;
    const status = String(body.status || (installed ? 'installed' : 'not_installed')) || 'not_installed';
    const source = String(body.detectionSource || body.source || '') || null;
    const now = new Date().toISOString();

    try {
      await env.DB.prepare(
        `INSERT INTO app_installations (id, user_id, device_id, application_id, platform, installed_version, status, detection_source, last_detected_at, installed_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,datetime('now'),CASE WHEN ?='installed' OR ?='installed' THEN datetime('now') ELSE NULL END,datetime('now'))
         ON CONFLICT(device_id, application_id) DO UPDATE SET
           user_id=excluded.user_id,
           platform=COALESCE(excluded.platform, app_installations.platform),
           installed_version=excluded.installed_version,
           status=excluded.status,
           detection_source=COALESCE(excluded.detection_source, app_installations.detection_source),
           last_detected_at=datetime('now'),
           installed_at=CASE WHEN excluded.status='installed' THEN COALESCE(app_installations.installed_at, datetime('now')) ELSE NULL END,
           updated_at=datetime('now')`
      ).bind(
        `ai_${deviceId}_${appId}`.slice(0, 120),
        userId,
        deviceId,
        appId,
        normPlatform(body.platform),
        version,
        status,
        source,
        status,
        status,
      ).run();
    } catch (e: any) {
      if (String(e?.message || '').includes('FOREIGN KEY')) return { error: 'Device not registered for this user, or unknown application', code: 'NOT_FOUND' };
      throw e;
    }
    const row: any = await env.DB.prepare(
      `SELECT i.*, a.slug as app_slug, a.name as app_name
       FROM app_installations i JOIN applications a ON a.id=i.application_id
       WHERE i.device_id=? AND i.application_id=? AND i.user_id=?`
    ).bind(deviceId, appId, userId).first();
    return { installation: row };
  },

  /** GET /devices/installations — list installation state across the user's devices. */
  async listInstallations(request: Request, env: any) {
    await ensureDeviceTables(env);
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const rows: any = await env.DB.prepare(
      `SELECT i.*, a.slug as app_slug, a.name as app_name, d.device_name, d.platform as device_platform, d.device_type
       FROM app_installations i
       JOIN applications a ON a.id=i.application_id
       JOIN devices d ON d.id=i.device_id
       WHERE i.user_id=? AND d.status='active'
       ORDER BY i.updated_at DESC`
    ).bind(userId).all();
    return { installations: rows.results || [] };
  },
};
