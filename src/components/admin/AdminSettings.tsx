import { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Shield, Database, Loader2, Lock, Save, Megaphone, ToggleLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL, invalidatePublicSettings } from '../../services/api';

type Settings = Record<string, string>;

const TOGGLES: { key: string; label: string; desc: string; danger?: boolean }[] = [
  { key: 'maintenance_mode', label: 'Maintenance mode', desc: 'Hides the catalog and downloads from visitors (admins keep full access). Use before big releases.', danger: true },
  { key: 'ai_enabled', label: 'RX Assistant (AI chat)', desc: 'Shows the floating assistant and answers questions from your live app catalog. Turn off to hide it everywhere instantly.' },
  { key: 'allow_registration', label: 'New user registration', desc: 'When off, the sign-up API rejects new accounts. Existing users can still sign in.' },
  { key: 'downloads_open', label: 'Downloads', desc: 'Master switch for installs. Turn off to stop all new downloads (e.g. while swapping binaries).' },
  { key: 'reviews_open', label: 'App reviews', desc: 'When off, users can read reviews but cannot post new ones.' },
  { key: 'ios_recommend_pwa', label: 'Recommend PWA on iPhone/iPad', desc: 'When on, visitors on iPhone & iPad are offered Web/PWA install (Safari → Add to Home Screen) as the recommended download instead of a native iOS package. Switch anytime — takes effect instantly.' },
];

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`w-11 h-6 rounded-full relative transition-colors flex-shrink-0 disabled:opacity-50 ${on ? 'bg-rx-yellow' : 'bg-rx-dark-tertiary border border-white/10'}`}
    >
      <span className={`w-4 h-4 rounded-full absolute top-1 transition-all ${on ? 'right-1 bg-rx-dark' : 'left-1 bg-white/70'}`} />
    </button>
  );
}

