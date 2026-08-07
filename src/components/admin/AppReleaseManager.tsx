import { useState } from 'react';
import { Upload, Package, Check, AlertCircle, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL } from '../../services/api';

export default function AppReleaseManager() {
  const [appId, setAppId] = useState('clinical-rx');
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const token = localStorage.getItem('rx-store-token') || '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!API_URL) { toast('Set VITE_API_URL to publish to live backend', { icon: '⚠️' }); return; }
    if (!token) { toast.error('Login as admin first'); return; }
    if (!version) { toast.error('Version required (e.g. 3.3.0)'); return; }
    setSaving(true);
    try {
      // 1. Upload to R2 via presigned URL would be ideal; for now we just create version record
      // If file selected, we first upload to Worker endpoint if it exists, else store metadata
      let fileUrl = '';
      if (file) {
        // Try R2 upload endpoint (if deployed), otherwise use placeholder
        const fd = new FormData();
        fd.append('file', file);
        fd.append('appId', appId);
        fd.append('version', version);
        try {
          const up = await fetch(`${API_URL}/admin/apps/${appId}/upload`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: fd,
          });
          const uj = await up.json();
          if (up.ok && uj.data?.url) fileUrl = uj.data.url;
          else fileUrl = `r2://rx-store-storage/apps/${appId}/${version}/${file.name}`;
        } catch { fileUrl = `r2://rx-store-storage/apps/${appId}/${version}/${file.name}`; }
      }

      const res = await fetch(`${API_URL}/admin/apps/${appId}/releases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          version,
          releaseNotes: notes.split('\n').filter(Boolean),
          platforms: fileUrl ? { generic: { fileUrl, checksum: '' } } : {},
          mandatory: false,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data.error) || 'Failed');
      toast.success(`Release ${version} created for ${appId}`);
      setVersion(''); setNotes(''); setFile(null);
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-6">
      <div><h2 className="text-xl font-bold text-white flex items-center gap-2"><Package className="w-5 h-5 text-rx-yellow"/> App Release Manager</h2><p className="text-sm text-rx-gray-medium mt-1">Publish new versions to R2 and update the version manifest. Workers will serve via <code className="px-1 py-0.5 bg-white/10 rounded text-xs">GET /updates/check</code>.</p></div>

      {!API_URL && <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-200 text-sm flex gap-2"><AlertCircle className="w-4 h-4 flex-shrink-0"/> Offline mode — form is demo until <code>VITE_API_URL</code> is set in Pages.</div>}

      <form onSubmit={submit} className="card p-6 space-y-4">
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
            <label className="text-xs text-rx-gray-medium">Version</label>
            <input value={version} onChange={e=>setVersion(e.target.value)} placeholder="3.3.0" className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm placeholder:text-rx-gray-medium/60 focus:outline-none focus:border-rx-yellow/40"/>
          </div>
        </div>
        <div>
          <label className="text-xs text-rx-gray-medium">Release Notes (one per line)</label>
          <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder={"- AI-powered drug checks\n- FHIR R4 support"} rows={3} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm placeholder:text-rx-gray-medium/60 focus:outline-none focus:border-rx-yellow/40"/>
        </div>
        <div>
          <label className="text-xs text-rx-gray-medium">Binary (APK / EXE / .deb / AppImage / IPA)</label>
          <label className="mt-1 flex items-center gap-3 p-4 rounded-xl border-2 border-dashed border-white/10 hover:border-rx-yellow/30 bg-rx-dark/50 cursor-pointer transition-colors">
            <Upload className="w-5 h-5 text-rx-gray-medium"/>
            <span className="flex-1 text-sm text-rx-gray-medium truncate">{file ? file.name + ` (${(file.size/1024/1024).toFixed(1)} MB)` : 'Click to select or drag file here'}</span>
            <input type="file" className="hidden" accept=".apk,.exe,.deb,.AppImage,.ipa,.zip" onChange={e=>setFile(e.target.files?.[0]||null)} />
            {file && <span className="text-xs px-2 py-1 rounded-full bg-green-500/20 text-green-400 flex items-center gap-1"><Check className="w-3 h-3"/> ready</span>}
          </label>
          <p className="text-[11px] text-rx-gray-medium mt-1">R2 path: <code className="px-1 py-0.5 bg-white/10 rounded">apps/{appId}/{version || 'x.y.z'}/</code></p>
        </div>
        <button type="submit" disabled={saving} className="btn-primary w-full py-2.5 flex items-center justify-center gap-2 disabled:opacity-50">{saving ? <><Loader2 className="w-4 h-4 animate-spin"/> Publishing…</> : <><Upload className="w-4 h-4"/> Publish Release</>}</button>
      </form>

      <div className="card p-4">
        <h3 className="font-semibold text-white text-sm">Verifier</h3>
        <p className="text-xs text-rx-gray-medium mt-1">After publish, test updater:</p>
        <code className="block mt-2 p-2 bg-rx-dark rounded-xl text-xs text-rx-gray-medium break-all">curl "https://rx-store-api.calcitoninpay.workers.dev/updates/check?app={appId}&currentVersion=1.0&platform=android"</code>
      </div>
    </div>
  );
}
