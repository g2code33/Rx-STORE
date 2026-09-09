/**
 * RX Store — account-aware device/installation synchronization.
 *
 * Bridges the stable device identity (deviceIdentity.ts) with the backend
 * (/devices/*). The backends stores LAST-KNOWN state for OTHER devices; the
 * local device's native detection stays authoritative (see detect.ts).
 *
 * All calls are best-effort and never block/break the UI when offline.
 */
import { api, isApiConfigured } from '../services/api';
import { buildDeviceRecord, getDeviceId } from './deviceIdentity';
import { installStatusForReport, type InstallState } from '../platform/detect';

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
      platform: input.platform,
      installed: input.installed,
      installedVersion: input.installedVersion,
      status: installStatusForReport(input.status),
      detectionSource: input.detectionSource,
    });
  } catch { /* best-effort */ }
}

/** Other-device installations for the signed-in user (last-known info). */
export async function fetchOtherDeviceInstallations(): Promise<{ deviceId: string; appSlug: string; status: string; installedVersion?: string }[]> {
  if (!isApiConfigured()) return [];
  try {
    const { installations } = await api.devices.listInstallations();
    return (installations || []).map((i: any) => ({
      deviceId: i.device_id || i.deviceId,
      appSlug: i.app_slug || i.appSlug,
      status: i.status,
      installedVersion: i.installed_version || i.installedVersion,
    }));
  } catch {
    return [];
  }
}

/** All of the user's devices (for "My Devices"). */
export async function fetchMyDevices(): Promise<any[]> {
  if (!isApiConfigured()) return [];
  try {
    const { devices } = await api.devices.list();
    return devices || [];
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
