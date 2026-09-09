/**
 * RX Store — account/device state layer.
 *
 * A clean, presentational-friendly store for:
 *   - the CURRENT device (stable identity + registered record)
 *   - all of the user's account devices
 *   - per-app installation state across the account's devices
 *   - the synchronization state (idle / syncing / synced / error / offline)
 *
 * The current-device native detection stays authoritative (see detect.ts);
 * this store supplies the OTHER-device last-known info for the UI.
 *
 * Components stay presentational and consume this via `useDevices()`; the
 * synchronization system is not embedded in AppCard.
 */
import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { isApiConfigured } from '../services/api';
import {
  syncDeviceOnAuth,
  heartbeatDevice,
  fetchMyDevices,
  fetchOtherDeviceInstallations,
  revokeDevice,
  reportCurrentInstallation,
} from '../native/accountSync';
import { buildDeviceRecord } from '../native/deviceIdentity';
import type { AppInstallation, Device } from '../types/device';
import type { InstallState } from '../platform/detect';

export type SyncState = 'idle' | 'syncing' | 'synced' | 'error' | 'offline';

interface DeviceContextType {
  /** The current device's stable record (identity + metadata). */
  currentDevice: ReturnType<typeof buildDeviceRecord>;
  /** All of the user's account devices (backend last-known, current flagged). */
  devices: Device[];
  /** Per-app installation state across the user's devices (backend last-known). */
  installations: AppInstallation[];
  syncState: SyncState;
  /** Force a re-register/heartbeat. */
  syncNow: () => Promise<void>;
  /** Re-fetch devices + installations from the backend. */
  refresh: () => Promise<void>;
  /** Revoke a device. */
  revoke: (deviceId: string) => Promise<boolean>;
  /** Report the current device's installation state for an app. */
  reportInstallation: (input: { appSlug: string; installed: boolean; installedVersion?: string; status: InstallState; detectionSource?: string }) => Promise<void>;
}

const DeviceContext = createContext<DeviceContextType | undefined>(undefined);

export function DeviceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [installations, setInstallations] = useState<AppInstallation[]>([]);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  // Memoized so the stable device id/record isn't re-derived every render.
  const currentDevice = React.useMemo(() => buildDeviceRecord(), []);

  const refresh = useCallback(async () => {
    if (!user?.id || !isApiConfigured()) { setSyncState('offline'); return; }
    setSyncState('syncing');
    try {
      const [devicesList, installs] = await Promise.all([fetchMyDevices(), fetchOtherDeviceInstallations()]);
      setDevices(devicesList);
      setInstallations(installs);
      setSyncState('synced');
    } catch {
      setSyncState('error');
    }
  }, [user?.id]);

  const syncNow = useCallback(async () => {
    if (!user?.id || !isApiConfigured()) { setSyncState('offline'); return; }
    setSyncState('syncing');
    // Register + heartbeat the current device, then pull the account view.
    const rec = await syncDeviceOnAuth();
    await heartbeatDevice();
    if (rec) await refresh();
    else setSyncState('error');
  }, [user?.id, refresh]);

  const revoke = useCallback(async (deviceId: string) => {
    const ok = await revokeDevice(deviceId);
    if (ok) await refresh();
    return ok;
  }, [refresh]);

  const reportInstallation = useCallback(async (input: {
    appSlug: string; installed: boolean; installedVersion?: string; status: InstallState; detectionSource?: string;
  }) => {
    await reportCurrentInstallation(input);
    // Best-effort refresh so the account view reflects the confirmed state.
    if (isApiConfigured()) void refresh();
  }, [refresh]);

  // Sync on user change + periodic background refresh to keep devices fresh.
  useEffect(() => {
    if (!user?.id) { setDevices([]); setInstallations([]); setSyncState('idle'); return; }
    void syncNow();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15 * 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [user?.id, syncNow, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <DeviceContext.Provider value={{ currentDevice, devices, installations, syncState, syncNow, refresh, revoke, reportInstallation }}>
      {children}
    </DeviceContext.Provider>
  );
}

export function useDevices() {
  const context = useContext(DeviceContext);
  if (context === undefined) throw new Error('useDevices must be used within a DeviceProvider');
  return context;
}
