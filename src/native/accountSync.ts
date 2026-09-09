/**
 * RX Store — account-aware device/installation synchronization.
 *
 * Bridges the stable device identity (deviceIdentity.ts) with the backend
 * (/devices/*). The backend stores LAST-KNOWN state for OTHER devices; the
 * local device's native detection stays authoritative (see detect.ts).
 *
 * All calls are best-effort and never block/break the UI when offline. The
 * detail of "current device vs other devices" is resolved by detect.ts.
 */
import { api, isApiConfigured } from '../services/api';
import { buildDeviceRecord, getDeviceId, getRuntimePlatform } from './deviceIdentity';
import { installStatusForReport, type InstallState } from '../platform/detect';
import type { AppInstallation, Device } from '../types/device';

/** Register + heartbeat the current device for the subscribed account. */
export async function syncDeviceOnAuth(rxStoreVersion?: string): Promise<{ deviceId: string } | null> {
  if (!isApiConfigured()) return null;
  const rec = buildDeviceRecord(rxStoreVersion);
  try {
    await api.devices.register({
      deviceId: rec.deviceId,
      deviceName: rec.deviceName,
      platform: rec.platform,
      deviceType: rec.deviceType,
      osVersion: rec.osVersion,
      rxStoreVersion: rec.rxStoreVersion,
      appVersion: rec.rxStoreVersion,
    });
    return { deviceId: rec.deviceId };
  } catch {
    return null;
  }
}

/** Best-effort heartbeat for a signed-in user. */
export async function heartbeatDevice(rxStoreVersion?: string): Promise<void> {
  if (!isApiConfigured()) return;
  try {
    await api.devices.heartbeat(getDeviceId(), rxStoreVersion, rxStoreVersion);
  } catch { /* offline is fine */ }
}

/**
 * Report the CURRENT device's installation state for an application. Only called
 * after a real native operation + re-detection, so the backend reflects
 * confirmed state rather than "an installer was launched".
 */
export async function reportCurrentInstallation(input: {
  appSlug: string;
  platform?: string;
  installed: boolean;
  installedVersion?: string;
  status: InstallState;
  detectionSource?: string;
}): Promise<void> {
  if (!isApiConfigured()) return;
  try {
    await api.devices.reportInstallation({
      deviceId: getDeviceId(),
      appSlug: input.appSlug,
      platform: input.platform || getRuntimePlatform(),
      installed: input.installed,
      installedVersion: input.installedVersion,
      status: installStatusForReport(input.status),
      detectionSource: input.detectionSource,
    });
  } catch { /* best-effort */ }
}

/** Other-device installations for the signed-in user (last-known info, clean shape). */
export async function fetchOtherDeviceInstallations(): Promise<AppInstallation[]> {
  if (!isApiConfigured()) return [];
  try {
    const { installations } = await api.devices.listInstallations();
    return (installations || []).map((i: any) => ({
      deviceId: i.device_id || i.deviceId,
      appSlug: i.app_slug || i.appSlug,
      appName: i.app_name || i.appName,
      platform: i.device_platform || i.platform,
      installedVersion: i.installed_version || i.installedVersion,
      status: i.status,
      detectionSource: i.detection_source || i.detectionSource,
      deviceName: i.device_name || i.deviceName,
      lastDetectedAt: i.last_detected_at || i.lastDetectedAt,
      updatedAt: i.updated_at || i.updatedAt,
    }));
  } catch {
    return [];
  }
}

/** All of the user's devices (clean shape, current device flagged). */
export async function fetchMyDevices(): Promise<Device[]> {
  if (!isApiConfigured()) return [];
  try {
    const { devices } = await api.devices.list(getDeviceId());
    return (devices || []).map((d: any) => ({
      id: d.id,
      deviceId: d.deviceId || d.device_id,
      deviceName: d.deviceName || d.device_name || d.platform || 'Device',
      platform: d.platform || 'web',
      deviceType: d.deviceType || d.device_type || 'desktop',
      osVersion: d.osVersion || d.os_version || '',
      rxStoreVersion: d.rxStoreVersion || d.rx_store_version || '',
      lastSeenAt: d.lastSeenAt || d.last_seen_at || '',
      createdAt: d.createdAt || d.created_at || '',
      status: d.status || 'active',
      isCurrentDevice: !!(d.isCurrentDevice || (d.deviceId || d.device_id) === getDeviceId()),
    }));
  } catch {
    return [];
  }
}

export async function revokeDevice(deviceId: string): Promise<boolean> {
  if (!isApiConfigured()) return false;
  try {
    await api.devices.revoke(deviceId);
    return true;
  } catch {
    return false;
  }
}
