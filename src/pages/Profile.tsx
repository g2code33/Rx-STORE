import React, { useState } from 'react';
import { Link, Navigate, useSearchParams, useLocation } from 'react-router-dom';
import { Download, CreditCard, Bell, Settings, LogOut, X, Trash2, RefreshCw, Rocket, Monitor, Smartphone, Globe, Laptop, UserCircle, Save, ShieldCheck, Link2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import { useApps } from '../context/AppContext';
import { useDevices } from '../context/DeviceContext';
import { useInstalledState } from '../platform/nativeDetection';
import { useNativeRuntime } from '../native/useNativeRuntime';
import { deviceActivity, mapDetectionToInstall } from '../platform/detect';
import { installStateStatus } from '../native/installUi';
import { formatDate } from '../utils/helpers';
import AppLogo from '../components/apps/AppLogo';
import { useUpdateStatus, describeStatus, checkNow, installNow, isDesktopApp, applyUpdatePolicy, watchConnectionForUpdatePolicy } from '../desktop/updater';
import { normalizeProfileTab, type ProfileTab } from '../utils/profileTabs';
import toast from 'react-hot-toast';

const DEFAULT_PREFERENCES = {
  emailNotifications: true,
  autoUpdate: true,
  wifiOnly: false,
  mobileDataUpdates: true,
};

/** An installed app row that uses native detection for state + real uninstall. */
function InstalledAppRow({ app, onReconcile }: { app: any; onReconcile: (appId: string) => void }) {
  const { state: detectedState, installed: osInstalled } = useInstalledState(app);
  const { uninstall } = useNativeRuntime();
  const [uninstalling, setUninstalling] = useState(false);
  const isNative = osInstalled || detectedState === 'INSTALLED_CURRENT' || detectedState === 'UPDATE_AVAILABLE';
  const status = installStateStatus(mapDetectionToInstall(detectedState));

  const doUninstall = async () => {
    if (!confirm(`Uninstall ${app.name}? Your operating system will ask you to confirm.`)) return;
    setUninstalling(true);
    try {
      await uninstall(app);
      toast.success(`${app.name} uninstalled`);
      onReconcile(app.id);
    } catch (e: any) {
      toast.error(e?.message || 'Could not uninstall the application');
    } finally {
      setUninstalling(false);
    }
  };

  return (
    <div className="card p-5 flex items-center gap-4 group">
      <AppLogo app={app} size="w-14 h-14" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Link to={`/app/${app.slug}`} className="font-semibold text-white hover:text-rx-yellow transition-colors truncate block">{app.name}</Link>
          {isNative && <span className="px-1.5 py-0.5 bg-white/10 text-rx-gray-medium text-[10px] font-bold rounded-md">NATIVE</span>}
        </div>
        <p className="text-xs text-rx-gray-medium">v{app.version} · {app.size} · <span className="text-white/70">{status}</span></p>
      </div>
      <button
        onClick={doUninstall}
        disabled={uninstalling}
        className="px-3 py-1.5 text-xs font-medium text-red-400 hover:text-white bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg transition-all flex items-center gap-1 disabled:opacity-50"
      >
        <X className="w-3 h-3" /> {uninstalling ? 'Uninstalling…' : 'Uninstall'}
      </button>
    </div>
  );
}

/** Desktop-only self-update management: version, live status, manual check, restart-to-install. */
function DesktopUpdatesCard() {
  const s = useUpdateStatus();
  if (!isDesktopApp()) return null;
  const d = describeStatus(s);
  const dot: Record<string, string> = { gray: 'bg-rx-gray-medium', yellow: 'bg-rx-yellow', green: 'bg-green-400', red: 'bg-red-400' };
  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-rx-yellow/15 flex items-center justify-center flex-shrink-0">
          <Rocket className="w-5 h-5 text-rx-yellow" />
        </div>
        <div>
          <h3 className="font-semibold text-white">Desktop App &amp; Updates</h3>
          <p className="text-xs text-rx-gray-medium">
            RX Store desktop {s.currentVersion ? `v${s.currentVersion}` : ''} · auto-checks every hour
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2 text-sm text-rx-gray-medium">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${dot[d.tone]}${d.busy ? ' animate-pulse' : ''}`} />
        <span className={d.tone === 'red' ? 'text-red-300' : d.tone === 'green' ? 'text-green-300' : ''}>{d.text}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => checkNow()} disabled={d.busy} className="btn-primary !py-2 !px-4 text-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
          <RefreshCw className={`w-4 h-4 ${d.busy ? 'animate-spin' : ''}`} />
          {s.phase === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
        {s.phase === 'downloaded' && (
          <button
            onClick={() => installNow()}
            className="px-4 py-2 text-sm font-semibold rounded-xl bg-green-500/20 text-green-300 border border-green-500/30 hover:bg-green-500/30 transition-all"
          >
            Restart &amp; update
          </button>
        )}
      </div>
      <p className="text-xs text-rx-gray-medium">
        New versions download silently and install when you're ready. Windows, Linux and the web all stay on the same release.
      </p>
    </div>
  );
}

