/**
 * First-launch restore — "Your apps, ready to go" (Phase 16).
 *
 * Shows ONCE per (user, device) when there is something REAL to restore:
 * apps installed on the user's OTHER devices or in their prior history, that
 * are published for this platform and not already installed here.
 *
 * Honesty rules:
 *   - No auto-install: nothing installs without explicit confirmation.
 *   - "Most used" appears ONLY when real usage data exists (the user's
 *     download ledger), ordering by factual signals only.
 *   - Not shown offline (we cannot start installs honestly while offline),
 *     for signed-out users, or when there is nothing to restore.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckSquare, Square, Download, X, Sparkles, MonitorSmartphone } from 'lucide-react';
import { useApps } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { useDevices } from '../../context/DeviceContext';
import { detectInstalledApp } from '../../platform/nativeDetection';
import {
  classifyLibraryApp, shouldShowFirstLaunch, orderRestoreCandidates,
  hasRealUsageData, type RestoreCandidate,
} from '../../native/libraryClassification';
import { getInstallQueue } from '../../native/installQueue';
import { getRuntimePlatform, getDeviceId } from '../../native/deviceIdentity';
import { api, isApiConfigured } from '../../services/api';
import AppLogo from '../apps/AppLogo';
import toast from 'react-hot-toast';

function markerKey(userId: string, deviceId: string): string {
  return `rx-first-launch-v1:${userId}:${deviceId}`;
}

function isDone(userId: string, deviceId: string): boolean {
  try { return localStorage.getItem(markerKey(userId, deviceId)) === 'done'; } catch { return false; }
}
function markDone(userId: string, deviceId: string) {
  try { localStorage.setItem(markerKey(userId, deviceId), 'done'); } catch { /* storage unavailable */ }
}

