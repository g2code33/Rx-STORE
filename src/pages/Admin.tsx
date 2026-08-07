import React, { useState } from 'react';
import {
  LayoutDashboard, Package, Users, BarChart3, DollarSign, Upload,
  Download, Star, Settings, Shield, Plus, Edit, Trash2, Activity, Database, Cloud, Bot, Key, Globe, FileText, Bell
} from 'lucide-react';
import { useApps } from '../context/AppContext';
import { formatDownloadCount } from '../utils/helpers';
import AIProviderPanel from '../components/admin/AIProviderPanel';
import { useAuth } from '../context/AuthContext';

export default function Admin() {
  const { apps } = useApps();
  const { user } = useAuth();
  const [activeSection, setActiveSection] = useState('dashboard');
  const isAdmin = user?.role === 'admin';

  const stats = [
    { label: 'Total Downloads', value: '734K', change: '+12.5%', icon: Download, color: '#FFD600' },
    { label: 'Active Users', value: '28.4K', change: '+8.2%', icon: Users, color: '#4ECDC4' },
    { label: 'Revenue (MTD)', value: '$47.8K', change: '+23.1%', icon: DollarSign, color: '#45B7D1' },
    { label: 'App Rating', value: '4.7', change: '+0.2', icon: Star, color: '#96CEB4' },
  ];

  const sidebarItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'applications', label: 'Applications', icon: Package },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'ai', label: 'AI Providers', icon: Bot },
    { id: 'analytics', label: 'Analytics', icon: BarChart3 },
    { id: 'revenue', label: 'Revenue', icon: DollarSign },
    { id: 'uploads', label: 'Uploads', icon: Upload },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="section-container py-8">
      <div className="flex flex-col lg:flex-row gap-8">
        <aside className="lg:w-64 flex-shrink-0">
          <div className="card p-4 lg:sticky lg:top-24">
            <div className="flex items-center gap-3 mb-6 pb-4 border-b border-white/5">
              <div className="w-10 h-10 rounded-xl bg-rx-yellow/20 flex items-center justify-center"><Shield className="w-5 h-5 text-rx-yellow" /></div>
              <div><h2 className="font-bold text-white text-sm">Admin Panel</h2><p className="text-xs text-rx-gray-medium">RX Store Management</p></div>
            </div>
            <nav className="space-y-1">
              {sidebarItems.map((item) => (
                <button key={item.id} onClick={() => setActiveSection(item.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    activeSection === item.id ? 'bg-rx-yellow/10 text-rx-yellow' : 'text-rx-gray-medium hover:text-white hover:bg-white/5'
                  }`}>
                  <item.icon className="w-4 h-4" />{item.label}
                </button>
              ))}
            </nav>
          </div>
        </aside>

        <div className="flex-1 min-w-0">
          {!isAdmin && (
            <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center gap-3 text-sm text-amber-200">
              <Shield className="w-5 h-5 flex-shrink-0"/> You’re viewing as <b>{user?.role || 'guest'}</b>. Log in as <code className="px-1 py-0.5 bg-white/10 rounded">admin</code> to save changes. AI Providers still visible in read-only.
            </div>
          )}
          {activeSection === 'ai' && (<div className="animate-fade-in"><AIProviderPanel /></div>)}
          {activeSection === 'dashboard' && (
            <div className="space-y-8 animate-fade-in">
              <div><h1 className="text-2xl font-bold text-white">Dashboard Overview</h1><p className="text-rx-gray-medium mt-1">Welcome back! Here's what's happening with RX Store.</p></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {stats.map((stat) => (
                  <div key={stat.label} className="card p-5">
                    <div className="flex items-center justify-between mb-3">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${stat.color}15` }}><stat.icon className="w-5 h-5" style={{ color: stat.color }} /></div>
                      <span className="text-xs font-medium text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full">{stat.change}</span>
                    </div>
                    <p className="text-2xl font-bold text-white">{stat.value}</p>
                    <p className="text-xs text-rx-gray-medium mt-1">{stat.label}</p>
                  </div>
                ))}
              </div>
              <div className="card p-6">
                <h3 className="font-bold text-white mb-4 flex items-center gap-2"><Activity className="w-5 h-5 text-rx-yellow" /> Recent Activity</h3>
                <div className="space-y-3">
                  {[
                    { action: 'Clinical Rx updated to v3.2.1', time: '2 hours ago', type: 'update' },
                    { action: 'New user registration: Dr. Sarah Chen', time: '4 hours ago', type: 'user' },
                    { action: 'CureLink reached 200K downloads', time: '1 day ago', type: 'milestone' },
                    { action: 'New subscription: MediLearn Academy Pro', time: '1 day ago', type: 'revenue' },
                    { action: 'PharmaGAME v2.5.0 deployed', time: '2 days ago', type: 'update' },
                    { action: 'Security audit completed successfully', time: '3 days ago', type: 'security' },
                  ].map((item, i) => (
                    <div key={i} className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-colors">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${item.type === 'update' ? 'bg-blue-400' : item.type === 'user' ? 'bg-green-400' : item.type === 'revenue' ? 'bg-rx-yellow' : item.type === 'milestone' ? 'bg-purple-400' : 'bg-rx-gray-medium'}`} />
                      <span className="text-sm text-rx-gray-medium flex-1">{item.action}</span>
                      <span className="text-xs text-rx-gray-medium flex-shrink-0">{item.time}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[
                  { label: 'API Status', status: 'Operational', icon: Cloud, color: 'green' },
                  { label: 'Database', status: 'Healthy', icon: Database, color: 'green' },
                  { label: 'Storage', status: '78% Used', icon: Cloud, color: 'yellow' },
                ].map((item) => (
                  <div key={item.label} className="card p-4 flex items-center gap-3">
                    <item.icon className={`w-5 h-5 text-${item.color}-400`} />
                    <div><p className="text-sm font-medium text-white">{item.label}</p><p className={`text-xs text-${item.color}-400`}>{item.status}</p></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'applications' && (
            <div className="space-y-6 animate-fade-in">
              <div className="flex items-center justify-between">
                <div><h1 className="text-2xl font-bold text-white">Applications</h1><p className="text-rx-gray-medium mt-1">Manage all applications in the marketplace</p></div>
                <button className="btn-primary flex items-center gap-2"><Plus className="w-4 h-4" /> Add Application</button>
              </div>
              <div className="card overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-white/5">
                      <th className="text-left px-5 py-3 text-xs font-medium text-rx-gray-medium uppercase tracking-wider">Application</th>
                      <th className="text-left px-5 py-3 text-xs font-medium text-rx-gray-medium uppercase tracking-wider hidden sm:table-cell">Category</th>
                      <th className="text-left px-5 py-3 text-xs font-medium text-rx-gray-medium uppercase tracking-wider">Downloads</th>
                      <th className="text-left px-5 py-3 text-xs font-medium text-rx-gray-medium uppercase tracking-wider hidden md:table-cell">Rating</th>
                      <th className="text-left px-5 py-3 text-xs font-medium text-rx-gray-medium uppercase tracking-wider">Status</th>
                      <th className="text-right px-5 py-3 text-xs font-medium text-rx-gray-medium uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apps.map((app) => (
                      <tr key={app.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${app.gradient} flex items-center justify-center text-lg`}>{app.icon}</div>
                            <div><p className="font-medium text-white text-sm">{app.name}</p><p className="text-xs text-rx-gray-medium">v{app.version}</p></div>
                          </div>
                        </td>
                        <td className="px-5 py-4 hidden sm:table-cell"><span className="text-sm text-rx-gray-medium capitalize">{app.category}</span></td>
                        <td className="px-5 py-4"><span className="text-sm text-white">{formatDownloadCount(app.downloadCount)}</span></td>
                        <td className="px-5 py-4 hidden md:table-cell"><div className="flex items-center gap-1"><Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400" /><span className="text-sm text-white">{app.rating}</span></div></td>
                        <td className="px-5 py-4"><span className={`px-2 py-0.5 text-xs font-medium rounded-full ${app.status === 'active' ? 'bg-green-400/20 text-green-400' : app.status === 'beta' ? 'bg-purple-400/20 text-purple-400' : 'bg-gray-400/20 text-gray-400'}`}>{app.status}</span></td>
                        <td className="px-5 py-4 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button className="p-1.5 text-rx-gray-medium hover:text-white hover:bg-white/10 rounded-lg transition-all"><Edit className="w-4 h-4" /></button>
                            <button className="p-1.5 text-rx-gray-medium hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all"><Trash2 className="w-4 h-4" /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeSection === 'users' && (
            <div className="space-y-6 animate-fade-in">
              <div><h1 className="text-2xl font-bold text-white">User Management</h1><p className="text-rx-gray-medium mt-1">Manage user accounts and permissions</p></div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[{ label: 'Total Users', value: '28,431' }, { label: 'Active Today', value: '4,821' }, { label: 'Subscribers', value: '12,847' }].map((s) => (
                  <div key={s.label} className="card p-5"><p className="text-2xl font-bold text-white">{s.value}</p><p className="text-xs text-rx-gray-medium mt-1">{s.label}</p></div>
                ))}
              </div>
              <div className="card p-6">
                <h3 className="font-bold text-white mb-4">Recent Users</h3>
                <div className="space-y-3">
                  {[
                    { name: 'Dr. Sarah Chen', email: 'sarah.chen@hospital.org', role: 'user' },
                    { name: 'James Wilson', email: 'j.wilson@pharmacy.com', role: 'developer' },
                    { name: 'Amy Rodriguez', email: 'amy.r@clinic.net', role: 'user' },
                    { name: 'Michael Park', email: 'm.park@research.edu', role: 'user' },
                    { name: 'Lisa Thompson', email: 'lisa.t@healthcare.org', role: 'admin' },
                  ].map((u) => (
                    <div key={u.email} className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-colors">
                      <div className="w-9 h-9 rounded-lg bg-rx-dark-tertiary flex items-center justify-center text-sm font-bold text-rx-yellow">{u.name.charAt(0)}</div>
                      <div className="flex-1 min-w-0"><p className="text-sm font-medium text-white truncate">{u.name}</p><p className="text-xs text-rx-gray-medium truncate">{u.email}</p></div>
                      <span className={`px-2 py-0.5 text-xs rounded-full ${u.role === 'admin' ? 'bg-rx-yellow/20 text-rx-yellow' : u.role === 'developer' ? 'bg-purple-400/20 text-purple-400' : 'bg-white/10 text-rx-gray-medium'}`}>{u.role}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeSection === 'analytics' && (
            <div className="space-y-6 animate-fade-in">
              <div><h1 className="text-2xl font-bold text-white">Analytics</h1><p className="text-rx-gray-medium mt-1">Platform performance and usage metrics</p></div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="card p-6">
                  <h3 className="font-bold text-white mb-4">Download Trends (Last 30 Days)</h3>
                  <div className="h-48 flex items-end gap-1.5">
                    {[40, 55, 35, 65, 50, 70, 85, 60, 75, 90, 65, 80, 95, 70, 85, 100, 75, 90, 80, 95, 85, 70, 90, 100, 85, 95, 80, 90, 85, 100].map((h, i) => (
                      <div key={i} className="flex-1 bg-rx-yellow/80 rounded-t transition-all hover:bg-rx-yellow" style={{ height: `${h}%` }} />
                    ))}
                  </div>
                </div>
                <div className="card p-6">
                  <h3 className="font-bold text-white mb-4">Platform Distribution</h3>
                  <div className="space-y-4">
                    {[
                      { platform: 'Web', percentage: 42 }, { platform: 'Android', percentage: 28 },
                      { platform: 'iOS', percentage: 18 }, { platform: 'Windows', percentage: 8 }, { platform: 'Linux', percentage: 4 },
                    ].map((p) => (
                      <div key={p.platform}>
                        <div className="flex items-center justify-between mb-1"><span className="text-sm text-rx-gray-medium">{p.platform}</span><span className="text-sm text-white">{p.percentage}%</span></div>
                        <div className="h-2 bg-rx-dark-tertiary rounded-full overflow-hidden"><div className="h-full bg-rx-yellow rounded-full" style={{ width: `${p.percentage}%` }} /></div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="card p-6">
                <h3 className="font-bold text-white mb-4">Top Applications by Downloads</h3>
                <div className="space-y-3">
                  {[...apps].sort((a, b) => b.downloadCount - a.downloadCount).slice(0, 5).map((app, i) => (
                    <div key={app.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-colors">
                      <span className="text-lg font-bold text-rx-gray-medium w-6">{i + 1}</span>
                      <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${app.gradient} flex items-center justify-center text-lg`}>{app.icon}</div>
                      <div className="flex-1"><p className="text-sm font-medium text-white">{app.name}</p></div>
                      <span className="text-sm font-semibold text-rx-yellow">{formatDownloadCount(app.downloadCount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeSection === 'revenue' && (
            <div className="space-y-6 animate-fade-in">
              <div><h1 className="text-2xl font-bold text-white">Revenue</h1><p className="text-rx-gray-medium mt-1">Financial overview and subscription tracking</p></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {[{ label: 'Monthly Revenue', value: '$47,832' }, { label: 'Subscriptions', value: '1,247' }, { label: 'One-time Sales', value: '$8,421' }, { label: 'Enterprise', value: '$12,500' }].map((s) => (
                  <div key={s.label} className="card p-5"><p className="text-2xl font-bold text-rx-yellow">{s.value}</p><p className="text-xs text-rx-gray-medium mt-1">{s.label}</p></div>
                ))}
              </div>
              <div className="card p-6">
                <h3 className="font-bold text-white mb-4">Revenue by Application</h3>
                <div className="space-y-3">
                  {[
                    { name: 'Clinical Rx', revenue: '$15,420', growth: '+18%' }, { name: 'CureLink', revenue: '$12,800', growth: '+22%' },
                    { name: 'TAWOMO', revenue: '$8,950', growth: '+15%' }, { name: 'MediLearn Academy', revenue: '$6,200', growth: '+28%' },
                    { name: 'Rx Assistant AI', revenue: '$4,462', growth: '+45%' },
                  ].map((item) => (
                    <div key={item.name} className="flex items-center justify-between p-3 rounded-xl hover:bg-white/5 transition-colors">
                      <span className="text-sm text-white">{item.name}</span>
                      <div className="flex items-center gap-3"><span className="text-sm font-semibold text-rx-yellow">{item.revenue}</span><span className="text-xs text-green-400">{item.growth}</span></div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeSection === 'uploads' && (
            <div className="space-y-6 animate-fade-in">
              <div><h1 className="text-2xl font-bold text-white">Upload Center</h1><p className="text-rx-gray-medium mt-1">Upload application binaries and manage releases</p></div>
              <div className="card p-8 border-2 border-dashed border-white/10 hover:border-rx-yellow/30 transition-colors text-center">
                <Upload className="w-12 h-12 text-rx-gray-medium mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-white mb-2">Upload Application Files</h3>
                <p className="text-sm text-rx-gray-medium mb-6">Drag and drop files here or click to browse</p>
                <button className="btn-primary">Select Files</button>
                <div className="mt-6 flex items-center justify-center gap-4 text-xs text-rx-gray-medium">
                  <span>.apk</span><span>.exe</span><span>.deb</span><span>.AppImage</span><span>.dmg</span><span>.ipa</span>
                </div>
              </div>
              <div className="card p-6">
                <h3 className="font-bold text-white mb-4">Recent Uploads</h3>
                <div className="space-y-3">
                  {[
                    { name: 'clinical-rx-v3.2.1-windows.exe', size: '148 MB', date: '2 hours ago', status: 'Processing' },
                    { name: 'clinical-rx-v3.2.1-android.apk', size: '89 MB', date: '2 hours ago', status: 'Complete' },
                    { name: 'pharma-game-v2.5.0-web.zip', size: '234 MB', date: '1 day ago', status: 'Complete' },
                    { name: 'curelink-v2.9.7-ios.ipa', size: '156 MB', date: '2 days ago', status: 'Complete' },
                  ].map((file, i) => (
                    <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-rx-dark-tertiary/50">
                      <Package className="w-5 h-5 text-rx-gray-medium" />
                      <div className="flex-1 min-w-0"><p className="text-sm text-white truncate">{file.name}</p><p className="text-xs text-rx-gray-medium">{file.size} · {file.date}</p></div>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${file.status === 'Complete' ? 'bg-green-400/20 text-green-400' : 'bg-rx-yellow/20 text-rx-yellow'}`}>{file.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeSection === 'settings' && (
            <div className="space-y-6 animate-fade-in">
              <div><h1 className="text-2xl font-bold text-white">Platform Settings</h1><p className="text-rx-gray-medium mt-1">Configure RX Store platform settings</p></div>
              <div className="space-y-4">
                <div className="card p-6">
                  <h3 className="font-bold text-white mb-4">General Settings</h3>
                  <div className="space-y-4">
                    {[{ label: 'Platform Name', value: 'RX Store' }, { label: 'Organization', value: 'Calcitonin Technologies' }, { label: 'Support Email', value: 'support@rxstore.com' }, { label: 'API Version', value: 'v1.0.0' }].map((item) => (
                      <div key={item.label}>
                        <label className="block text-sm text-rx-gray-medium mb-1.5">{item.label}</label>
                        <input type="text" defaultValue={item.value} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-rx-yellow/50 transition-all" />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="card p-6">
                  <h3 className="font-bold text-white mb-4">Security Settings</h3>
                  <div className="space-y-3">
                    {[
                      { label: 'Two-factor authentication', enabled: true }, { label: 'API rate limiting', enabled: true },
                      { label: 'Malware scanning', enabled: true }, { label: 'Audit logging', enabled: true }, { label: 'IP allowlisting', enabled: false },
                    ].map((setting) => (
                      <div key={setting.label} className="flex items-center justify-between py-2">
                        <span className="text-sm text-rx-gray-medium">{setting.label}</span>
                        <div className={`w-10 h-6 rounded-full relative cursor-pointer transition-colors ${setting.enabled ? 'bg-rx-yellow' : 'bg-rx-dark-tertiary'}`}>
                          <div className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-all ${setting.enabled ? 'right-1' : 'left-1'}`} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="card p-6">
                  <h3 className="font-bold text-white mb-4">Payment Configuration</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {['Paystack', 'Mobile Money', 'Hubtel'].map((provider) => (
                      <div key={provider} className="p-4 rounded-xl bg-rx-dark-tertiary/50 border border-white/5 text-center">
                        <div className="w-10 h-10 rounded-lg bg-rx-yellow/20 flex items-center justify-center mx-auto mb-2"><DollarSign className="w-5 h-5 text-rx-yellow" /></div>
                        <p className="text-sm font-medium text-white">{provider}</p><p className="text-xs text-green-400 mt-1">Connected</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
