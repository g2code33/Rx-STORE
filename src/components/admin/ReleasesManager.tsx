import { useEffect, useState } from 'react';
import { Package, Upload, Check, Clock, Shield, RefreshCw, Archive, Ban, Play, Loader2, AlertCircle, FileText } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL } from '../../services/api';
import { useApps } from '../../context/AppContext';

type Release = {
  id: string;
  application_id: string;
  app_slug: string;
  app_name: string;
  version: string;
  release_notes: string;
  release_type: string;
  channel: string;
  status: string;
  published_at?: string;
  created_at: string;
  package_count?: number;
  package_platforms?: string;
};

export default function ReleasesManager() {
  const { apps } = useApps();
  const [selectedApp, setSelectedApp] = useState(apps[0]?.slug || 'pharmagame');
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ version: '', releaseType: 'patch' as string, channel: 'stable' as string, notes: '', minSupported: '' });
  const [creating, setCreating] = useState(false);

  const token = localStorage.getItem('rx-store-token') || '';

  const fetchReleases = async () => {
    if (!API_URL) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/admin/releases?app=${selectedApp}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
      const j = await res.json();
      if (res.ok) setReleases(j.data || []);
    } catch {}
    setLoading(false);
  };
  useEffect(() => { fetchReleases(); }, [selectedApp]);
  useEffect(() => { if (apps.length && !selectedApp) setSelectedApp(apps[0].slug); }, [apps]);

  const createRelease = async () => {
    if (!form.version) { toast.error('Version required'); return; }
    setCreating(true);
    try {
      const res = await fetch(`${API_URL}/admin/releases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          slug: selectedApp,
          version: form.version,
          release_notes: form.notes.split('\n').filter(Boolean),
          release_type: form.releaseType,
          channel: form.channel,
          minimum_supported_version: form.minSupported || undefined,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || 'Failed');
      toast.success(`Release ${form.version} created — draft`);
      setShowCreate(false);
      setForm({ version: '', releaseType: 'patch', channel: 'stable', notes: '', minSupported: '' });
      fetchReleases();
    } catch (e:any) { toast.error(e.message); }
    setCreating(false);
  };

  const publish = async (id: string) => {
    if (!confirm('Publish this release? It will become visible to users and affect update checks.')) return;
    try {
      const res = await fetch(`${API_URL}/admin/releases/${id}/publish`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || 'Failed');
      toast.success('Published — users will see update');
      fetchReleases();
    } catch (e:any) { toast.error(e.message); }
  };

  const rollback = async (id: string) => {
    const pwd = prompt('Enter rollback password (iseedeAdpeople#233):');
    if (pwd !== 'iseedeAdpeople#233') { if (pwd!==null) toast.error('Wrong password'); return; }
    if (!confirm('Rollback this release to previous stable?')) return;
    try {
      const res = await fetch(`${API_URL}/admin/releases/${id}/rollback`, { method: 'POST', headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` }, body: JSON.stringify({ password: pwd }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || 'Failed');
      toast.success(`Rolled back to ${j.data?.now}`);
      fetchReleases();
    } catch (e:any) { toast.error(e.message); }
  };

  const current = releases.find(r=> r.status==='published');
  const app = apps.find(a=>a.slug===selectedApp);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2"><Package className="w-5 h-5 text-rx-yellow"/> Releases</h2>
          <p className="text-sm text-rx-gray-medium mt-1">Production release management — select app, create version, upload packages per platform, validate, publish, rollback.</p>
        </div>
        <button onClick={()=>setShowCreate(true)} className="btn-primary text-sm">+ Create New Release</button>
      </div>

      <div className="card p-4 flex items-center gap-3">
        <label className="text-sm text-rx-gray-medium">Application</label>
        <select value={selectedApp} onChange={e=>setSelectedApp(e.target.value)} className="flex-1 max-w-xs bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white">
          {apps.map(a=> <option key={a.slug} value={a.slug}>{a.name} — {a.slug} {a.version ? `(current ${a.version})` : ''}</option>)}
        </select>
        {app && <span className="text-xs text-rx-gray-medium">Current: <b className="text-white">{app.version}</b> {current && <span className="ml-2 px-2 py-0.5 bg-green-500/20 text-green-400 rounded text-xs">Published: {current.version}</span>}</span>}
      </div>

      {showCreate && (
        <div className="card p-6 space-y-4">
          <h3 className="font-semibold text-white">Create Release for {app?.name || selectedApp}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="text-xs text-rx-gray-medium">Version *</label><input value={form.version} onChange={e=>setForm({...form, version:e.target.value})} placeholder="3.3.0" className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
            <div><label className="text-xs text-rx-gray-medium">Minimum supported</label><input value={form.minSupported} onChange={e=>setForm({...form, minSupported:e.target.value})} placeholder="3.0.0" className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div><label className="text-xs text-rx-gray-medium">Release Type</label>
              <div className="flex gap-2 mt-1">{['major','minor','patch'].map(t=>(
                <button key={t} type="button" onClick={()=>setForm({...form, releaseType:t})} className={`flex-1 py-2 rounded-xl text-xs font-medium capitalize border ${form.releaseType===t ? 'bg-rx-yellow text-rx-dark border-rx-yellow' : 'bg-rx-dark border-white/10 text-rx-gray-medium'}`}>{t}</button>
              ))}</div>
            </div>
            <div><label className="text-xs text-rx-gray-medium">Channel</label>
              <div className="flex gap-2 mt-1">{['stable','beta','alpha'].map(c=>(
                <button key={c} type="button" onClick={()=>setForm({...form, channel:c})} className={`flex-1 py-2 rounded-xl text-xs font-medium capitalize border ${form.channel===c ? 'bg-green-500 text-white border-green-500' : 'bg-rx-dark border-white/10 text-rx-gray-medium'}`}>{c}</button>
              ))}</div>
            </div>
            <div className="flex items-end"><button onClick={createRelease} disabled={creating} className="w-full btn-primary py-2.5 text-sm disabled:opacity-50">{creating ? <><Loader2 className="w-4 h-4 animate-spin"/> Creating…</> : 'Create Draft'}</button></div>
          </div>
          <div><label className="text-xs text-rx-gray-medium">Release Notes</label><textarea value={form.notes} onChange={e=>setForm({...form, notes:e.target.value})} placeholder={"- Fixed quiz scoring\n- Improved performance"} rows={3} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-white/5 flex items-center justify-between">
          <h3 className="font-semibold text-white">Release History — {app?.name || selectedApp}</h3>
          <button onClick={fetchReleases} className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-rx-gray-medium"><RefreshCw className="w-4 h-4"/></button>
        </div>
        {loading ? <div className="p-8 text-center text-rx-gray-medium flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin"/> Loading…</div> : releases.length===0 ? <div className="p-8 text-center text-rx-gray-medium">No releases yet. Create the first one.</div> : (
          <div className="divide-y divide-white/5">
            {releases.map(r=>(
              <div key={r.id} className="p-4 flex items-center gap-4 hover:bg-white/5">
                <div className="flex-1">
                  <p className="font-semibold text-white flex items-center gap-2 flex-wrap">{r.version} <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${r.status==='published'?'bg-green-500 text-white':r.status==='draft'?'bg-white/10 text-rx-gray-medium':r.status==='rolled_back'?'bg-red-500 text-white':'bg-amber-500 text-white'}`}>{r.status}</span> <span className="text-[10px] px-1 py-0.5 rounded bg-white/5 text-rx-gray-medium">{r.channel}</span> {r.release_type && <span className="text-[10px] px-1 py-0.5 rounded bg-white/5 text-rx-gray-medium">{r.release_type}</span>} {(r.package_count ?? 0) > 0 ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">📦 {r.package_count} pkg: {r.package_platforms}</span> : <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">no packages — publish will fail, upload via Uploads</span>}</p>
                  <p className="text-xs text-rx-gray-medium mt-1">{r.release_notes ? (()=>{ try{ const a=JSON.parse(r.release_notes); return Array.isArray(a)?a.slice(0,2).join(' • '):r.release_notes; } catch{ return r.release_notes; } })() : ''}</p>
                  <p className="text-[11px] text-rx-gray-medium mt-1">{r.published_at ? `Published ${new Date(r.published_at).toLocaleString()}` : `Created ${new Date(r.created_at).toLocaleString()}`} {r.id && <span className="ml-2 font-mono text-[10px]">{r.id.slice(0,8)}</span>}</p>
                </div>
                <div className="flex items-center gap-1">
                  {r.status==='draft' && <button onClick={()=>publish(r.id)} className="px-3 py-1.5 rounded-lg bg-green-500 text-white text-xs font-bold flex items-center gap-1"><Play className="w-3 h-3"/> Publish</button>}
                  {r.status==='published' && <button onClick={()=>rollback(r.id)} className="px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/20 text-xs flex items-center gap-1"><RefreshCw className="w-3 h-3"/> Roll Back</button>}
                  <span className={`px-2 py-1 rounded text-xs ${r.status==='published' ? 'bg-green-500/20 text-green-400' : 'bg-white/5 text-rx-gray-medium'}`}>{r.status==='published' ? 'Current' : r.channel}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card p-4">
        <h3 className="font-semibold text-white text-sm flex items-center gap-2"><FileText className="w-4 h-4"/> Next: Upload Packages</h3>
        <p className="text-xs text-rx-gray-medium mt-1">After creating a draft, go to <b className="text-white">Uploads</b> → select same app + version → upload per-platform (Windows EXE, Linux DEB/AppImage, Android APK). Then return here to <b>Publish</b> — it verifies checksums + R2 files before going live.</p>
      </div>
    </div>
  );
}
