/**
 * /library — My Apps (Phase 16).
 *
 * Tabs: Installed · Updates · Available · Previous apps — all from REAL data:
 *   - this device: NATIVE detection is authoritative (bulk pass with
 *     detectionState(), refreshed after installs/uninstalls)
 *   - other devices: backend last-known installations (DeviceContext)
 *   - previous apps: installation records whose status is not_installed
 *   - available/unsupported: the app's published platform availability
 * The install queue (real, sequential, retryable) drives installs from here.
 * Offline: server-derived sections are marked "last known" — never faked.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Library as LibraryIcon, CloudOff, Monitor, Smartphone, RefreshCw, ArrowLeft,
  Download, RotateCw, XCircle, ArrowUpCircle, Ban, AlertCircle,
} from 'lucide-react';
import { useApps } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useDevices } from '../context/DeviceContext';
import { detectInstalledApp, detectionState } from '../platform/nativeDetection';
import { classifyLibraryApp, type LibraryClassification } from '../native/libraryClassification';
import { useInstallQueue, getInstallQueue, type QueueItem } from '../native/installQueue';
import { api, isApiConfigured } from '../services/api';
import AppLogo from '../components/apps/AppLogo';
import { getRuntimePlatform } from '../native/deviceIdentity';
import toast from 'react-hot-toast';

type Tab = 'installed' | 'updates' | 'available' | 'previous';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'installed', label: 'Installed' },
  { id: 'updates', label: 'Updates' },
  { id: 'available', label: 'Available' },
  { id: 'previous', label: 'Previous apps' },
];

interface Row {
  app: any;
  base: LibraryClassification;
  /** Live native detection for THIS device (authoritative). */
  thisInstalled: boolean;
  thisUpdate: boolean;
  detectedVersion?: string;
  usage: number;
}

