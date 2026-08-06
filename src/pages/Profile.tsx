import React, { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Download, CreditCard, Bell, Settings, LogOut, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useApps } from '../context/AppContext';
import { formatDate } from '../utils/helpers';

export default function Profile() {
  const { user, logout, notifications, markNotificationRead } = useAuth();
  const { getAppById, installedApps, uninstallApp } = useApps();
  const [activeTab, setActiveTab] = useState<'apps' | 'subscriptions' | 'notifications' | 'settings'>('apps');

  if (!user) return <Navigate to="/login" replace />;

  const tabs = [
    { id: 'apps' as const, label: 'My Applications', icon: Download, count: installedApps.length },
    { id: 'subscriptions' as const, label: 'Subscriptions', icon: CreditCard, count: user.subscriptions.length },
    { id: 'notifications' as const, label: 'Notifications', icon: Bell, count: notifications.filter((n) => !n.read).length },
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
          {installedApps.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {installedApps.map((appId) => {
                const app = getAppById(appId);
                if (!app) return null;
                return (
                  <div key={appId} className="card p-5 flex items-center gap-4 group">
                    <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${app.gradient} flex items-center justify-center text-2xl flex-shrink-0`}>{app.icon}</div>
                    <div className="flex-1 min-w-0">
                      <Link to={`/app/${app.slug}`} className="font-semibold text-white hover:text-rx-yellow transition-colors truncate block">{app.name}</Link>
                      <p className="text-xs text-rx-gray-medium">v{app.version} · {app.size}</p>
                    </div>
                    <button onClick={() => uninstallApp(appId)} className="p-2 text-rx-gray-medium hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all opacity-0 group-hover:opacity-100" title="Uninstall">
                      <X className="w-4 h-4" />
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

      {activeTab === 'subscriptions' && (
        <div className="animate-fade-in">
          <h2 className="text-xl font-bold text-white mb-6">Active Subscriptions</h2>
          {user.subscriptions.length > 0 ? (
            <div className="space-y-4">
              {user.subscriptions.map((sub) => {
                const app = getAppById(sub.appId);
                return (
                  <div key={sub.id} className="card p-5">
                    <div className="flex items-center gap-4">
                      {app && <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${app.gradient} flex items-center justify-center text-xl`}>{app.icon}</div>}
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
                <input type="text" defaultValue={user.name} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-rx-yellow/50 transition-all" />
              </div>
              <div>
                <label className="block text-sm text-rx-gray-medium mb-1.5">Email</label>
                <input type="email" defaultValue={user.email} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-rx-yellow/50 transition-all" />
              </div>
              <button className="btn-primary">Save Changes</button>
            </div>
            <div className="card p-6 space-y-4">
              <h3 className="font-semibold text-white">Preferences</h3>
              {[
                { label: 'Email notifications', desc: 'Receive email updates about new apps', on: true },
                { label: 'Auto-update applications', desc: 'Automatically update installed apps', on: true },
                { label: 'Download over WiFi only', desc: 'Only download when connected to WiFi', on: false },
              ].map((pref) => (
                <div key={pref.label} className="flex items-center justify-between py-2">
                  <div><p className="text-sm font-medium text-white">{pref.label}</p><p className="text-xs text-rx-gray-medium">{pref.desc}</p></div>
                  <div className={`w-10 h-6 rounded-full relative cursor-pointer ${pref.on ? 'bg-rx-yellow' : 'bg-rx-dark-tertiary'}`}>
                    <div className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-all ${pref.on ? 'right-1' : 'left-1'}`} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