export default function FirstLaunch() {
  const { apps, isLoading } = useApps();
  const { user } = useAuth();
  const { installations, currentDevice, offline } = useDevices();
  const [candidates, setCandidates] = useState<RestoreCandidate[] | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [installing, setInstalling] = useState(false);

  const runtimePlatform = useMemo(() => {
    try { return getRuntimePlatform(); } catch { return 'web' as const; }
  }, []);

  useEffect(() => {
    if (!user || isLoading || !apps.length) return;
    let alive = true;

    (async () => {
      // Real usage data (download ledger) — absent when none exists.
      const usage: Record<string, number> = {};
      if (isApiConfigured()) {
        try {
          const d = await api.devices.appHistory();
          for (const h of d?.history || []) usage[h.appSlug] = Number(h.downloads) || 0;
        } catch { /* no usage data — fine */ }
      }

      const deviceId = (() => { try { return getDeviceId() || currentDevice?.deviceId || ''; } catch { return currentDevice?.deviceId || ''; } })();

      // Restorable = apps on OTHER devices or previously installed, supported
      // here, and NOT already installed on THIS device (native detection).
      const out: RestoreCandidate[] = [];
      for (const app of apps.slice(0, 80)) {
        const cls = classifyLibraryApp({
          app, thisDevice: { installed: false, updateAvailable: false },
          installations, currentDeviceId: deviceId, runtimePlatform,
        });
        const restorable = (cls.otherDeviceIds.length > 0 || cls.previouslyInstalled) && cls.supportedOnThisPlatform;
        if (!restorable) continue;
        let installedHere = false;
        try { installedHere = !!(await detectInstalledApp(app))?.installed; } catch { /* not installed */ }
        if (installedHere) continue;
        out.push({
          slug: app.slug, name: app.name, icon: app.icon, gradient: app.gradient, version: app.version,
          deviceCount: cls.otherDeviceIds.length,
          previouslyInstalled: cls.previouslyInstalled,
          userDownloads: usage[app.slug] || 0,
        });
      }
      if (!alive) return;
      setCandidates(orderRestoreCandidates(out));
      const defaults: Record<string, boolean> = {};
      for (const c of out) defaults[c.slug] = true;
      setSelected(defaults);
    })();

    return () => { alive = false; };
  }, [user?.id, isLoading, apps, installations, currentDevice?.deviceId, runtimePlatform]);

  if (!user || candidates === null) return null;

  const deviceId = (() => { try { return getDeviceId() || currentDevice?.deviceId || ''; } catch { return currentDevice?.deviceId || ''; } })();
  const show = shouldShowFirstLaunch({
    signedIn: !!user,
    offline,
    catalogLoaded: !isLoading,
    alreadyDone: isDone(user.id, deviceId),
    candidates,
  });
  if (!show) return null;

  const selectedList = candidates.filter((c) => selected[c.slug]);
  const allSelected = selectedList.length === candidates.length;
  const mostUsed = hasRealUsageData(candidates);

  const finish = () => {
    markDone(user.id, deviceId);
    setCandidates([]); // hides the overlay
  };

  const installSelected = () => {
    if (!selectedList.length) { finish(); return; }
    setInstalling(true);
    const queue = getInstallQueue();
    let queued = 0;
    for (const c of selectedList) {
      if (queue.enqueue({ slug: c.slug, name: c.name, icon: c.icon, gradient: c.gradient, version: c.version })) queued++;
    }
    markDone(user.id, deviceId);
    if (queued > 0) {
      toast.success(`${queued} app${queued === 1 ? '' : 's'} queued — watch progress in My Apps`);
      // Navigating to Library shows the live queue.
      window.location.assign('/library');
    } else {
      toast('Nothing new to install — apps are already queued', { icon: 'ℹ️' });
      setInstalling(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] bg-rx-dark/95 backdrop-blur-sm overflow-y-auto" role="dialog" aria-label="Restore your apps">
      <div className="min-h-full flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-lg card p-6 sm:p-8 relative">
          <button onClick={finish} aria-label="Skip" className="absolute top-4 right-4 p-1.5 rounded-lg text-rx-gray-medium hover:text-white hover:bg-white/10"><X className="w-4 h-4" /></button>

          <div className="w-12 h-12 rounded-2xl bg-rx-yellow/10 border border-rx-yellow/20 flex items-center justify-center">
            <Sparkles className="w-6 h-6 text-rx-yellow" />
          </div>
          <h2 className="text-2xl font-black text-white mt-4">Your apps, ready to go</h2>
          <p className="text-sm text-rx-gray-medium mt-1.5">
            Apps from your other devices and history — pick what to set up on this device.
          </p>

          {/* Select all */}
          <div className="flex items-center justify-between mt-6">
            <button
              onClick={() => {
                const nextAll: Record<string, boolean> = {};
                for (const c of candidates) nextAll[c.slug] = !allSelected;
                setSelected(nextAll);
              }}
              className="text-xs font-semibold text-rx-yellow hover:underline flex items-center gap-1.5"
            >
              {allSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
              {allSelected ? 'Deselect all' : 'Select all'}
            </button>
            <span className="text-xs text-rx-gray-medium">{selectedList.length} of {candidates.length} selected</span>
          </div>

          {/* Candidate list */}
          <div className="mt-3 space-y-2 max-h-[46vh] overflow-y-auto pr-1">
            {mostUsed && (
              <p className="text-[11px] uppercase tracking-wider font-bold text-rx-gray-medium pt-1">Most used</p>
            )}
            {candidates.map((c) => (
              <button
                key={c.slug}
                onClick={() => setSelected((s) => ({ ...s, [c.slug]: !s[c.slug] }))}
                className={`w-full p-3 rounded-xl border flex items-center gap-3 text-left transition-all ${selected[c.slug] ? 'bg-rx-yellow/5 border-rx-yellow/30' : 'bg-rx-dark-tertiary/40 border-white/5 hover:border-white/20'}`}
              >
                {selected[c.slug] ? <CheckSquare className="w-4 h-4 text-rx-yellow flex-shrink-0" /> : <Square className="w-4 h-4 text-rx-gray-medium flex-shrink-0" />}
                <AppLogo app={c} size="w-10 h-10" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{c.name}</p>
                  <p className="text-[11px] text-rx-gray-medium flex items-center gap-1">
                    {c.deviceCount > 0 ? <><MonitorSmartphone className="w-3 h-3" /> On {c.deviceCount} of your devices</> : 'Previously installed'}
                    {c.userDownloads ? ` · ${c.userDownloads} download${c.userDownloads === 1 ? '' : 's'}` : ''}
                  </p>
                </div>
              </button>
            ))}
          </div>

          {/* Actions — nothing installs without explicit confirmation */}
          <div className="flex flex-col sm:flex-row gap-2.5 mt-6">
            <button onClick={installSelected} disabled={installing || selectedList.length === 0}
              className="btn-primary flex-1 flex items-center justify-center gap-2 disabled:opacity-40">
              <Download className="w-4 h-4" />
              {installing ? 'Starting…' : selectedList.length ? `Install ${selectedList.length} app${selectedList.length === 1 ? '' : 's'}` : 'Install selected'}
            </button>
            <button onClick={finish} className="btn-secondary flex-1 sm:flex-none">Skip for now</button>
          </div>
          <p className="text-[11px] text-rx-gray-medium/70 mt-4 text-center">
            You can also <Link to="/library" onClick={finish} className="text-rx-yellow hover:underline">open My Apps</Link> anytime — nothing installs without your confirmation.
          </p>
        </div>
      </div>
    </div>
  );
}
