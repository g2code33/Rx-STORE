import { useState } from 'react';
import { RefreshCw, Trash2, Star, Download, Shield, Database, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL } from '../../services/api';

export default function AdminSettings() {
  const [loading, setLoading] = useState('');
  const token = localStorage.getItem('rx-store-token') || '';

  const call = async (path: string, method = 'POST', body?: any) => {
    if (!API_URL) { toast.error('Set VITE_API_URL to use live admin'); return; }
    if (!token) { toast.error('Login as admin'); return; }
    setLoading(path);
    try {
      const res = await fetch(`${API_URL}${path}`, { method, headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || 'Failed');
      toast.success(j.message || 'Done');
      return j;
    } catch (e:any) { toast.error(e.message); }
    finally { setLoading(''); }
  };

  const resetDownloads = async () => {
    const pwd = prompt('Enter reset password (iseedeAdpeople#233) to confirm brand-new reset:');
    if (pwd !== 'iseedeAdpeople#233') { if(pwd!==null) alert('Wrong password'); return; }
    if (!confirm('Reset ALL downloads, ratings, reviews to 0? This cannot be undone.')) return;
    await call('/admin/reset-stats', 'POST', { password: pwd });
  };

  return (
    <div className="space-y-6">
      <div><h2 className="text-xl font-bold text-white">Platform Settings</h2><p className="text-sm text-rx-gray-medium mt-1">Live controls — all changes write to D1/R2 instantly. No CLI needed after this.</p></div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-6">
          <h3 className="font-semibold text-white flex items-center gap-2"><Download className="w-4 h-4 text-rx-yellow"/> Downloads & Stats</h3>
          <p className="text-xs text-rx-gray-medium mt-1">Current seeded downloads are fake. Reset to 0 for a brand-new site — future Installs will +1 live.</p>
          <button onClick={resetDownloads} disabled={!!loading} className="mt-4 w-full py-2.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 text-amber-300 text-sm flex items-center justify-center gap-2 disabled:opacity-50">
            {loading==='/admin/reset-stats' ? <Loader2 className="w-4 h-4 animate-spin"/> : <RefreshCw className="w-4 h-4"/>} Reset all downloads / ratings to 0
          </button>
          <p className="text-[11px] text-rx-gray-medium mt-2">Or via CLI:<br/><code className="px-1 py-0.5 bg-white/10 rounded text-[10px]">npx wrangler d1 execute rx-store-db --command "UPDATE applications SET download_count=0, review_count=0, rating=0" --remote</code></p>
        </div>

        <div className="card p-6">
          <h3 className="font-semibold text-white flex items-center gap-2"><Star className="w-4 h-4 text-rx-yellow"/> Featured & Badges</h3>
          <p className="text-xs text-rx-gray-medium mt-1"><b className="text-white">Featured</b> = shows on homepage hero & “Featured” badge. Toggle per app in <b>Applications → Edit → Featured</b>. Use for launches, promos.</p>
          <div className="mt-4 p-3 rounded-xl bg-rx-dark-tertiary/50 border border-white/5">
            <p className="text-xs text-rx-gray-medium"><span className="px-1.5 py-0.5 bg-rx-yellow text-rx-dark text-[10px] font-bold rounded">FEATURED</span> <span className="px-1.5 py-0.5 bg-white text-rx-dark text-[10px] font-bold rounded">NEW</span> <span className="px-1.5 py-0.5 bg-purple-500 text-white text-[10px] font-bold rounded">BETA</span> — set via Status + Featured.</p>
          </div>
        </div>

        <div className="card p-6">
          <h3 className="font-semibold text-white flex items-center gap-2"><Database className="w-4 h-4 text-rx-yellow"/> Branding</h3>
          <p className="text-xs text-rx-gray-medium mt-1">App <b>logo</b> is now an <b>image</b>, not emoji. In <b>Applications → Edit → Logo</b> you can paste <code className="px-1 bg-white/10 rounded">https://...</code> or <b>Upload</b> a PNG (stores to R2 <code>assets/icons/</code>). All cards/detail pages render the image.</p>
          <p className="text-xs text-rx-gray-medium mt-2">Everything is editable there: name, slug, long description, screenshots, features, price, platforms, etc. — fill your real content live.</p>
        </div>

        <div className="card p-6">
          <h3 className="font-semibold text-white flex items-center gap-2"><Shield className="w-4 h-4 text-rx-yellow"/> Danger Zone</h3>
          <p className="text-xs text-rx-gray-medium mt-1">Wipe all apps and re-seed from <code>schema.sql</code> (use only to start fresh).</p>
          <button onClick={async()=>{ if(!confirm('Delete ALL apps?')) return; await call('/admin/apps/reset','POST'); }} disabled={!!loading} className="mt-4 w-full py-2.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 text-sm flex items-center justify-center gap-2 disabled:opacity-50">
            <Trash2 className="w-4 h-4"/> Reset & Re-seed Apps
          </button>
        </div>
      </div>

      <div className="card p-6">
        <h3 className="font-semibold text-white">CLI Quick Reference (also available in Admin)</h3>
        <pre className="mt-3 p-3 bg-rx-dark rounded-xl text-xs text-rx-gray-medium overflow-x-auto">
{`# check live stats
npx wrangler d1 execute rx-store-db --command "SELECT slug, download_count FROM applications" --remote
# make admin
npx wrangler d1 execute rx-store-db --command "UPDATE users SET role='admin' WHERE email='you@example.com'" --remote
# set AI keys (or use Admin → AI Providers)
npx wrangler secret put NVIDIA_API_KEY --config backend/wrangler.toml`}
        </pre>
      </div>
    </div>
  );
}
