/**
 * /library — the user's installed applications (Phase 15 navigation).
 * 100% backed by the EXISTING device-aware installation system:
 *   - this device: native detection is authoritative (Prompt 1–5 rules)
 *   - other devices: DeviceContext last-known installations
 * No frontend-invented installation state anywhere.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Library as LibraryIcon, CloudOff, Monitor, Smartphone, RefreshCw, ArrowLeft } from 'lucide-react';
import { useApps } from '../context/AppContext';
import { useDevices } from '../context/DeviceContext';
import { useInstalledState } from '../platform/nativeDetection';
import { installStateStatus } from '../native/installUi';
import AppLogo from '../components/apps/AppLogo';
import { formatDate } from '../utils/helpers';

/**
 * One installed row for THIS device — native detection decides. Rows where
 * detection says "not installed" render nothing (the Library is reality, not
 * a wish list). While detection is unavailable the row shows the honest state.
 */
function InstalledRow({ app }: { app: any }) {
  const { state, installed, detection } = useInstalledState(app);
  if (!installed && !['UPDATE_AVAILABLE', 'INSTALLING', 'UPDATING', 'INSTALL_FAILED', 'UPDATE_FAILED'].includes(state)) return null;
  const label = installed
    ? (state === 'UPDATE_AVAILABLE' ? 'Update available' : 'Installed')
    : installStateStatus(state as any) || String(state).replace(/_/g, ' ').toLowerCase();
  return (
    <Link to={`/app/${app.slug}`} className="card p-4 flex items-center gap-4 hover:bg-white/[0.03] transition-colors">
      <AppLogo app={app} size="w-14 h-14" />
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-white truncate">{app.name}</p>
        <p className="text-xs text-rx-gray-medium mt-0.5">
          {detection?.version ? `v${detection.version} · ` : ''}{label}
        </p>
      </div>
      {installed && <span className="text-[10px] font-bold px-2 py-1 rounded bg-green-400/10 text-green-400">THIS DEVICE</span>}
    </Link>
  );
}

export default function Library() {
  const { apps, isLoading } = useApps();
  const { installations, devices, currentDevice, offline, syncNow } = useDevices();
  const [thisDeviceApps, setThisDeviceApps] = useState<any[]>([]);
  const [scanning, setScanning] = useState(true);

  // The catalog feeds rows that self-report native detection state — the same
  // authoritative source the storefront cards use (no parallel system).
  useEffect(() => {
    setScanning(isLoading);
    setThisDeviceApps(apps.slice(0, 100));
  }, [apps, isLoading]);

  // Other-device installations come from the backend (last-known state).
  const otherDeviceInstalls = installations.filter((i: any) => i.deviceId !== currentDevice?.deviceId && i.status === 'installed');
  const otherApps = otherDeviceInstalls
    .map((inst: any) => ({ app: apps.find((a: any) => a.slug === inst.appSlug), inst }))
    .filter((x: any) => x.app);

  return (
    <div className="section-container max-w-4xl py-8 md:py-12">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl sm:text-3xl font-black text-white flex items-center gap-2.5">
            <LibraryIcon className="w-7 h-7 text-rx-yellow" /> My Library
          </h1>
          <p className="text-sm text-rx-gray-medium mt-2 max-w-xl">
            Applications on this device are detected from the operating system — not guessed.
            Items from your other devices show their last-known state.
          </p>
        </div>
        <button onClick={() => syncNow?.()} className="btn-secondary text-sm flex items-center gap-2">
          <RefreshCw className="w-4 h-4" /> Sync devices
        </button>
      </div>

      {offline && (
        <div className="mt-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-200 flex items-center gap-2">
          <CloudOff className="w-4 h-4" /> Offline — showing this device's native detection and cached data.
        </div>
      )}

      {/* This device */}
      <h2 className="text-sm font-bold text-white uppercase tracking-wider mt-10 mb-4 flex items-center gap-2">
        <Monitor className="w-4 h-4 text-rx-yellow" /> This device
      </h2>
      {isLoading || scanning ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="card p-4 h-[88px] animate-pulse" />)}</div>
      ) : thisDeviceApps.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-rx-gray-medium">Nothing detected as installed on this device yet.</p>
          <Link to="/browse" className="btn-primary text-sm mt-4 inline-block">Browse applications</Link>
        </div>
      ) : (
        <div className="space-y-3">
          {thisDeviceApps.map((app) => <InstalledRow key={app.id} app={app} />)}
        </div>
      )}

      {/* Other devices */}
      {otherApps.length > 0 && (
        <>
          <h2 className="text-sm font-bold text-white uppercase tracking-wider mt-10 mb-4 flex items-center gap-2">
            <Smartphone className="w-4 h-4 text-rx-yellow" /> Other devices
            <span className="text-rx-gray-medium font-normal normal-case">last known</span>
          </h2>
          <div className="space-y-3">
            {otherApps.map(({ app, inst }: any) => (
              <Link key={inst.id || app.id} to={`/app/${app.slug}`} className="card p-4 flex items-center gap-4 hover:bg-white/[0.03] transition-colors">
                <AppLogo app={app} size="w-14 h-14" />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-white truncate">{app.name}</p>
                  <p className="text-xs text-rx-gray-medium mt-0.5">
                    {inst.installedVersion ? `v${inst.installedVersion} · ` : ''}
                    {devices.find((d: any) => d.deviceId === inst.deviceId)?.deviceName || inst.deviceId || 'a device'}
                    {inst.lastDetectedAt ? ` · seen ${formatDate(inst.lastDetectedAt)}` : ''}
                  </p>
                </div>
                <span className="text-[10px] font-bold px-2 py-1 rounded bg-white/5 text-rx-gray-medium">LAST KNOWN</span>
              </Link>
            ))}
          </div>
        </>
      )}

      <Link to="/profile" className="inline-flex items-center gap-1.5 text-sm text-rx-gray-medium hover:text-white mt-10">
        <ArrowLeft className="w-4 h-4" /> Full account overview
      </Link>
    </div>
  );
}