export default function Profile() {
  const { user, isLoading: authLoading, logout, updateProfile, notifications, markNotificationRead } = useAuth();
  const { getAppById, installedApps, installApp, uninstallApp } = useApps();
  const { devices, syncNow, revoke, installations, offline, pendingSync, flushSync } = useDevices();
  // The URL is the source of truth for the active section (?tab=…), so account
  // links from the header/dropdown open their section directly and browser
  // back/forward moves between sections.
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const activeTab: ProfileTab = normalizeProfileTab(searchParams.get('tab'));
  const [profileForm, setProfileForm] = useState({ name: user?.name || '', email: user?.email || '' });
  const [preferences, setPreferences] = useState(() => ({ ...DEFAULT_PREFERENCES, ...(user?.preferences || {}) }));
  const [savingProfile, setSavingProfile] = useState(false);

  const setActiveTab = (tab: ProfileTab) => {
    setSearchParams(tab === 'apps' ? {} : { tab }, { replace: false });
  };

  React.useEffect(() => {
    if (!user) return;
    setProfileForm({ name: user.name || '', email: user.email || '' });
    setPreferences({ ...DEFAULT_PREFERENCES, ...(user.preferences || {}) });
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const p = { ...DEFAULT_PREFERENCES, ...(user?.preferences || {}) };
    void applyUpdatePolicy(p.autoUpdate, p.mobileDataUpdates !== false && !p.wifiOnly);
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the update policy honest when the network changes: switching to a
  // metered connection pauses updates (Wi-Fi-only), switching back resumes.
  React.useEffect(() => { watchConnectionForUpdatePolicy(); }, []);

  // Session restoration in flight — show the shell instead of bouncing to the
  // sign-in page (a signed-in user reloading /profile must stay here).
  if (authLoading) {
    return (
      <div className="section-container py-8 lg:py-12">
        <div className="card p-8 text-center text-rx-gray-medium animate-pulse">Restoring your session…</div>
      </div>
    );
  }

  // Signed out — remember where the user was heading so sign-in returns here.
  if (!user) {
    const here = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?redirect=${here}`} replace />;
  }

  const saveProfile = async () => {
    const name = profileForm.name.trim();
    const email = profileForm.email.trim();
    if (name.length < 2) { toast.error('Enter your full name'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast.error('Enter a valid email address'); return; }
    setSavingProfile(true);
    try {
      await updateProfile({ name, email, preferences });
      toast.success('Profile saved');
    } catch (e: any) { toast.error(e?.message || 'Could not save profile'); }
    finally { setSavingProfile(false); }
  };

  const togglePreference = async (key: keyof typeof preferences) => {
    const next = { ...preferences, [key]: !preferences[key] };
    // The two network toggles are a PAIR, not independent switches: enabling
    // one disables the other so the saved state can never be contradictory
    // (previously "Wi-Fi only" ON + "Allow mobile data" ON was possible and
    // Wi-Fi-only silently won).
    if (key === 'wifiOnly' && next.wifiOnly) next.mobileDataUpdates = false;
    if (key === 'mobileDataUpdates' && next.mobileDataUpdates) next.wifiOnly = false;
    setPreferences(next);
    try {
      await updateProfile({ preferences: next });
      if (key === 'autoUpdate' || key === 'wifiOnly' || key === 'mobileDataUpdates') {
        await applyUpdatePolicy(next.autoUpdate, next.mobileDataUpdates !== false && !next.wifiOnly);
      }
    } catch (e: any) {
      setPreferences(preferences);
      toast.error(e?.message || 'Could not save preference');
    }
  };

  const tabs: { id: ProfileTab; label: string; icon: any; count?: number }[] = [
    { id: 'profile', label: 'Personal Details', icon: UserCircle },
    { id: 'security', label: 'Security', icon: ShieldCheck },
    { id: 'apps', label: 'My Applications', icon: Download, count: (installedApps || []).length },
    { id: 'devices', label: 'My Devices', icon: Monitor, count: devices.filter((d) => d.status !== 'revoked').length },
    { id: 'purchases', label: 'Purchases', icon: CreditCard },
    { id: 'subscriptions', label: 'Subscriptions', icon: CreditCard, count: (user.subscriptions || []).length },
    { id: 'notifications', label: 'Notifications', icon: Bell, count: (notifications || []).filter((n) => !n.read).length },
    { id: 'trash', label: 'Recycle Bin', icon: Trash2, count: (()=>{ try{ const u=JSON.parse(localStorage.getItem('rx-store-user')||'{}'); const k=u?.id?`rx-trash-${u.id}`:'rx-trash'; const a=JSON.parse(localStorage.getItem(k)||'[]'); return Array.isArray(a)?a.length:0; } catch{ return 0; }})() },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  // Mobile quick access — every account section one tap away on a phone,
  // without horizontal-scrolling the tab strip.
  const quickLinks: { tab: ProfileTab; label: string }[] = [
    { tab: 'profile', label: 'Personal Details' },
    { tab: 'security', label: 'Security' },
    { tab: 'apps', label: 'My Apps' },
    { tab: 'devices', label: 'My Devices' },
    { tab: 'purchases', label: 'Purchases' },
    { tab: 'notifications', label: 'Notifications' },
    { tab: 'settings', label: 'Settings' },
  ];

  return (
    <div className="section-container py-8 lg:py-12">
      <div className="card p-6 sm:p-8 mb-8">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
          <div className="w-20 h-20 rounded-2xl bg-rx-yellow/20 flex items-center justify-center text-4xl">{user.avatar}</div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-white">{user.name}</h1>
            <p className="text-rx-gray-medium">{user.email}</p>
            <div className="flex items-center gap-4 mt-2">
              <span className="text-xs text-rx-gray-medium">Member since {formatDate(user.joinDate)}</span>
              <span className="px-2 py-0.5 bg-rx-yellow/20 text-rx-yellow text-xs font-medium rounded-md capitalize">{user.role}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { if (confirm('Sign out of RX Store on ALL devices? Installed apps are NOT uninstalled.')) logout({ allDevices: true }); }}
              className="px-3 py-2 text-xs text-rx-gray-medium hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all"
              title="Revoke every session for this account (does not remove installed apps)"
            >
              Sign out all devices
            </button>
            <button onClick={() => logout()} className="flex items-center gap-2 px-4 py-2 text-sm text-red-400 hover:bg-red-400/10 rounded-xl transition-all">
              <LogOut className="w-4 h-4" /> Sign Out
            </button>
          </div>
        </div>
      </div>

      {/* Mobile quick access — direct entry into every account section. */}
      <div className="grid grid-cols-3 gap-2 mb-6 sm:hidden" role="navigation" aria-label="Account sections">
        {quickLinks.map((q) => (
          <button
            key={q.tab}
            onClick={() => setActiveTab(q.tab)}
            className={`px-2 py-3 text-xs font-medium rounded-xl border transition-all ${
              activeTab === q.tab
                ? 'text-rx-yellow bg-rx-yellow/10 border-rx-yellow/40'
                : 'text-rx-gray-medium bg-white/5 border-white/10 hover:text-white'
            }`}
          >
            {q.label}
          </button>
        ))}
      </div>

      <div className="flex gap-1 border-b border-white/10 mb-8 overflow-x-auto">
        {tabs.map((tab) => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium whitespace-nowrap transition-all border-b-2 -mb-px ${
              activeTab === tab.id ? 'text-rx-yellow border-rx-yellow' : 'text-rx-gray-medium border-transparent hover:text-white'
            }`}>
            <tab.icon className="w-4 h-4" />{tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="ml-1 px-1.5 py-0.5 bg-rx-yellow/20 text-rx-yellow text-xs rounded-full">{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'profile' && (
        <div className="animate-fade-in max-w-xl">
          <h2 className="text-xl font-bold text-white mb-6">Personal Details</h2>
          <div className="card p-6 space-y-4">
            <div>
              <label className="block text-sm text-rx-gray-medium mb-1.5">Full Name</label>
              <input type="text" value={profileForm.name} onChange={(e)=>setProfileForm({...profileForm, name:e.target.value})} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-rx-yellow/50 transition-all" />
            </div>
            <div>
              <label className="block text-sm text-rx-gray-medium mb-1.5">Email</label>
              <input type="email" value={profileForm.email} onChange={(e)=>setProfileForm({...profileForm, email:e.target.value})} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-rx-yellow/50 transition-all" />
            </div>
            <button onClick={saveProfile} disabled={savingProfile} className="btn-primary disabled:opacity-50 flex items-center gap-2">
              <Save className="w-4 h-4" /> {savingProfile ? 'Saving…' : 'Save Changes'}
            </button>
            <p className="text-[11px] text-rx-gray-medium">
              Changes save to your RX Store account — every device shows the updated details on next sync.
            </p>
          </div>
        </div>
      )}

      {activeTab === 'security' && <SecuritySection />}

      {activeTab === 'apps' && (
        <div className="animate-fade-in">
          <h2 className="text-xl font-bold text-white mb-6">Installed Applications</h2>
          {(installedApps || []).length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {installedApps.map((appId) => {
                const app = getAppById(appId);
                if (!app) return null;
                return <InstalledAppRow key={appId} app={app} onReconcile={(id) => uninstallApp(id)} />;
              })}
            </div>
          ) : (
            <div className="text-center py-16">
              <div className="text-5xl mb-4">📦</div>
              <h3 className="text-xl font-semibold text-white mb-2">No applications installed</h3>
              <p className="text-rx-gray-medium mb-6">Browse our marketplace to find and install applications.</p>
              <Link to="/browse" className="btn-primary">Browse Applications</Link>
            </div>
          )}
        </div>
      )}

      {activeTab === 'devices' && (
        <div className="animate-fade-in">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-white">My Devices</h2>
            <button onClick={() => void syncNow()} className="flex items-center gap-2 px-4 py-2 text-sm text-rx-yellow bg-rx-yellow/10 hover:bg-rx-yellow/20 rounded-xl transition-colors">
              <RefreshCw className="w-4 h-4" /> Refresh
            </button>
          </div>
          <p className="text-xs text-rx-gray-medium mb-4">
            The current device is detected locally. Other devices are last-known account information — removing a device does not uninstall apps on it.
          </p>
          {(offline || pendingSync > 0) && (
            <div
              role="status"
              className={`mb-4 p-3 rounded-xl border text-xs flex items-center justify-between gap-3 ${offline ? 'bg-amber-500/10 border-amber-500/20 text-amber-200' : 'bg-white/5 border-white/10 text-rx-gray-medium'}`}
            >
              <span>
                {offline
                  ? `Offline — installed apps still work.${pendingSync > 0 ? ` ${pendingSync} change${pendingSync === 1 ? '' : 's'} will sync when you reconnect.` : ''}`
                  : `${pendingSync} pending sync change${pendingSync === 1 ? '' : 's'}.`}
              </span>
              {!offline && pendingSync > 0 && (
                <button onClick={() => void flushSync()} className="px-2.5 py-1 rounded-lg bg-rx-yellow text-rx-dark font-bold">
                  Sync now
                </button>
              )}
            </div>
          )}
          {devices.length > 0 ? (
            <div className="space-y-3">
              {devices.map((d) => {
                const DeviceIcon = d.platform === 'android' ? Smartphone : d.platform === 'windows' ? Monitor : d.platform === 'linux' ? Laptop : Globe;
                const activity = deviceActivity(d.lastSeenAt);
                const appCount = installations.filter((i) => i.deviceId === d.deviceId && ['installed', 'update_available'].includes(i.status)).length;
                return (
                  <div key={d.id} className={`card p-4 flex items-center gap-4 ${d.isCurrentDevice ? 'border-rx-yellow/40' : ''}`}>
                    <div className="w-11 h-11 rounded-xl bg-rx-dark-tertiary flex items-center justify-center"><DeviceIcon className="w-5 h-5 text-rx-yellow" /></div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-white truncate">{d.deviceName}</p>
                        {d.isCurrentDevice && <span className="px-1.5 py-0.5 bg-rx-yellow/20 text-rx-yellow text-[10px] font-bold rounded-md">THIS DEVICE</span>}
                        <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded-md capitalize ${activity === 'active' ? 'bg-green-500/20 text-green-400' : activity === 'stale' ? 'bg-amber-500/20 text-amber-300' : 'bg-white/10 text-rx-gray-medium'}`}
                          title={activity === 'active' ? 'Active recently' : activity === 'stale' ? 'Last seen a while ago' : 'Offline / unknown'}>
                          {activity === 'active' ? 'Active' : activity === 'stale' ? 'Last seen' : 'Offline'}
                        </span>
                      </div>
                      <p className="text-xs text-rx-gray-medium capitalize">
                        {d.platform} · last seen {d.lastSeenAt ? formatDate(d.lastSeenAt) : '—'}{appCount > 0 ? ` · ${appCount} app${appCount === 1 ? '' : 's'}` : ''}
                      </p>
                    </div>
                    {!d.isCurrentDevice && (
                      <button
                        onClick={() => { if (confirm(`Remove "${d.deviceName}" from your account? Apps already installed on it are NOT uninstalled.`)) void revoke(d.deviceId).then((ok) => { if (ok) toast.success('Device removed'); else toast.error('Could not remove device'); }); }}
                        className="px-3 py-1.5 text-xs font-medium text-red-400 hover:text-white bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg transition-all flex items-center gap-1"
                      >
                        <X className="w-3 h-3" /> Remove
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-16">
              <div className="text-5xl mb-4">📱</div>
              <h3 className="text-xl font-semibold text-white mb-2">No devices yet</h3>
              <p className="text-rx-gray-medium">Sign in on RX Store to register a device.</p>
            </div>
          )}
        </div>
      )}

      {activeTab === 'trash' && (
        <div className="animate-fade-in">
          <h2 className="text-xl font-bold text-white mb-6">Recycle Bin</h2>
          {(() => {
            let trash: string[] = [];
            try {
              const u = JSON.parse(localStorage.getItem('rx-store-user')||'{}');
              const k = u?.id ? `rx-trash-${u.id}` : 'rx-trash';
              trash = JSON.parse(localStorage.getItem(k) || '[]');
            } catch {}
            if (!trash.length) return <div className="card p-8 text-center text-rx-gray-medium">Recycle bin empty</div>;
            return (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {trash.map((appId: string) => {
                  const app = getAppById(appId);
                  if (!app) return null;
                  return (
                    <div key={appId} className="card p-5 flex items-center gap-4">
                      <AppLogo app={app} size="w-12 h-12" text="text-xl" rounded="rounded-xl" />
                      <div className="flex-1">
                        <p className="font-semibold text-white">{app.name}</p>
                        <p className="text-xs text-rx-gray-medium">Deleted</p>
                      </div>
                      <button onClick={()=>{
                        const u = JSON.parse(localStorage.getItem('rx-store-user')||'{}');
                        const k = u?.id ? `rx-trash-${u.id}` : 'rx-trash';
                        const cur = JSON.parse(localStorage.getItem(k)||'[]');
                        const upd = cur.filter((x:string)=>x!==appId);
                        localStorage.setItem(k, JSON.stringify(upd));
                        installApp(appId);
                        window.dispatchEvent(new CustomEvent('rx-auth-change'));
                        window.location.reload();
                      }} className="px-3 py-1.5 rounded-lg bg-green-500/10 text-green-400 border border-green-500/20 text-xs flex items-center gap-1"><RefreshCw className="w-3 h-3"/> Restore</button>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}
      {activeTab === 'purchases' && <PurchaseHistory />}
      {activeTab === 'subscriptions' && (
        <div className="animate-fade-in">
          <h2 className="text-xl font-bold text-white mb-6">Active Subscriptions</h2>
          {(user.subscriptions || []).length > 0 ? (
            <div className="space-y-4">
              {(user.subscriptions || []).map((sub) => {
                const app = getAppById(sub.appId);
                return (
                  <div key={sub.id} className="card p-5">
                    <div className="flex items-center gap-4">
                      {app && <AppLogo app={app} size="w-12 h-12" text="text-xl" rounded="rounded-xl" />}
                      <div className="flex-1">
                        <h4 className="font-semibold text-white">{app?.name || sub.appId}</h4>
                        <p className="text-sm text-rx-gray-medium">{sub.plan} Plan</p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold text-rx-yellow">${sub.amount}/mo</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${sub.status === 'active' ? 'bg-green-400/20 text-green-400' : 'bg-red-400/20 text-red-400'}`}>{sub.status}</span>
                      </div>
                    </div>
                    <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between text-xs text-rx-gray-medium">
                      <span>Started: {formatDate(sub.startDate)}</span><span>Renews: {formatDate(sub.endDate)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-16">
              <div className="text-5xl mb-4">💳</div>
              <h3 className="text-xl font-semibold text-white mb-2">No active subscriptions</h3>
              <Link to="/browse" className="btn-primary">Browse Applications</Link>
            </div>
          )}
        </div>
      )}

      {activeTab === 'notifications' && (
        <div className="animate-fade-in">
          <h2 className="text-xl font-bold text-white mb-6">Notifications</h2>
          <div className="space-y-3">
            {notifications.map((notif) => (
              <div key={notif.id} onClick={() => markNotificationRead(notif.id)}
                className={`card p-4 cursor-pointer transition-all ${!notif.read ? 'border-rx-yellow/20 bg-rx-yellow/5' : ''}`}>
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-lg bg-rx-dark-tertiary flex items-center justify-center text-sm flex-shrink-0">
                    {notif.type === 'update' ? '🔄' : notif.type === 'download' ? '📥' : '📢'}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-medium text-white">{notif.title}</h4>
                      <span className="text-xs text-rx-gray-medium">{formatDate(notif.date)}</span>
                    </div>
                    <p className="text-xs text-rx-gray-medium mt-0.5">{notif.message}</p>
                  </div>
                  {!notif.read && <div className="w-2 h-2 bg-rx-yellow rounded-full mt-2 flex-shrink-0" />}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'settings' && (
        <div className="animate-fade-in max-w-xl">
          <h2 className="text-xl font-bold text-white mb-6">Account Settings</h2>
          <div className="space-y-6">
            {/* Personal details (name/email) live in the "Personal Details"
                tab (/profile?tab=profile) — one section, one source of truth. */}
            <div className="card p-6 space-y-4">
              <h3 className="font-semibold text-white">Preferences</h3>
              {[
                { key: 'emailNotifications' as const, label: 'Email notifications', desc: 'Get an email when a new stable release is published' },
                { key: 'autoUpdate' as const, label: 'Auto-update RX Store', desc: 'Download RX Store desktop updates automatically (applies on this account’s desktop devices)' },
                { key: 'wifiOnly' as const, label: 'Updates over Wi-Fi only', desc: 'Pause automatic downloads on metered/mobile connections — turns “Allow mobile internet” off' },
                { key: 'mobileDataUpdates' as const, label: 'Allow updates on mobile internet', desc: 'Also download updates over cellular/hotspot — turns “Wi-Fi only” off' },
              ].map((pref) => {
                const on = preferences[pref.key];
                return (
                <div key={pref.key} className="flex items-center justify-between py-2">
                  <div><p className="text-sm font-medium text-white">{pref.label}</p><p className="text-xs text-rx-gray-medium">{pref.desc}</p></div>
                  <button type="button" role="switch" aria-checked={on} aria-label={pref.label} onClick={()=>togglePreference(pref.key)} className={`w-10 h-6 rounded-full relative cursor-pointer transition-colors ${on ? 'bg-rx-yellow' : 'bg-rx-dark-tertiary'}`}>
                    <span className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-all ${on ? 'right-1' : 'left-1'}`} />
                  </button>
                </div>
                );
              })}
            </div>
            <DesktopUpdatesCard />
          </div>
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Purchase history (Phase 18): real transactions, amounts, states, refunds.
// ---------------------------------------------------------------------------
function PurchaseHistory() {
  const [data, setData] = React.useState<any[] | null>(null);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    api.payments.history().then((d: any) => setData(d?.purchases || [])).catch((e: any) => setError(e?.message || 'Could not load your purchases')).finally(() => {});
  }, []);

  const statusBadge = (p: any) => {
    const map: Record<string, string> = {
      complete: 'bg-green-400/10 text-green-400', pending: 'bg-amber-500/10 text-amber-300',
      failed: 'bg-red-400/10 text-red-400', refunded: 'bg-purple-400/10 text-purple-300',
    };
    return <span className={`text-[10px] font-bold px-2 py-1 rounded ${map[p.status] || 'bg-white/5 text-rx-gray-medium'}`}>{p.status}</span>;
  };

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-bold text-white">Purchases</h3>
      {error ? (
        <div className="card p-6 text-center text-sm text-rx-gray-medium">{error}</div>
      ) : data === null ? (
        <div className="card p-6 h-24 animate-pulse" />
      ) : data.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-rx-gray-medium">No purchases yet — paid apps you buy appear here with receipts.</p>
        </div>
      ) : (
        <div className="card divide-y divide-white/5">
          {data.map((p: any) => (
            <div key={p.id} className="p-4 flex flex-wrap items-center gap-3">
              {p.app?.icon ? <img src={p.app.icon} alt="" className="w-11 h-11 rounded-xl object-cover" /> : <div className="w-11 h-11 rounded-xl bg-rx-dark-tertiary" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white truncate">{p.app?.name || 'Application'}</p>
                <p className="text-xs text-rx-gray-medium">
                  {formatDate(p.date)} · GH₵{(p.amountMinor / 100).toFixed(2)} · {p.provider === 'dev-sim' ? 'test' : p.provider}
                  {p.reference ? ` · ref ${p.reference}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {p.refundStatus && <span className="text-[10px] font-bold px-2 py-1 rounded bg-purple-400/10 text-purple-300">Refunded</span>}
                {statusBadge(p)}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-rx-gray-medium/70">
        Payment card and mobile-money details are handled entirely by the payment provider — RX Store never sees or stores them.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account Security (Phase 8): connected authentication methods + passwords.
// ---------------------------------------------------------------------------
function SecuritySection() {
  const { user } = useAuth();
  const [methods, setMethods] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  const load = () => { api.auth.authMethods().then(setMethods).catch(() => setMethods(null)); };
  React.useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async (provider: 'google' | 'github') => {
    setBusy(provider);
    try {
      const { url } = await api.auth.oauthLinkStart(provider);
      window.location.assign(url); // the provider flow returns to /oauth/callback
    } catch (e: any) {
      toast.error(e?.message || 'Could not start the connection.');
    } finally {
      setBusy('');
    }
  };

  const disconnect = async (provider: 'google' | 'github') => {
    const label = provider === 'google' ? 'Google' : 'GitHub';
    if (!confirm(`Disconnect ${label} from your RX Store account? You will no longer be able to sign in with ${label}.`)) return;
    setBusy(provider);
    try {
      await api.auth.oauthDisconnect(provider);
      toast.success(`${label} disconnected`);
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Could not disconnect.');
    } finally {
      setBusy('');
    }
  };

  const setPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    setPwBusy(true);
    try {
      const res = await api.auth.setPassword(newPassword);
      toast.success(res.message || 'Password set');
      setNewPassword('');
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Could not set the password.');
    } finally {
      setPwBusy(false);
    }
  };

  if (!user) return null;
  if (!methods) return <div className="card p-8 animate-pulse" />;

  const rows = [
    {
      key: 'password' as const,
      label: 'Email & password',
      connected: !!methods.password?.connected,
      note: methods.password?.connected ? 'Password sign-in enabled' : 'No password set (social sign-in only)',
      action: methods.password?.connected ? null : (
        <form onSubmit={setPassword} className="flex flex-wrap gap-2 w-full sm:w-auto">
          <input
            type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
            placeholder="New password (8+ chars)" minLength={8} required
            className="flex-1 min-w-40 bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2 text-sm text-white"
          />
          <button type="submit" disabled={pwBusy} className="btn-primary text-sm !py-2">{pwBusy ? '…' : 'Set password'}</button>
        </form>
      ),
    },
    {
      key: 'google' as const,
      label: 'Google',
      connected: !!methods.google?.connected,
      note: methods.google?.connected
        ? `Connected${methods.google.lastUsedAt ? ` · last used ${formatDate(methods.google.lastUsedAt)}` : ''}`
        : 'Not connected',
      action: methods.google?.connected ? (
        <button onClick={() => disconnect('google')} disabled={busy === 'google' || !methods.google.canDisconnect}
          title={methods.google.canDisconnect ? 'Disconnect Google' : 'Set another sign-in method first'}
          className="px-3 py-1.5 text-xs text-red-400 hover:text-white bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed">
          Disconnect
        </button>
      ) : (
        <button onClick={() => connect('google')} disabled={busy === 'google'} className="btn-secondary text-xs !py-2 flex items-center gap-1.5">
          <Link2 className="w-3.5 h-3.5" /> {busy === 'google' ? 'Opening Google…' : 'Connect Google'}
        </button>
      ),
    },
    {
      key: 'github' as const,
      label: 'GitHub',
      connected: !!methods.github?.connected,
      note: methods.github?.connected
        ? `Connected${methods.github.lastUsedAt ? ` · last used ${formatDate(methods.github.lastUsedAt)}` : ''}`
        : 'Not connected',
      action: methods.github?.connected ? (
        <button onClick={() => disconnect('github')} disabled={busy === 'github' || !methods.github.canDisconnect}
          title={methods.github.canDisconnect ? 'Disconnect GitHub' : 'Set another sign-in method first'}
          className="px-3 py-1.5 text-xs text-red-400 hover:text-white bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed">
          Disconnect
        </button>
      ) : (
        <button onClick={() => connect('github')} disabled={busy === 'github'} className="btn-secondary text-xs !py-2 flex items-center gap-1.5">
          <Link2 className="w-3.5 h-3.5" /> {busy === 'github' ? 'Opening GitHub…' : 'Connect GitHub'}
        </button>
      ),
    },
  ];

  return (
    <div className="animate-fade-in max-w-2xl">
      <h2 className="text-xl font-bold text-white mb-1">Account Security</h2>
      <p className="text-xs text-rx-gray-medium mb-6">
        Every method resolves to the same RX Store account. You can never remove your last usable sign-in method.
      </p>
      <div className="card divide-y divide-white/5">
        {rows.map((r) => (
          <div key={r.key} className="p-5 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white flex items-center gap-2">
                {r.label}
                <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded ${r.connected ? 'bg-green-400/15 text-green-300' : 'bg-white/5 text-rx-gray-medium'}`}>
                  {r.connected ? 'CONNECTED' : 'NOT CONNECTED'}
                </span>
              </p>
              <p className="text-xs text-rx-gray-medium mt-0.5">{r.note}</p>
            </div>
            <div className="flex-shrink-0 flex items-center">{r.action}</div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-rx-gray-medium/70 mt-4">
        Google/GitHub sign-in is optional and never replaces your password. Provider access tokens are not stored;
        only the provider account id is kept to recognise you next time.
      </p>
    </div>
  );
}
