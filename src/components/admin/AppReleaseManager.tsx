import { useState } from 'react';
import { Upload, Package, Check, AlertCircle, Loader2, Monitor, Smartphone, Laptop, Globe } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL } from '../../services/api';

const platforms = [
  { id: 'windows', label: 'Windows', ext: 'EXE', accept: '.exe', icon: Monitor },
  { id: 'linux', label: 'Linux', ext: 'DEB', accept: '.deb,.AppImage', icon: Laptop },
  { id: 'android', label: 'Android', ext: 'APK', accept: '.apk', icon: Smartphone },
  { id: 'ios', label: 'iOS', ext: 'IPA', accept: '.ipa', icon: Smartphone },
  { id: 'web', label: 'Web', ext: 'ZIP', accept: '.zip', icon: Globe },
];

export default function AppReleaseManager() {
  const [appId, setAppId] = useState('clinical-rx');
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [saving, setSaving] = useState(false);

  const token = localStorage.getItem('rx-store-token') || '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!API_URL) { toast('Set VITE_API_URL to publish live', { icon: '⚠️' }); return; }
    if (!token) { toast.error('Login as admin'); return; }
    if (!version) { toast.error('Version required'); return; }
    const hasFile = Object.values(files).some(Boolean);
    if (!hasFile) { toast.error('Select at least one platform file (EXE/DEB/APK/IPA/ZIP)'); return; }
    setSaving(true);
    try {
      const platformsObj: any = {};
      for (const p of platforms) {
        const f = files[p.id];
        if (!f) continue;
        const fd = new FormData();
        fd.append('file', f);
        fd.append('kind', `apps/${appId}/${version}`);
        fd.append('slug', appId);
        try {
          const up = await fetch(`${API_URL}/admin/upload`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd });
          const uj = await up.json();
          if (up.ok && uj.data?.url) platformsObj[p.id] = { fileUrl: uj.data.url, fileName: f.name, size: f.size };
          else platformsObj[p.id] = { fileUrl: `r2://rx-store-storage/apps/${appId}/${version}/${p.id}/${f.name}`, fileName: f.name, size: f.size };
        } catch {
          platformsObj[p.id] = { fileUrl: `r2://rx-store-storage/apps/${appId}/${version}/${p.id}/${f.name}`, fileName: f.name, size: f.size };
        }
      }

      const res = await fetch(`${API_URL}/admin/apps/${appId}/releases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ version, releaseNotes: notes.split('\n').filter(Boolean), platforms: platformsObj, mandatory: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed');
      toast.success(`Release ${version} published for ${appId} (${Object.keys(platformsObj).join(', ')})`);
      setVersion(''); setNotes(''); setFiles({});
    } catch (e:any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-6">
      <div><h2 className="text-xl font-bold text-white flex items-center gap-2"><Package className="w-5 h-5 text-rx-yellow"/> App Release Manager</h2><p className="text-sm text-rx-gray-medium mt-1">Upload per-platform binaries to R2 — users will choose Windows (EXE), Linux (DEB), Android (APK) in the download modal.</p></div>

      {!API_URL && <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-200 text-sm flex gap-2"><AlertCircle className="w-4 h-4 flex-shrink-0"/> Offline — set VITE_API_URL to publish live.</div>}

      <form onSubmit={submit} className="card p-6 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-rx-gray-medium">Application</label>
            <select value={appId} onChange={e=>setAppId(e.target.value)} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm">
              <option value="clinical-rx">Clinical Rx</option>
              <option value="pharmagame">PharmaGAME</option>
              <option value="code-rx-society">Code Rx Society</option>
              <option value="tawomo">TAWOMO</option>
              <option value="curelink">CureLink</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-rx-gray-medium">Version *</label>
            <input value={version} onChange={e=>setVersion(e.target.value)} placeholder="3.3.0" className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm placeholder:text-rx-gray-medium/60 focus:outline-none focus:border-rx-yellow/40"/>
          </div>
        </div>

        <div>
          <label className="text-xs text-rx-gray-medium">Release Notes (one per line)</label>
          <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder={"- Windows EXE signed\n- Linux DEB for Ubuntu 22.04\n- Android APK"} rows={3} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm placeholder:text-rx-gray-medium/60 focus:outline-none focus:border-rx-yellow/40"/>
        </div>

        <div>
          <label className="text-xs text-rx-gray-medium mb-2 block">Platform Binaries *</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {platforms.map(p => {
              const Icon = p.icon;
              const f = files[p.id];
              return (
                <label key={p.id} className={`flex items-center gap-3 p-3 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${f ? 'border-green-500/30 bg-green-500/5' : 'border-white/10 hover:border-rx-yellow/30 bg-rx-dark/50'}`}>
                  <div className="w-10 h-10 rounded-lg bg-rx-dark-tertiary flex items-center justify-center"><Icon className="w-5 h-5 text-rx-gray-medium"/></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white flex items-center gap-2">{p.label} <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-rx-gray-medium">{p.ext}</span></p>
                    <p className="text-xs text-rx-gray-medium truncate">{f ? `${f.name} (${(f.size/1024/1024).toFixed(1)} MB)` : `Select ${p.ext}`}</p>
                  </div>
                  {f && <Check className="w-4 h-4 text-green-400"/>}
                  <input type="file" className="hidden" accept={p.accept} onChange={e=>setFiles(prev=>({ ...prev, [p.id]: e.target.files?.[0] || null }))} />
                </label>
              );
            })}
          </div>
          <p className="text-[11px] text-rx-gray-medium mt-2">R2: <code className="px-1 py-0.5 bg-white/10 rounded">apps/{appId}/{version || 'x.y.z'}/{'{windows,linux,android}'}/</code> — download modal will show only uploaded platforms.</p>
        </div>

        <button type="submit" disabled={saving} className="btn-primary w-full py-2.5 flex items-center justify-center gap-2 disabled:opacity-50">{saving ? <><Loader2 className="w-4 h-4 animate-spin"/> Publishing…</> : <><Upload className="w-4 h-4"/> Publish Release for {Object.keys(files).filter(k=>files[k]).length || 0} platform(s)</>}</button>
      </form>

      <div className="card p-4">
        <h3 className="font-semibold text-white text-sm">After publish — download is powerful:</h3>
        <ul className="text-xs text-rx-gray-medium mt-2 space-y-1 list-disc list-inside">
          <li>User clicks <b className="text-white">Install</b> on card or <b className="text-white">AppDetail</b> → sees chooser: Windows (EXE), Linux (DEB), Android (APK) — only your uploaded platforms appear</li>
          <li>Choosing a platform → <code className="px-1 bg-white/10 rounded">GET /apps/:slug/download?platform=windows</code> → Worker returns real R2 URL + increments `download_count` + records in `downloads` → browser triggers download</li>
          <li>Test: <code className="px-1 bg-white/10 rounded">curl "https://rx-store-api.calcitoninpay.workers.dev/v1/apps/clinical-rx/download?platform=android"</code></li>
        </ul>
      </div>
    </div>
  );
}
