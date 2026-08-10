import React, { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Download, CreditCard, Bell, Settings, LogOut, X, Trash2, RefreshCw, Rocket } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useApps } from '../context/AppContext';
import { formatDate } from '../utils/helpers';
import AppLogo from '../components/apps/AppLogo';
import { useUpdateStatus, describeStatus, checkNow, installNow, isDesktopApp, applyUpdatePolicy } from '../desktop/updater';
import toast from 'react-hot-toast';

const DEFAULT_PREFERENCES = {
  emailNotifications: true,
  autoUpdate: true,
  wifiOnly: false,
  mobileDataUpdates: true,
};

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
  const { user, logout, updateProfile, notifications, markNotificationRead } = useAuth();
  const { getAppById, installedApps, installApp, uninstallApp } = useApps();
  const [activeTab, setActiveTab] = useState<'apps' | 'subscriptions' | 'notifications' | 'trash' | 'settings'>('apps');
  const [profileForm, setProfileForm] = useState({ name: user?.name || '', email: user?.email || '' });
  const [preferences, setPreferences] = useState(() => ({ ...DEFAULT_PREFERENCES, ...(user?.preferences || {}) }));
  const [savingProfile, setSavingProfile] = useState(false);

  React.useEffect(() => {
    if (!user) return;
    setProfileForm({ name: user.name || '', email: user.email || '' });
    setPreferences({ ...DEFAULT_PREFERENCES, ...(user.preferences || {}) });
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const p = { ...DEFAULT_PREFERENCES, ...(user?.preferences || {}) };
    void applyUpdatePolicy(p.autoUpdate, p.mobileDataUpdates !== false && !p.wifiOnly);
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return <Navigate to="/login" replace />;

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

  const tabs = [
    { id: 'apps' as const, label: 'My Applications', icon: Download, count: (installedApps || []).length },
    { id: 'subscriptions' as const, label: 'Subscriptions', icon: CreditCard, count: (user.subscriptions || []).length },
    { id: 'notifications' as const, label: 'Notifications', icon: Bell, count: (notifications || []).filter((n) => !n.read).length },
    { id: 'trash' as const, label: 'Recycle Bin', icon: Trash2, count: (()=>{ try{ const u=JSON.parse(localStorage.getItem('rx-store-user')||'{}'); const k=u?.id?`rx-trash-${u.id}`:'rx-trash'; const a=JSON.parse(localStorage.getItem(k)||'[]'); return Array.isArray(a)?a.length:0; } catch{ return 0; }})() },
    { id: 'settings' as const, label: 'Settings', icon: Settings },
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
          <button onClick={logout} className="flex items-center gap-2 px-4 py-2 text-sm text-red-400 hover:bg-red-400/10 rounded-xl transition-all">
            <LogOut className="w-4 h-4" /> Sign Out
          </button>
        </div>
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

      {activeTab === 'apps' && (
        <div className="animate-fade-in">
          <h2 className="text-xl font-bold text-white mb-6">Installed Applications</h2>
          {(installedApps || []).length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {installedApps.map((appId) => {
                const app = getAppById(appId);
                if (!app) return null;
                return (
                  <div key={appId} className="card p-5 flex items-center gap-4 group">
                    <AppLogo app={app} size="w-14 h-14" />
                    <div className="flex-1 min-w-0">
                      <Link to={`/app/${app.slug}`} className="font-semibold text-white hover:text-rx-yellow transition-colors truncate block">{app.name}</Link>
                      <p className="text-xs text-rx-gray-medium">v{app.version} · {app.size}</p>
                    </div>
                    <button onClick={() => { if(confirm(`Uninstall ${app?.name}? This will remove the app from your device.`)) uninstallApp(appId); }} className="px-3 py-1.5 text-xs font-medium text-red-400 hover:text-white bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg transition-all flex items-center gap-1">
                      <X className="w-3 h-3" /> Uninstall
                    </button>
                  </div>
                );
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
            <div className="card p-6 space-y-4">
              <h3 className="font-semibold text-white">Profile Information</h3>
              <div>
                <label className="block text-sm text-rx-gray-medium mb-1.5">Full Name</label>
                <input type="text" value={profileForm.name} onChange={(e)=>setProfileForm({...profileForm, name:e.target.value})} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-rx-yellow/50 transition-all" />
              </div>
              <div>
                <label className="block text-sm text-rx-gray-medium mb-1.5">Email</label>
                <input type="email" value={profileForm.email} onChange={(e)=>setProfileForm({...profileForm, email:e.target.value})} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-rx-yellow/50 transition-all" />
              </div>
              <button onClick={saveProfile} disabled={savingProfile} className="btn-primary disabled:opacity-50">{savingProfile ? 'Saving…' : 'Save Changes'}</button>
            </div>
            <div className="card p-6 space-y-4">
              <h3 className="font-semibold text-white">Preferences</h3>
              {[
                { key: 'emailNotifications' as const, label: 'Email notifications', desc: 'Receive email updates about new apps' },
                { key: 'autoUpdate' as const, label: 'Auto-update RX Store', desc: 'Download RX Store desktop updates automatically' },
                { key: 'wifiOnly' as const, label: 'Updates over Wi-Fi only', desc: 'Pause automatic updates on metered/mobile connections' },
                { key: 'mobileDataUpdates' as const, label: 'Allow updates on mobile internet', desc: 'Use cellular or metered internet when Wi-Fi-only is off' },
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
