import { useEffect, useState } from 'react';
import { Bot, Check, Key, Save, Zap, Sparkles, AlertCircle, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL } from '../../services/api';

type ProviderInfo = { id: string; enabled: boolean; hasKey: boolean; baseUrl: string; defaultModel: string; active: boolean };

export default function AIProviderPanel() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [active, setActive] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState('');
  const [testResult, setTestResult] = useState<Record<string,string>>({});

  const token = localStorage.getItem('rx-store-token') || '';

  const fetchProviders = async () => {
    if (!API_URL) {
      setProviders([
        { id: 'nvidia', enabled: false, hasKey: false, baseUrl: 'https://integrate.api.nvidia.com/v1', defaultModel: 'meta/llama-3.1-70b-instruct', active: true },
        { id: 'openrouter', enabled: false, hasKey: false, baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'meta-llama/llama-3.1-70b-instruct', active: false },
        { id: 'openai', enabled: false, hasKey: false, baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', active: false },
        { id: 'gemini', enabled: false, hasKey: false, baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-1.5-flash', active: false },
      ]); setActive('nvidia'); setLoading(false); return;
    }
    try {
      const res = await fetch(`${API_URL}/ai/providers`);
      const data = await res.json();
      if (data.success) { setProviders(data.data.providers); setActive(data.data.active); }
    } catch { /* mock */ }
    setLoading(false);
  };

  useEffect(() => { fetchProviders(); }, []);

  const save = async (provider: string) => {
    if (!API_URL) { toast('Set VITE_API_URL to save to live backend', { icon: '⚠️' }); return; }
    if (!token) { toast.error('Login as admin first'); return; }
    setSaving(provider);
    try {
      const body: any = { provider, model: models[provider] || undefined };
      if (keys[provider]) body.apiKey = keys[provider];
      const res = await fetch(`${API_URL}/admin/ai/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || data.error || 'Failed');
      toast.success(`${provider} saved — now active`);
      setKeys(k => ({ ...k, [provider]: '' }));
      fetchProviders();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(''); }
  };

  const activate = async (provider: string) => {
    if (!API_URL || !token) return;
    setSaving(provider);
    try {
      const res = await fetch(`${API_URL}/admin/ai/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ provider, model: models[provider] || providers.find(p=>p.id===provider)?.defaultModel }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed');
      toast.success(`${provider} is now the active provider`);
      fetchProviders();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(''); }
  };

  const testProvider = async (provider: string) => {
    if (!API_URL) { toast.error('Set VITE_API_URL'); return; }
    setTesting(provider);
    setTestResult(r=>({ ...r, [provider]: '' }));
    try {
      const res = await fetch(`${API_URL}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', ...(token?{'Authorization':`Bearer ${token}`}:{}) },
        body: JSON.stringify({ message: 'Test: say hello in one sentence', provider }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || j.error?.error || 'Failed');
      const txt = j.data?.response || j.response || JSON.stringify(j).slice(0,300);
      setTestResult(r=>({ ...r, [provider]: txt }));
      toast.success(`${provider} responded`);
    } catch (e:any) {
      setTestResult(r=>({ ...r, [provider]: 'Error: ' + e.message }));
      toast.error(e.message);
    }
    setTesting('');
  };

  if (loading) return <div className="card p-8 text-center text-rx-gray-medium flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin"/> Loading providers…</div>;

  const brand: Record<string, { color: string; label: string; desc: string }> = {
    nvidia: { color: '#76B900', label: 'NVIDIA', desc: 'Main — Llama 70B via integrate.api.nvidia.com' },
    openrouter: { color: '#8B5CF6', label: 'OpenRouter', desc: '200+ models via one key — great fallback' },
    openai: { color: '#10A37F', label: 'OpenAI', desc: 'GPT-4o mini — reliable fallback' },
    gemini: { color: '#4285F4', label: 'Google Gemini', desc: 'Gemini Flash — free tier + fast' },
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h2 className="text-xl font-bold text-white flex items-center gap-2"><Bot className="w-5 h-5 text-rx-yellow"/> AI Providers</h2><p className="text-sm text-rx-gray-medium mt-1">NVIDIA is main. Add keys via admin — no CLI needed. Fallback is automatic.</p></div>
        {!API_URL && <span className="text-xs px-2 py-1 rounded-full bg-rx-yellow/20 text-rx-yellow flex items-center gap-1"><AlertCircle className="w-3 h-3"/> Offline mock — set VITE_API_URL to go live</span>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {providers.map(p => {
          const b = brand[p.id] || { color: '#8899AA', label: p.id, desc: '' };
          const isActive = p.id === active;
          return (
            <div key={p.id} className={`card p-5 border-2 transition-all ${isActive ? 'border-rx-yellow/40 bg-rx-yellow/[0.04]' : 'border-white/5'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm" style={{ background: b.color }}>{p.id.slice(0,2).toUpperCase()}</div>
                  <div>
                    <p className="font-semibold text-white flex items-center gap-2">{b.label} {isActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rx-yellow text-rx-dark font-bold flex items-center gap-1"><Zap className="w-3 h-3"/> ACTIVE</span>} {p.hasKey && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400 flex items-center gap-1"><Check className="w-3 h-3"/> key set</span>}</p>
                    <p className="text-xs text-rx-gray-medium mt-0.5">{b.desc}</p>
                    <p className="text-[11px] text-rx-gray-medium/70 mt-1 truncate max-w-[220px]">{p.baseUrl}</p>
                  </div>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                <div>
                  <label className="text-xs text-rx-gray-medium">Model</label>
                  <input value={models[p.id] ?? ''} placeholder={p.defaultModel} onChange={e=>setModels(m=>({...m,[p.id]:e.target.value}))} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder:text-rx-gray-medium/60 focus:outline-none focus:border-rx-yellow/40"/>
                </div>
                <div>
                  <label className="text-xs text-rx-gray-medium flex items-center gap-1"><Key className="w-3 h-3"/> API Key {p.hasKey ? '(leave blank to keep)' : ''}</label>
                  <input type="password" value={keys[p.id] ?? ''} placeholder={p.hasKey ? '••••••••••••' : p.id==='nvidia'?'nvapi-...': p.id==='openrouter'?'sk-or-...': p.id==='openai'?'sk-...':'AIza...'} onChange={e=>setKeys(k=>({...k,[p.id]:e.target.value}))} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder:text-rx-gray-medium/60 focus:outline-none focus:border-rx-yellow/40"/>
                </div>
                <div className="flex gap-2">
                  <button onClick={()=>save(p.id)} disabled={!!saving} className="flex-1 btn-primary py-2 text-sm flex items-center justify-center gap-1.5 disabled:opacity-50">
                    {saving===p.id ? <Loader2 className="w-4 h-4 animate-spin"/> : <Save className="w-4 h-4"/>} Save {p.hasKey?'Update':'+ Activate'}
                  </button>
                  {!isActive && <button onClick={()=>activate(p.id)} disabled={!!saving} className="px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white text-sm flex items-center gap-1.5"><Sparkles className="w-4 h-4"/> Make Active</button>}
                </div>
                {p.hasKey && (
                  <div className="space-y-2">
                    <button onClick={()=>testProvider(p.id)} disabled={testing===p.id} className="w-full py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white text-xs flex items-center justify-center gap-1">
                      {testing===p.id ? <><Loader2 className="w-3 h-3 animate-spin"/> Testing...</> : <>🧪 Test {p.id} API</>}
                    </button>
                    {testResult[p.id] && <div className={`p-2 rounded-lg text-xs ${testResult[p.id].startsWith('Error') ? 'bg-red-500/10 border border-red-500/20 text-red-300' : 'bg-green-500/10 border border-green-500/20 text-green-300'}`}>{testResult[p.id].slice(0,300)}</div>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card p-4 bg-rx-dark-tertiary/30 border border-white/5">
        <p className="text-sm font-medium text-white">How it works</p>
        <p className="text-xs text-rx-gray-medium mt-1">Frontend sends <code className="px-1 py-0.5 bg-white/10 rounded text-[11px]">{"{message, provider:'nvidia'}"}</code> to <code className="px-1 py-0.5 bg-white/10 rounded text-[11px]">POST /ai/chat</code>. Backend picks: request provider → D1 <code>ai_settings</code> (admin choice) → <code>env.AI_PROVIDER</code> (wrangler.toml). If chosen provider has no key or errors, it falls back to <code>AI_FALLBACK=openrouter,openai,gemini</code> automatically.</p>
      </div>
    </div>
  );
}