export default function Library() {
  const { apps, isLoading } = useApps();
  const { user } = useAuth();
  const { installations, devices, currentDevice, offline, syncNow } = useDevices();
  const { items: queueItems } = useInstallQueue();
  const [tab, setTab] = useState<Tab>('installed');
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [detectPass, setDetectPass] = useState(0); // bump to re-run native detection

  const runtimePlatform = useMemo(() => {
    try { return getRuntimePlatform(); } catch { return 'web' as const; }
  }, []);

  // Real usage data (the user's download ledger) — only what exists.
  useEffect(() => {
    if (!user || !isApiConfigured()) return;
    api.devices.appHistory().then((d: any) => {
      const map: Record<string, number> = {};
      for (const h of d?.history || []) map[h.appSlug] = Number(h.downloads) || 0;
      setUsage(map);
    }).catch(() => {});
  }, [user?.id]);

  // ---- Bulk native detection for THIS device (authoritative) ----
  const [thisDevice, setThisDevice] = useState<Record<string, { installed: boolean; update: boolean; version?: string }>>({});
  useEffect(() => {
    let alive = true;
    if (!apps.length) return;
    (async () => {
      const out: Record<string, { installed: boolean; update: boolean; version?: string }> = {};
      for (const app of apps.slice(0, 80)) {
        try {
          const d = await detectInstalledApp(app);
          const state = detectionState(app.version, !!d?.installed, d?.version);
          out[app.slug] = { installed: !!d?.installed, update: state === 'UPDATE_AVAILABLE', version: d?.version };
        } catch {
          out[app.slug] = { installed: false, update: false };
        }
      }
      if (alive) setThisDevice(out);
    })();
    return () => { alive = false; };
  }, [apps, detectPass]);

  // Re-run detection when the queue finishes something.
  useEffect(() => {
    const anyDone = queueItems.some((q) => q.state === 'installed');
    if (anyDone) setDetectPass((n) => n + 1);
  }, [queueItems.filter((q) => q.state === 'installed').length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Classification ----
  const rows: Row[] = useMemo(() => {
    return apps.map((app: any) => {
      const base = classifyLibraryApp({
        app,
        thisDevice: { installed: false, updateAvailable: false },
        installations, currentDeviceId: currentDevice?.deviceId, runtimePlatform,
      });
      const d = thisDevice[app.slug];
      return {
        app, base,
        thisInstalled: !!d?.installed,
        thisUpdate: !!d?.update,
        detectedVersion: d?.version,
        usage: usage[app.slug] || 0,
      };
    });
  }, [apps, installations, currentDevice?.deviceId, runtimePlatform, usage, thisDevice]);

  const lists = useMemo(() => ({
    installed: rows.filter((r) => r.thisInstalled || r.base.otherDeviceIds.length > 0),
    updates: rows.filter((r) => r.thisUpdate || r.base.otherDeviceUpdate),
    available: rows.filter((r) => !r.thisInstalled && r.base.otherDeviceIds.length === 0 && !r.base.previouslyInstalled),
    previous: rows.filter((r) => r.base.previouslyInstalled),
  }), [rows]);

  const queueBySlug = useMemo(() => {
    const map: Record<string, QueueItem> = {};
    for (const q of queueItems) if (q.state !== 'installed') map[q.slug] = q;
    return map;
  }, [queueItems]);

  const activeQueue = queueItems.filter((q) => q.state !== 'installed');

  const enqueue = useCallback((app: any) => {
    const ok = getInstallQueue().enqueue({ slug: app.slug, name: app.name, icon: app.icon, gradient: app.gradient, version: app.version });
    if (ok) toast.success(`${app.name} queued for install`);
    else toast('Already queued or installing', { icon: 'ℹ️' });
  }, []);

  const deviceName = useCallback((id: string) =>
    devices.find((d: any) => d.deviceId === id)?.deviceName || 'another device', [devices]);

  const refreshAll = () => { syncNow?.(); setDetectPass((n) => n + 1); };

  return (
    <div className="section-container max-w-4xl py-8 md:py-12">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl sm:text-3xl font-black text-white flex items-center gap-2.5">
            <LibraryIcon className="w-7 h-7 text-rx-yellow" /> My Apps
          </h1>
          <p className="text-sm text-rx-gray-medium mt-2 max-w-xl">
            This device is detected from the operating system — other devices show their last known state.
          </p>
        </div>
        <button onClick={refreshAll} className="btn-secondary text-sm flex items-center gap-2">
          <RefreshCw className="w-4 h-4" /> Sync devices
        </button>
      </div>

      {offline && (
        <div className="mt-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-200 flex items-center gap-2">
          <CloudOff className="w-4 h-4" /> Offline — showing this device's native detection and last-known data. Queued installs resume when you reconnect.
        </div>
      )}

      {/* Install queue (real states + progress + retry/cancel) */}
      {activeQueue.length > 0 && (
        <div className="card p-4 mt-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
              <Download className="w-4 h-4 text-rx-yellow" /> Install queue
            </h2>
            {activeQueue.every((q) => ['failed', 'cancelled'].includes(q.state)) && (
              <button onClick={() => getInstallQueue().clearFinished()} className="text-xs text-rx-gray-medium hover:text-white">Clear finished</button>
            )}
          </div>
          <div className="space-y-2.5">
            {activeQueue.map((q) => (
              <div key={q.id} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-white truncate">{q.name}</p>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded whitespace-nowrap capitalize ${
                      q.state === 'failed' ? 'bg-red-400/10 text-red-400' :
                      q.state === 'cancelled' ? 'bg-white/5 text-rx-gray-medium' :
                      'bg-blue-400/10 text-blue-300'}`}>
                      {q.state === 'downloading' && typeof q.progress === 'number' ? `Downloading ${q.progress}%` : q.state}
                    </span>
                  </div>
                  {q.state === 'downloading' && (
                    <div className="h-1.5 bg-white/5 rounded-full overflow-hidden mt-1.5">
                      <div className="h-full bg-rx-yellow transition-all" style={{ width: `${q.progress ?? 0}%` }} />
                    </div>
                  )}
                  {q.state === 'failed' && q.error && (
                    <p className="text-[11px] text-red-400/90 mt-1 flex items-start gap-1.5"><AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" /> {q.error}</p>
                  )}
                </div>
                {['failed', 'cancelled'].includes(q.state) ? (
                  <div className="flex gap-1.5">
                    <button onClick={() => getInstallQueue().retry(q.id)} className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5"><RotateCw className="w-3.5 h-3.5" /> Retry</button>
                    <button onClick={() => getInstallQueue().cancel(q.id)} className="text-xs px-2 py-1.5 rounded-lg text-rx-gray-medium hover:text-white" title="Dismiss"><XCircle className="w-4 h-4" /></button>
                  </div>
                ) : ['queued', 'downloading'].includes(q.state) ? (
                  <button onClick={() => getInstallQueue().cancel(q.id)} className="text-xs px-2 py-1.5 rounded-lg text-rx-gray-medium hover:text-red-400" title="Cancel"><XCircle className="w-4 h-4" /></button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-rx-dark-secondary rounded-xl p-1 w-fit mt-8 overflow-x-auto max-w-full">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3.5 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all whitespace-nowrap ${tab === t.id ? 'bg-rx-yellow text-rx-dark' : 'text-rx-gray-medium hover:text-white'}`}>
            {t.label}{lists[t.id]?.length ? ` (${lists[t.id].length})` : ''}
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-3">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <div key={i} className="card p-4 h-[88px] animate-pulse" />)
        ) : lists[tab].length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-sm text-rx-gray-medium">
              {tab === 'installed' && 'Nothing installed yet — apps you install appear here.'}
              {tab === 'updates' && 'No updates available right now.'}
              {tab === 'available' && (apps.length ? 'Every available app is already installed or in your history.' : 'No apps in the catalog yet.')}
              {tab === 'previous' && 'No previous installations. Apps you uninstall stay listed here for easy restore.'}
            </p>
            {(tab === 'available' || tab === 'installed') && <Link to="/browse" className="btn-primary text-sm mt-4 inline-block">Browse applications</Link>}
          </div>
        ) : (
          lists[tab].map((r) => {
            const q = queueBySlug[r.app.slug];
            const otherCount = r.base.otherDeviceIds.length;
            return (
              <div key={r.app.id} className="card p-4 flex flex-wrap items-center gap-3">
                <Link to={`/app/${r.app.slug}`} className="flex items-center gap-4 flex-1 min-w-[200px] group">
                  <AppLogo app={r.app} size="w-14 h-14" />
                  <div className="min-w-0">
                    <p className="font-semibold text-white truncate group-hover:text-rx-yellow transition-colors">{r.app.name}</p>
                    <p className="text-xs text-rx-gray-medium mt-0.5 truncate">
                      {r.thisInstalled && <>{r.detectedVersion ? `v${r.detectedVersion} · ` : ''}{r.thisUpdate ? 'Update available' : 'Installed'}</>}
                      {!r.thisInstalled && otherCount > 0 && (otherCount === 1 ? `On ${deviceName(r.base.otherDeviceIds[0])}` : `On ${otherCount} of your devices`)}
                      {!r.thisInstalled && otherCount === 0 && (r.base.previouslyInstalled ? 'Previously installed' : r.app.description)}
                    </p>
                  </div>
                </Link>

                <div className="flex items-center gap-2 flex-wrap">
                  {/* Live queue state */}
                  {q && ['queued', 'downloading', 'verifying', 'installing'].includes(q.state) && (
                    <span className="text-[10px] font-bold px-2 py-1 rounded bg-blue-400/10 text-blue-300 capitalize">
                      {q.state === 'downloading' && typeof q.progress === 'number' ? `${q.progress}%` : q.state}
                    </span>
                  )}
                  {q?.state === 'failed' && (
                    <button onClick={() => getInstallQueue().retry(q.id)} title={q.error}
                      className="text-[10px] font-bold px-2 py-1 rounded bg-red-400/10 text-red-400 flex items-center gap-1 hover:bg-red-400/20">
                      <RotateCw className="w-3 h-3" /> Retry
                    </button>
                  )}
                  {/* Device-awareness badges */}
                  {r.thisInstalled && (
                    <span className={`text-[10px] font-bold px-2 py-1 rounded flex items-center gap-1 ${r.thisUpdate ? 'bg-rx-yellow/10 text-rx-yellow' : 'bg-green-400/10 text-green-400'}`}>
                      {r.thisUpdate ? <><ArrowUpCircle className="w-3 h-3" /> Update</> : <><Monitor className="w-3 h-3" /> This device</>}
                    </span>
                  )}
                  {otherCount > 0 && !r.thisInstalled && (
                    <span className="text-[10px] font-bold px-2 py-1 rounded bg-white/5 text-rx-gray-medium flex items-center gap-1"><Smartphone className="w-3 h-3" /> Other device{otherCount > 1 ? 's' : ''}</span>
                  )}
                  {!r.base.supportedOnThisPlatform && (
                    <span className="text-[10px] font-bold px-2 py-1 rounded bg-white/5 text-rx-gray-medium/70 flex items-center gap-1"><Ban className="w-3 h-3" /> Not on this platform</span>
                  )}
                  {/* Actions */}
                  {r.thisUpdate && (
                    <Link to={`/app/${r.app.slug}`} className="btn-primary text-xs px-3 py-1.5">Update</Link>
                  )}
                  {!r.thisInstalled && r.base.supportedOnThisPlatform && !q && (
                    <button onClick={() => enqueue(r.app)} className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5"><Download className="w-3.5 h-3.5" /> Get</button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Unsupported count note on the Available tab */}
      {tab === 'available' && (() => {
        const unsupported = rows.filter((r) => !r.thisInstalled && r.base.otherDeviceIds.length === 0 && !r.base.previouslyInstalled && !r.base.supportedOnThisPlatform);
        return unsupported.length ? (
          <p className="text-[11px] text-rx-gray-medium/70 mt-4 flex items-center gap-1.5">
            <Ban className="w-3.5 h-3.5" /> {unsupported.length} more app{unsupported.length === 1 ? '' : 's'} not shown — not published for this platform.
          </p>
        ) : null;
      })()}

      <Link to="/profile" className="inline-flex items-center gap-1.5 text-sm text-rx-gray-medium hover:text-white mt-10">
        <ArrowLeft className="w-4 h-4" /> Full account overview
      </Link>
    </div>
  );
}
