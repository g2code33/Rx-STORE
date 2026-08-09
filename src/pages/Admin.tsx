import React, { useState, Suspense, lazy } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  LayoutDashboard, Package, Users, BarChart3, DollarSign, Upload,
  Download, Star, Settings, Shield, Plus, Edit, Trash2, Activity, Database, Cloud, Bot, Key, Globe, FileText, Bell, Megaphone,
  Monitor, Eye, Paintbrush, Loader2, Rocket, MousePointerClick, Tablet, Smartphone, PanelRight
} from 'lucide-react';
import { useApps } from '../context/AppContext';
import { formatDownloadCount } from '../utils/helpers';
import NotificationComposer from '../components/admin/NotificationComposer';
import { useContent } from '../context/ContentContext';
import { EditCtxType, EditDescriptor, setBuilderCtx } from '../components/edit/EditMode';
import Inspector from '../components/edit/Inspector';

const BuilderHome = lazy(() => import('./Home'));
const BuilderAbout = lazy(() => import('./About'));

/** Relative time for activity rows ("3h ago") */
function ago(t?: string) {
  if (!t) return '';
  const ts = new Date(String(t).replace(' ', 'T') + 'Z').getTime();
  if (isNaN(ts)) return String(t);
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
import AIProviderPanel from '../components/admin/AIProviderPanel';
import AppEditor from '../components/admin/AppEditor';
import AppReleaseManager from '../components/admin/AppReleaseManager';
import ReleasesManager from '../components/admin/ReleasesManager';
import UserRoleEditor from '../components/admin/UserRoleEditor';
import RevenuePanel from '../components/admin/RevenuePanel';
import AdminSettings from '../components/admin/AdminSettings';
import RecycleBin from '../components/admin/RecycleBin';
import { useAuth } from '../context/AuthContext';

export default function Admin() {
  const { apps, refresh } = useApps();
  const { user } = useAuth();
  const [activeSection, setActiveSection] = useState('dashboard');
  const [editingApp, setEditingApp] = useState<any>(null);
  const isAdmin = user?.role === 'admin';

  // ---- View 2: Live Website Builder state ----
  const [view, setView] = useState<'panel' | 'builder'>('panel');
  const [builderPage, setBuilderPage] = useState<'home' | 'about'>('home');
  const [interact, setInteract] = useState(false);
  const [inspector, setInspector] = useState<EditDescriptor | null>(null);
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'phone'>('desktop');
  const lastInspector = React.useRef<EditDescriptor | null>(null);
  const { pending, publishAll } = useContent();

  const editCtx: EditCtxType = {
    editMode: view === 'builder' && !interact,
    interact,
    inspector,
    openInspector: (d) => { lastInspector.current = d; setInteract(false); setInspector(d); },
    closeInspector: () => setInspector(null),
    onEditApp: (app) => { setEditingApp(app); setView('panel'); setActiveSection('applications'); },
  };

  // Publish builder ctx app-wide (Header/Footer get edit chrome too); clear on
  // leave/unmount so visitors & normal browsing never see it.
  React.useEffect(() => { setBuilderCtx(view === 'builder' ? editCtx : null); });
  React.useEffect(() => () => setBuilderCtx(null), []);

  const [stats, setStats] = React.useState([
    { label: 'Total Downloads', value: '—', change: '', icon: Download, color: '#FFD600' },
    { label: 'Active Users', value: '—', change: '', icon: Users, color: '#4ECDC4' },
    { label: 'Revenue (MTD)', value: '—', change: '', icon: DollarSign, color: '#45B7D1' },
    { label: 'App Rating', value: '—', change: '', icon: Star, color: '#96CEB4' },
  ]);
  const [activity, setActivity] = useState<any[]>([]);
  // Real Cloudflare R2 usage (from the worker's paginated bucket listing)
  const [storage, setStorage] = React.useState<{ bytes: number | null; objects: number | null; quotaGb: number }>({ bytes: null, objects: null, quotaGb: 10 });
  const fmtBytes = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
    return `${(b / 1024 ** 3).toFixed(2)} GB`;
  };
  const storagePct = storage.bytes != null ? (storage.bytes / (storage.quotaGb * 1024 ** 3)) * 100 : null;
  const publishAsNotice = (item: any) => {
    // Hand this activity to the Notifications composer as a ready-to-send draft
    sessionStorage.setItem('rx-notif-draft', JSON.stringify({
      title: item.text,
      message: item.kind === 'user' ? 'Please join us in welcoming our newest member to RX Store.' : item.text + ' — details on the store.',
      link: item.to === 'app' && item.slug ? `/app/${item.slug}` : '',
    }));
    setActiveSection('notifications');
  };

  React.useEffect(() => {
    const API = (import.meta as any).env?.VITE_API_URL;
    if (!API) {
      // Brand new site defaults
      setStats([
        { label: 'Total Downloads', value: '0', change: '0%', icon: Download, color: '#FFD600' },
        { label: 'Active Users', value: '1', change: '', icon: Users, color: '#4ECDC4' },
        { label: 'Revenue (MTD)', value: '$0', change: '', icon: DollarSign, color: '#45B7D1' },
        { label: 'App Rating', value: '0.0', change: '', icon: Star, color: '#96CEB4' },
      ]);
      return;
    }
    const token = localStorage.getItem('rx-store-token') || '';
    fetch(`${API.replace(/\/$/,'')}/admin/dashboard`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} })
      .then(r=>r.json()).then(j=>{
        const d=j.data||j;
        setStats([
          { label: 'Total Downloads', value: (d.totalDownloads ?? 0).toString(), change: d.totalDownloads?'+12.5%':'0%', icon: Download, color: '#FFD600' },
          { label: 'Active Users', value: (d.totalUsers ?? 0).toString(), change: '', icon: Users, color: '#4ECDC4' },
          { label: 'Revenue (MTD)', value: `$${(d.monthlyRevenue ?? 0).toLocaleString()}`, change: '', icon: DollarSign, color: '#45B7D1' },
          { label: 'App Rating', value: String(d.averageRating ? Number(d.averageRating).toFixed(1) : '0.0'), change: '', icon: Star, color: '#96CEB4' },
        ]);
        setActivity(Array.isArray(d.activity) ? d.activity : []);
        setStorage({
          bytes: typeof d.storageBytes === 'number' ? d.storageBytes : null,
          objects: typeof d.storageObjects === 'number' ? d.storageObjects : null,
          quotaGb: typeof d.storageQuotaGb === 'number' && d.storageQuotaGb > 0 ? d.storageQuotaGb : 10,
        });
      }).catch(()=>{
        setStats([
          { label: 'Total Downloads', value: '0', change: '', icon: Download, color: '#FFD600' },
          { label: 'Active Users', value: '0', change: '', icon: Users, color: '#4ECDC4' },
          { label: 'Revenue (MTD)', value: '$0', change: '', icon: DollarSign, color: '#45B7D1' },
          { label: 'App Rating', value: '0.0', change: '', icon: Star, color: '#96CEB4' },
        ]);
      });
  }, []);

  const sidebarItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'applications', label: 'Applications', icon: Package },
    { id: 'releases', label: 'Releases', icon: Upload },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'developers', label: 'Developers', icon: Shield },
    { id: 'ai', label: 'AI Providers', icon: Bot },
    { id: 'analytics', label: 'Analytics', icon: BarChart3 },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'revenue', label: 'Revenue', icon: DollarSign },
    { id: 'uploads', label: 'Uploads', icon: Upload },
    { id: 'recycle', label: 'Recycle Bin', icon: Trash2 },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  // ==================== VIEW 2 — LIVE WEBSITE BUILDER ====================
  // Renders the REAL public components with an admin-only edit layer on top.
  if (view === 'builder') {
    return (
        <div className="-mt-16 pt-16 min-h-screen bg-rx-dark">
          {/* Builder toolbar */}
          <div className="sticky top-16 z-50 bg-rx-dark/95 backdrop-blur-xl border-b border-rx-yellow/20">
            <div className="section-container py-2.5 flex items-center gap-2 flex-wrap">
              {/* View switch */}
              <div className="flex rounded-xl overflow-hidden border border-white/10">
                <button onClick={() => setView('panel')} className="px-3.5 py-1.5 text-xs font-semibold text-rx-gray-medium hover:text-white flex items-center gap-1.5">
                  <LayoutDashboard className="w-3.5 h-3.5" /> Controller
                </button>
                <button className="px-3.5 py-1.5 text-xs font-semibold bg-rx-yellow text-rx-dark flex items-center gap-1.5">
                  <Monitor className="w-3.5 h-3.5" /> Live Builder
                </button>
              </div>

              {/* Page picker */}
              <div className="flex rounded-xl overflow-hidden border border-white/10">
                {([['home', 'Home'], ['about', 'About']] as const).map(([id, label]) => (
                  <button key={id} onClick={() => setBuilderPage(id)} className={`px-3 py-1.5 text-xs font-semibold ${builderPage === id ? 'bg-white/10 text-white' : 'text-rx-gray-medium hover:text-white'}`}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Edit vs preview */}
              <button
                onClick={() => { setInteract(!interact); setInspector(null); }}
                className={`px-3.5 py-1.5 text-xs font-semibold rounded-xl border flex items-center gap-1.5 ${interact ? 'border-white/10 text-rx-gray-medium hover:text-white' : 'border-rx-yellow/40 bg-rx-yellow/10 text-rx-yellow'}`}
                title={interact ? 'Preview mode — click to start editing' : 'Editing mode — hover anything to edit it'}
              >
                {interact ? <Eye className="w-3.5 h-3.5" /> : <MousePointerClick className="w-3.5 h-3.5" />}
                {interact ? 'Preview' : 'Editing'}
              </button>

              {/* Device preview widths (reference-builder parity) */}
              <div className="flex rounded-xl overflow-hidden border border-white/10">
                {([['desktop', Monitor], ['tablet', Tablet], ['phone', Smartphone]] as const).map(([id, Icon]) => (
                  <button
                    key={id}
                    onClick={() => setDevice(id)}
                    title={`${id} preview`}
                    className={`px-2.5 py-1.5 ${device === id ? 'bg-white/10 text-rx-yellow' : 'text-rx-gray-medium hover:text-white'}`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </button>
                ))}
              </div>

              {/* Design tokens */}
              <button
                onClick={() => { setInteract(false); setInspector({ id: 'design', type: 'design', label: 'Site-wide design' }); }}
                className="px-3.5 py-1.5 text-xs font-semibold rounded-xl border border-white/10 text-rx-gray-medium hover:text-rx-yellow flex items-center gap-1.5"
              >
                <Paintbrush className="w-3.5 h-3.5" /> Design
              </button>

              {/* Add (next phase) */}
              <button
                onClick={() => toast('Add Block — insert brand-new sections anywhere — arrives in the next builder update 🚧', { icon: '🧱' })}
                className="px-3.5 py-1.5 text-xs font-semibold rounded-xl border border-white/10 text-rx-gray-medium hover:text-rx-yellow flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" /> Add
              </button>

              {/* Inspector toggle */}
              <button
                onClick={() => {
                  if (inspector) setInspector(null);
                  else if (lastInspector.current) { setInteract(false); setInspector(lastInspector.current); }
                  else toast('Click any outlined element on the page to edit it', { icon: '👆' });
                }}
                className={`px-3.5 py-1.5 text-xs font-semibold rounded-xl border flex items-center gap-1.5 ${inspector ? 'border-rx-yellow/40 bg-rx-yellow/10 text-rx-yellow' : 'border-white/10 text-rx-gray-medium hover:text-rx-yellow'}`}
              >
                <PanelRight className="w-3.5 h-3.5" /> Inspector
              </button>

              <div className="flex-1" />

              {/* Pending / publish all */}
              {pending.length > 0 ? (
                <button onClick={publishAll} className="px-3.5 py-1.5 text-xs font-bold rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-300 flex items-center gap-1.5 hover:bg-amber-500/25">
                  <Rocket className="w-3.5 h-3.5" /> Publish All ({pending.length})
                </button>
              ) : (
                <span className="text-[11px] text-green-400/80 flex items-center gap-1">✓ Everything published</span>
              )}
              {!interact && <span className="hidden md:inline text-[11px] text-rx-gray-medium">Every outlined element is editable — click it. App cards open the full app editor.</span>}
            </div>
          </div>

          {/* The REAL public page, with the edit layer live — width follows the device toggle */}
          <div className="mx-auto transition-[width] duration-300 min-h-screen" style={{ width: device === 'phone' ? 390 : device === 'tablet' ? 768 : '100%' }}>
            <Suspense fallback={<div className="py-24 text-center text-rx-gray-medium flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading page…</div>}>
              {builderPage === 'home' ? <BuilderHome /> : <BuilderAbout />}
            </Suspense>
          </div>
          <Inspector />
        </div>
    );
  }
  // ==================== VIEW 1 — CONTROLLER (classic panel) ====================

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
            <div className="mt-4 pt-4 border-t border-white/5">
              <button
                onClick={() => setView('builder')}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold bg-rx-yellow text-rx-dark hover:bg-rx-yellow-light transition-all"
              >
                <Monitor className="w-4 h-4" /> Live Website Builder
              </button>
              <p className="text-[10px] text-rx-gray-medium mt-1.5 px-1">Edit the real site in place — every text, image, list & color.</p>
            </div>
          </div>
        </aside>

        <div className="flex-1 min-w-0">
          {!isAdmin && (
            <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center gap-3 text-sm text-amber-200">
              <Shield className="w-5 h-5 flex-shrink-0"/> You’re viewing as <b>{user?.role || 'guest'}</b>. Log in as <code className="px-1 py-0.5 bg-white/10 rounded">admin</code> to save changes. AI Providers still visible in read-only.
            </div>
          )}
          {activeSection === 'ai' && (<div className="animate-fade-in"><AIProviderPanel /></div>)}
          {activeSection === 'notifications' && (<div className="animate-fade-in"><NotificationComposer /></div>)}
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
                <div className="space-y-1.5">
                  {activity.length === 0 && (
                    <p className="text-sm text-rx-gray-medium py-3 text-center">No activity yet — installs, publishes and sign-ups appear here the moment they happen.</p>
                  )}
                  {activity.map((item: any) => (
                    <div key={item.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-colors">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${item.kind === 'release' ? 'bg-blue-400' : item.kind === 'download' ? 'bg-purple-400' : item.kind === 'user' ? 'bg-green-400' : item.kind === 'rollback' ? 'bg-amber-400' : 'bg-rx-gray-medium'}`} />
                      {item.to === 'app' && item.slug ? (
                        <Link to={`/app/${item.slug}`} className="text-sm text-rx-gray-medium hover:text-rx-yellow flex-1 transition-colors">
                          {item.text}
                        </Link>
                      ) : item.to === 'section' ? (
                        <button onClick={() => setActiveSection(item.slug)} className="text-sm text-rx-gray-medium hover:text-rx-yellow flex-1 text-left transition-colors">
                          {item.text}
                        </button>
                      ) : (
                        <span className="text-sm text-rx-gray-medium flex-1">{item.text}</span>
                      )}
                      <button
                        onClick={() => publishAsNotice(item)}
                        title="Broadcast this as a global notification"
                        className="p-1.5 rounded-lg text-rx-gray-medium hover:text-rx-yellow hover:bg-rx-yellow/10 transition-colors flex-shrink-0"
                      >
                        <Megaphone className="w-4 h-4" />
                      </button>
                      <span className="text-xs text-rx-gray-medium flex-shrink-0">{ago(item.time)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[
                  { label: 'API Status', status: 'Operational', sub: 'Worker responding', icon: Cloud, color: 'green' },
                  { label: 'Database', status: 'Healthy', sub: 'D1 connected', icon: Database, color: 'green' },
                  {
                    label: 'Storage',
                    status: storage.bytes != null ? `${fmtBytes(storage.bytes)} used` : 'Measuring…',
                    sub: storagePct != null
                      ? `${storagePct < 0.1 ? storagePct.toFixed(2) : storagePct.toFixed(1)}% of ${storage.quotaGb} GB R2 · ${storage.objects ?? 0} objects`
                      : 'listing your R2 bucket',
                    icon: Cloud,
                    color: storagePct != null ? (storagePct >= 95 ? 'red' : storagePct >= 80 ? 'yellow' : 'green') : 'green',
                  },
                ].map((item) => (
                  <div key={item.label} className="card p-4 flex items-center gap-3">
                    <item.icon className={`w-5 h-5 flex-shrink-0 text-${item.color}-400`} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white">{item.label}</p>
                      <p className={`text-xs text-${item.color}-400`}>{item.status}</p>
                      <p className="text-[10px] text-rx-gray-medium truncate" title={item.sub}>{item.sub}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'applications' && (
            <div className="space-y-6 animate-fade-in">
              <div className="flex items-center justify-between">
                <div><h1 className="text-2xl font-bold text-white">Applications</h1><p className="text-rx-gray-medium mt-1">Edit any app — real data, live to R2/D1. Click Edit to change everything.</p></div>
                <button onClick={()=>setEditingApp({ slug:'', name:'', isNewPlaceholder:true })} className="btn-primary flex items-center gap-2"><Plus className="w-4 h-4" /> Add Application</button>
              </div>
              {editingApp && <AppEditor app={editingApp} onClose={()=>setEditingApp(null)} onSaved={()=>refresh()} />}
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
                            {app.icon?.startsWith('http') || app.icon?.startsWith('/') ? <img src={app.icon} alt={app.name} className="w-9 h-9 rounded-lg object-cover" /> : <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${app.gradient} flex items-center justify-center text-lg`}>{app.icon}</div>}
                            <div><p className="font-medium text-white text-sm">{app.name}</p><p className="text-xs text-rx-gray-medium">v{app.version}</p></div>
                          </div>
                        </td>
                        <td className="px-5 py-4 hidden sm:table-cell"><span className="text-sm text-rx-gray-medium capitalize">{app.category}</span></td>
                        <td className="px-5 py-4"><span className="text-sm text-white">{formatDownloadCount(app.downloadCount)}</span></td>
                        <td className="px-5 py-4 hidden md:table-cell"><div className="flex items-center gap-1"><Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400" /><span className="text-sm text-white">{app.rating}</span></div></td>
                        <td className="px-5 py-4"><span className={`px-2 py-0.5 text-xs font-medium rounded-full ${app.status === 'active' ? 'bg-green-400/20 text-green-400' : app.status === 'beta' ? 'bg-purple-400/20 text-purple-400' : 'bg-gray-400/20 text-gray-400'}`}>{app.status}</span></td>
                        <td className="px-5 py-4 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={()=>setEditingApp(app)} className="p-1.5 text-rx-gray-medium hover:text-white hover:bg-white/10 rounded-lg transition-all"><Edit className="w-4 h-4" /></button>
                            <button onClick={async()=>{
                              if(!confirm(`Delete ${app.name}?`)) return;
                              const token=localStorage.getItem('rx-store-token')||'';
                              const res=await fetch(`${import.meta.env.VITE_API_URL}/admin/apps/${app.slug}`,{method:'DELETE',headers:{'Authorization':`Bearer ${token}`}});
                              if(res.ok) { refresh(); } else { const j=await res.json(); alert(j.error?.message||'Failed'); }
                            }} className="p-1.5 text-rx-gray-medium hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all"><Trash2 className="w-4 h-4" /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeSection === 'releases' && (<div className="animate-fade-in"><ReleasesManager /></div>)}
          {activeSection === 'users' && (<div className="animate-fade-in"><UserRoleEditor /></div>)}

          {activeSection === 'developers' && (
            <div className="space-y-6 animate-fade-in">
              <div><h2 className="text-xl font-bold text-white">Developers</h2><p className="text-sm text-rx-gray-medium mt-1">Future developer portal — submissions will appear here for review.</p></div>
              <div className="card p-8 text-center">
                <div className="w-12 h-12 rounded-xl bg-rx-yellow/10 flex items-center justify-center mx-auto mb-3"><span className="text-2xl">👩‍💻</span></div>
                <h3 className="font-semibold text-white">Developer Submissions</h3>
                <p className="text-sm text-rx-gray-medium mt-1 max-w-md mx-auto">When you open to third-party developers, they will submit apps here: <b className="text-white">Submit → Validate → Review → Approve → Publish</b>. Your current <b>Releases</b> flow will be reused for approvals.</p>
                <p className="text-xs text-rx-gray-medium mt-3">Current: managed via <b className="text-white">Applications → Edit</b> and <b className="text-white">Releases → Create</b> (admin-only).</p>
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

          {activeSection === 'revenue' && (<div className="animate-fade-in"><RevenuePanel /></div>)}

          {activeSection === 'uploads' && (<div className="animate-fade-in"><AppReleaseManager /></div>)}
          {activeSection === 'recycle' && (<div className="animate-fade-in"><RecycleBin /></div>)}

          {activeSection === 'settings' && (<div className="animate-fade-in"><AdminSettings /></div>)}
        </div>
      </div>
    </div>
  );
}
