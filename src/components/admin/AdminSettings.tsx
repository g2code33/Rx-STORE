import { useState } from 'react';
import { RefreshCw, Trash2, Shield, Database, Loader2, DollarSign, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL } from '../../services/api';

export default function AdminSettings() {
  const [loading, setLoading] = useState('');
  const [showResetModal, setShowResetModal] = useState<null | 'stats' | 'apps'>(null);
  const [pwd, setPwd] = useState('');
  const token = localStorage.getItem('rx-store-token') || '';

  const call = async (path: string, body?: any) => {
    if (!API_URL) { toast.error('Set VITE_API_URL to use live admin'); return; }
    if (!token) { toast.error('Login as admin'); return; }
    setLoading(path);
    try {
      const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || 'Failed');
      toast.success(j.data?.message || j.message || 'Done');
      return j;
    } catch (e:any) { toast.error(e.message); }
    finally { setLoading(''); }
  };

  const doResetStats = async () => {
    if (pwd.trim() !== 'iseedeAdpeople#233') { toast.error('Wrong password — must be iseedeAdpeople#233'); return; }
    await call('/admin/reset-stats', { password: pwd });
    setShowResetModal(null); setPwd('');
  };
  const doResetApps = async () => {
    if (pwd.trim() !== 'iseedeAdpeople#233') { toast.error('Wrong password — must be iseedeAdpeople#233'); return; }
    if (!confirm('Delete ALL applications? This cannot be undone.')) return;
    await call('/admin/apps/reset', { password: pwd });
    setShowResetModal(null); setPwd('');
  };

  return (
    <div className="space-y-6">
      <div><h2 className="text-xl font-bold text-white">Platform Settings</h2><p className="text-sm text-rx-gray-medium mt-1">Live controls + general configuration. All changes are instant.</p></div>

      {/* General Settings — restored */}
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

      {/* Security Settings — restored */}
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

      {/* Payment Configuration — restored */}
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

      {/* Branding & Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-6">
          <h3 className="font-semibold text-white flex items-center gap-2"><Database className="w-4 h-4 text-rx-yellow"/> Branding</h3>
          <p className="text-xs text-rx-gray-medium mt-1">App <b>logo</b> is now an <b>image</b>, not emoji. In <b>Applications → Edit → Logo</b> paste <code className="px-1 bg-white/10 rounded">https://...</code> or <b>Upload</b> PNG (R2 <code>assets/icons/</code>).</p>
        </div>
        <div className="card p-6">
          <h3 className="font-semibold text-white">Brand New Site</h3>
          <p className="text-xs text-rx-gray-medium mt-1">Current seeded stats are demo. Reset to zero to start fresh — future installs & payments will count live.</p>
          <button onClick={()=>setShowResetModal('stats')} disabled={!!loading} className="mt-4 w-full py-2.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 text-amber-300 text-sm flex items-center justify-center gap-2 disabled:opacity-50">
            <RefreshCw className="w-4 h-4"/> Reset all downloads / ratings to 0
          </button>
        </div>
      </div>

      <div className="card p-6 border border-red-500/10">
        <h3 className="font-semibold text-white flex items-center gap-2"><Shield className="w-4 h-4 text-red-400"/> Danger Zone</h3>
        <p className="text-xs text-rx-gray-medium mt-1">Wipe all applications (requires password). Use only to start fresh with your own apps.</p>
        <button onClick={()=>setShowResetModal('apps')} disabled={!!loading} className="mt-4 w-full py-2.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 text-sm flex items-center justify-center gap-2 disabled:opacity-50">
          <Trash2 className="w-4 h-4"/> Clear All Apps (password required)
        </button>
      </div>

      {/* Password modal — hidden input */}
      {showResetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-rx-dark-secondary border border-white/10 rounded-2xl w-full max-w-md p-6">
            <h3 className="font-bold text-white flex items-center gap-2"><Lock className="w-4 h-4"/> Enter reset password</h3>
            <p className="text-xs text-rx-gray-medium mt-1">This action requires your admin password to prevent accidents.</p>
            <input type="password" value={pwd} onChange={e=>setPwd(e.target.value)} placeholder="••••••••" autoFocus className="mt-4 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-rx-yellow/50" />
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={()=>{setShowResetModal(null); setPwd('');}} className="px-4 py-2 rounded-xl bg-white/5 text-white border border-white/10 text-sm">Cancel</button>
              <button onClick={showResetModal==='stats' ? doResetStats : doResetApps} disabled={!!loading} className="px-4 py-2 rounded-xl bg-rx-yellow text-rx-dark font-bold text-sm flex items-center gap-1 disabled:opacity-50">
                {loading ? <Loader2 className="w-4 h-4 animate-spin"/> : null} Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card p-6">
        <h3 className="font-semibold text-white">CLI Quick Reference</h3>
        <pre className="mt-3 p-3 bg-rx-dark rounded-xl text-xs text-rx-gray-medium overflow-x-auto">
{`# check live stats
npx wrangler d1 execute rx-store-db --command "SELECT slug, download_count FROM applications" --remote
# set AI keys (or use Admin → AI Providers)
npx wrangler secret put NVIDIA_API_KEY --config backend/wrangler.toml`}
        </pre>
      </div>
    </div>
  );
}