export default function AdminSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingToggle, setLoadingToggle] = useState('');
  const [loading, setLoading] = useState('');
  const [showResetModal, setShowResetModal] = useState<null | 'stats' | 'apps'>(null);
  const [pwd, setPwd] = useState('');
  const token = localStorage.getItem('rx-store-token') || '';

  useEffect(() => {
    if (!API_URL || !token) return;
    fetch(`${API_URL}/admin/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((j) => { if (j?.data) setSettings(j.data); })
      .catch(() => toast.error('Could not load settings'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (updates: Settings) => {
    const res = await fetch(`${API_URL}/admin/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ settings: updates }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j?.error?.message || 'Save failed');
    setSettings((s) => ({ ...(s || {}), ...updates }));
    invalidatePublicSettings();
    return j;
  };

  const flip = async (key: string, value: boolean) => {
    setLoadingToggle(key);
    try {
      await save({ [key]: value ? '1' : '0' });
      toast.success(`${TOGGLES.find((t) => t.key === key)?.label}: ${value ? 'ON' : 'OFF'}`);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoadingToggle(''); }
  };

  const saveGeneral = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await save({
        platform_name: settings.platform_name || 'RX Store',
        support_email: settings.support_email || '',
        announcement: settings.announcement || '',
      });
      toast.success('General settings saved');
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

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
    if (pwd.trim() !== 'iseedeAdpeople#233') { toast.error('Wrong password'); return; }
    await call('/admin/reset-stats', { password: pwd });
    setShowResetModal(null); setPwd('');
  };
  const doResetApps = async () => {
    if (pwd.trim() !== 'iseedeAdpeople#233') { toast.error('Wrong password'); return; }
    if (!confirm('Delete ALL applications? This cannot be undone.')) return;
    await call('/admin/apps/reset', { password: pwd });
    setShowResetModal(null); setPwd('');
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Platform Settings</h2>
        <p className="text-sm text-rx-gray-medium mt-1">Real, live controls — every change saves to the server and takes effect instantly.</p>
      </div>

      {/* Store Controls — REAL toggles, enforced by the API */}
      <div className="card p-6">
        <h3 className="font-bold text-white mb-1 flex items-center gap-2"><ToggleLeft className="w-4 h-4 text-rx-yellow" /> Store Controls</h3>
        <p className="text-xs text-rx-gray-medium mb-4">Enforced by the API the moment you flip them.</p>
        {!settings ? (
          <div className="py-4 text-center text-rx-gray-medium text-sm flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : (
          <div className="divide-y divide-white/5">
            {TOGGLES.map((t) => {
              const on = settings[t.key] === '1';
              return (
                <div key={t.key} className="flex items-center justify-between gap-4 py-3.5">
                  <div>
                    <p className={`text-sm font-medium ${t.danger && on ? 'text-amber-300' : 'text-white'}`}>{t.label}</p>
                    <p className="text-xs text-rx-gray-medium mt-0.5 max-w-lg">{t.desc}</p>
                  </div>
                  {loadingToggle === t.key
                    ? <Loader2 className="w-4 h-4 animate-spin text-rx-yellow flex-shrink-0" />
                    : <Toggle on={on} onChange={(v) => flip(t.key, v)} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* General — saves to the server, announcement shows storefront-wide */}
      <div className="card p-6">
        <h3 className="font-bold text-white mb-4">General</h3>
        {settings && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-rx-gray-medium mb-1.5">Platform Name</label>
              <input
                type="text"
                value={settings.platform_name || ''}
                onChange={(e) => setSettings({ ...settings, platform_name: e.target.value })}
                className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-rx-yellow/50 transition-all"
              />
              <p className="text-[11px] text-rx-gray-medium mt-1">Shown in the header & footer.</p>
            </div>
            <div>
              <label className="block text-sm text-rx-gray-medium mb-1.5">Support Email</label>
              <input
                type="email"
                value={settings.support_email || ''}
                onChange={(e) => setSettings({ ...settings, support_email: e.target.value })}
                className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-rx-yellow/50 transition-all"
              />
              <p className="text-[11px] text-rx-gray-medium mt-1">Footer mail button points here.</p>
            </div>
            <div>
              <label className="block text-sm text-rx-gray-medium mb-1.5 flex items-center gap-1.5"><Megaphone className="w-3.5 h-3.5 text-rx-yellow" /> Announcement banner</label>
              <input
                type="text"
                value={settings.announcement || ''}
                onChange={(e) => setSettings({ ...settings, announcement: e.target.value })}
                placeholder='e.g. "CLINICAL RX 1.4.3 is live — apology for the wait 🎉" (empty = hidden)'
                className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-rx-yellow/50 transition-all"
              />
              <p className="text-[11px] text-rx-gray-medium mt-1">Yellow banner across the top of every page. Clear it to hide.</p>
            </div>
            <button
              onClick={saveGeneral}
              disabled={saving}
              className="w-full py-2.5 rounded-xl bg-rx-yellow text-rx-dark font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 hover:bg-rx-yellow-light transition-colors"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save General Settings
            </button>
          </div>
        )}
      </div>

      {/* Branding + fresh start */}
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

      {/* Payments — honest state */}
      <div className="card p-6">
        <h3 className="font-semibold text-white">Payments</h3>
        <p className="text-xs text-rx-gray-medium mt-1">Not configured yet. Checkout (Paystack / Mobile Money) arrives in a future release — the API route <code className="px-1 bg-white/10 rounded">/payments/initialize</code> is already wired for it.</p>
      </div>

      <div className="card p-6 border border-red-500/10">
        <h3 className="font-semibold text-white flex items-center gap-2"><Shield className="w-4 h-4 text-red-400"/> Danger Zone</h3>
        <p className="text-xs text-rx-gray-medium mt-1">Wipe all applications (requires password). Use only to start fresh with your own apps.</p>
        <button onClick={()=>setShowResetModal('apps')} disabled={!!loading} className="mt-4 w-full py-2.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 text-sm flex items-center justify-center gap-2 disabled:opacity-50">
          <Trash2 className="w-4 h-4"/> Clear All Apps (password required)
        </button>
      </div>

      {/* Password modal */}
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
