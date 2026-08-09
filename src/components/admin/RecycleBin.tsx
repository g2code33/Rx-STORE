import { useEffect, useState } from 'react';
import { Trash2, RefreshCw, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL } from '../../services/api';
import AppLogo from '../apps/AppLogo';

export default function RecycleBin() {
  const [apps, setApps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const token = localStorage.getItem('rx-store-token') || '';

  const fetchRecycle = async () => {
    if (!API_URL) { setLoading(false); return; }
    try {
      const res = await fetch(`${API_URL}/admin/recycle`, { headers: { 'Authorization': `Bearer ${token}` } });
      const j = await res.json();
      if (res.ok) setApps(j.data?.apps || []);
    } catch {}
    setLoading(false);
  };
  useEffect(() => { fetchRecycle(); }, []);

  const restore = async (slug: string) => {
    try {
      const res = await fetch(`${API_URL}/admin/apps/${slug}/restore`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || 'Failed');
      toast.success(`Restored ${slug}`);
      fetchRecycle();
    } catch (e:any) { toast.error(e.message); }
  };

  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  const purge = async (slug: string) => {
    setPurging(true);
    try {
      const res = await fetch(`${API_URL}/admin/apps/${slug}/purge`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || 'Failed');
      toast.success(`Permanently deleted ${slug}${j.data?.r2_objects_removed ? ` (+${j.data.r2_objects_removed} R2 files)` : ''}`);
      setConfirmPurge(null);
      fetchRecycle();
    } catch (e:any) { toast.error(e.message); }
    finally { setPurging(false); }
  };

  if (loading) return <div className="card p-8 text-center text-rx-gray-medium flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin"/> Loading recycle bin…</div>;

  return (
    <div className="space-y-6">
      <div><h2 className="text-xl font-bold text-white">Recycle Bin — Admin</h2><p className="text-sm text-rx-gray-medium mt-1">Soft-deleted apps — restore or permanently delete.</p></div>
      {apps.length===0 ? <div className="card p-8 text-center text-rx-gray-medium">Recycle bin empty — no deleted apps.</div> : (
        <div className="space-y-3">
          {apps.map((a:any)=>(
            <div key={a.slug} className="card p-4 flex items-center gap-4">
              <AppLogo app={a} size="w-12 h-12" text="text-xl" rounded="rounded-xl" />
              <div className="flex-1">
                <p className="font-semibold text-white">{a.name} <span className="text-xs text-rx-gray-medium">({a.slug})</span></p>
                <p className="text-xs text-rx-gray-medium">Deleted: {a.deleted_at || a.updated_at}</p>
              </div>
              <button onClick={()=>restore(a.slug)} className="px-3 py-1.5 rounded-xl bg-green-500/10 hover:bg-green-500/20 border border-green-500/20 text-green-400 text-sm flex items-center gap-1"><RefreshCw className="w-4 h-4"/> Restore</button>
              {confirmPurge === a.slug ? (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={()=>purge(a.slug)}
                    disabled={purging}
                    className="px-3 py-1.5 rounded-xl bg-red-500 hover:bg-red-400 text-white text-sm font-semibold flex items-center gap-1 disabled:opacity-50"
                  >
                    {purging ? <Loader2 className="w-4 h-4 animate-spin"/> : <Trash2 className="w-4 h-4"/>} Delete forever?
                  </button>
                  <button onClick={()=>setConfirmPurge(null)} className="px-2.5 py-1.5 rounded-xl bg-white/5 border border-white/10 text-rx-gray-medium text-sm">Cancel</button>
                </div>
              ) : (
                <button
                  onClick={()=>setConfirmPurge(a.slug)}
                  title="Permanently delete — cannot be undone"
                  className="px-3 py-1.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 text-sm flex items-center gap-1"
                >
                  <Trash2 className="w-4 h-4"/> Delete forever
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
