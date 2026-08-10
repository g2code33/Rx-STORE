import React, { useEffect, useState } from 'react';
import { Upload, Package, Check, AlertCircle, Loader2, Monitor, Smartphone, Laptop, Globe, Play, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL } from '../../services/api';
import { useApps } from '../../context/AppContext';

const platforms = [
  { id: 'windows', label: 'Windows', ext: 'EXE', accept: '.exe,.msi', icon: Monitor },
  { id: 'linux_deb', label: 'Linux (DEB)', ext: 'DEB', accept: '.deb', icon: Laptop },
  { id: 'linux_appimage', label: 'Linux (AppImage)', ext: 'AppImage', accept: '.AppImage', icon: Laptop },
  { id: 'android', label: 'Android', ext: 'APK', accept: '.apk', icon: Smartphone },
  { id: 'ios', label: 'iOS', ext: 'IPA', accept: '.ipa', icon: Smartphone },
];

type ReleaseRow = { id: string; version: string; status: string; channel: string; package_count?: number; package_platforms?: string };

export default function AppReleaseManager() {
  const { apps } = useApps();
  const [appId, setAppId] = useState('');
  const [releases, setReleases] = useState<ReleaseRow[]>([]);
  const [releaseId, setReleaseId] = useState(''); // '' = creating new
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [uploading, setUploading] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishedVersion, setPublishedVersion] = useState('');

  const token = localStorage.getItem('rx-store-token') || '';
  const app = apps.find(a => a.slug === appId);
  const release = releases.find(r => r.id === releaseId);
  const creatingNew = !releaseId || releaseId === '__new__';
  const anyUploaded = Object.values(uploading).some(s => s?.startsWith('Stored'));

  useEffect(() => { if (!appId && apps.length) setAppId(apps[0].slug); }, [apps]);

  const fetchReleases = async () => {
    if (!API_URL || !appId) return;
    try {
      const res = await fetch(`${API_URL}/admin/releases?app=${appId}`, { headers: { 'Authorization': `Bearer ${token}` } });
      const j = await res.json();
      const arr = j?.data || [];
      if (Array.isArray(arr)) setReleases(arr);
    } catch {}
  };
  useEffect(() => { setReleaseId(''); setPublishedVersion(''); setUploading({}); setFiles({}); fetchReleases(); }, [appId]);

  const createDraft = async (): Promise<string | null> => {
    if (!version.trim()) { toast.error('Version required'); return null; }
    setCreating(true);
    try {
      const res = await fetch(`${API_URL}/admin/releases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ slug: appId, version: version.trim(), release_notes: notes.split('\n').filter(Boolean), release_type: 'minor', channel: 'stable' }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || j.error || 'Failed');
      const id = j.data?.id;
      toast.success(`Draft release ${version} created — now upload packages below`);
      await fetchReleases();
      setReleaseId(id);
      return id as string;
    } catch (e: any) { toast.error(e.message); return null; }
    finally { setCreating(false); }
  };

  // Files ≤50 MB go in one shot (Server hashes them). Bigger installers use a
  // chunked R2 multipart upload (8 MB parts) with the checksum computed here.
  const CHUNK_THRESHOLD = 50 * 1024 * 1024;
  const PART_SIZE = 8 * 1024 * 1024;

  const sha256Hex = async (file: File): Promise<string> => {
    const buf = await file.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const uploadOne = async (id: string, platformId: string, f: File): Promise<any> => {
    if (f.size <= CHUNK_THRESHOLD) {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('platform', platformId);
      const up = await fetch(`${API_URL}/admin/releases/${id}/upload`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd });
      const uj = await up.json();
      if (!up.ok) throw new Error(uj.error?.message || uj.error || 'Upload failed');
      return uj.data?.package;
    }
    // --- chunked multipart for big installers (up to 500 MB) ---
    const sha = await sha256Hex(f);
    const st = await fetch(`${API_URL}/admin/releases/${id}/upload/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ platform: platformId, filename: f.name, size: f.size, mimeType: f.type || 'application/octet-stream' }),
    });
    const sj = await st.json();
    if (!st.ok) throw new Error(sj.error?.message || sj.error || 'Start failed');
    const { uploadId, key } = sj.data;
    const totalParts = Math.ceil(f.size / PART_SIZE);
    const partsArr: { partNumber: number; etag: string }[] = [];
    try {
      for (let pn = 1; pn <= totalParts; pn++) {
        setUploading(prev => ({ ...prev, [platformId]: `Part ${pn}/${totalParts}…` }));
        const fd = new FormData();
        fd.append('file', f.slice((pn - 1) * PART_SIZE, pn * PART_SIZE));
        fd.append('uploadId', uploadId);
        fd.append('key', key);
        fd.append('partNumber', String(pn));
        const pr = await fetch(`${API_URL}/admin/releases/${id}/upload/part`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd });
        const pj = await pr.json();
        if (!pr.ok) throw new Error(pj.error?.message || pj.error || `Part ${pn} failed`);
        partsArr.push({ partNumber: pj.data.partNumber, etag: pj.data.etag });
      }
    } catch (e) {
      try { await fetch(`${API_URL}/admin/releases/${id}/upload/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ uploadId, key }) }); } catch {}
      throw e;
    }
    const cr = await fetch(`${API_URL}/admin/releases/${id}/upload/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ uploadId, key, platform: platformId, filename: f.name, size: f.size, mimeType: f.type || 'application/octet-stream', sha256: sha, parts: partsArr }),
    });
    const cj = await cr.json();
    if (!cr.ok) throw new Error(cj.error?.message || cj.error || 'Complete failed');
    return cj.data?.package;
  };

  const uploadAll = async (withReleaseId?: string): Promise<string | null> => {
    if (!API_URL) { toast('Set VITE_API_URL to publish live', { icon: '⚠️' }); return null; }
    if (!token) { toast.error('Login as admin'); return null; }
    const id = withReleaseId || releaseId;
    if (!id || id === '__new__') { toast.error('Create or pick a release first'); return null; }
    const picked = platforms.filter(p => files[p.id]);
    if (!picked.length) { toast.error('Select at least one platform file'); return null; }
    let ok = 0;
    for (const p of picked) {
      const f = files[p.id]!;
      setUploading(prev => ({ ...prev, [p.id]: f.size > CHUNK_THRESHOLD ? 'Hashing…' : 'Uploading…' }));
      try {
        const pkg = await uploadOne(id, p.id, f);
        setUploading(prev => ({ ...prev, [p.id]: `Stored ✓ ${(pkg.size/1024/1024).toFixed(1)} MB • sha ${String(pkg.sha256).slice(0,8)}…` }));
        setFiles(prev => { const n = { ...prev }; delete n[p.id]; return n; });
        ok++;
      } catch (e: any) {
        setUploading(prev => ({ ...prev, [p.id]: `Failed: ${e.message}` }));
        toast.error(`${p.label}: ${e.message}`);
      }
    }
    if (ok) { fetchReleases(); }
    return id;
  };

  const publishEverything = async () => {
    setPublishing(true);
    try {
      let id = releaseId;
      if (creatingNew) {
        id = (await createDraft()) as any;
        if (!id) return;
      }
      if (Object.values(files).some(Boolean)) {
        await uploadAll(id);
      }
      const res = await fetch(`${API_URL}/admin/releases/${id}/publish`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message || j.error || 'Publish failed');
      setPublishedVersion(j.data?.version || '');
      toast.success(`v${j.data?.version} is LIVE for ${appId} — users can install now`);
      window.dispatchEvent(new CustomEvent('rx-refresh'));
      fetchReleases();
      setVersion(''); setNotes('');
    } catch (e: any) { toast.error(e.message); }
    finally { setPublishing(false); }
  };

  return (
    <div className="space-y-6">
      <div><h2 className="text-xl font-bold text-white flex items-center gap-2"><Package className="w-5 h-5 text-rx-yellow"/> App Release Manager</h2><p className="text-sm text-rx-gray-medium mt-1">Upload binaries to Cloudflare R2 → tied to a release + version → Publish → users can Install. Every package gets a sha256 checksum.</p></div>

      {!API_URL && <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-200 text-sm flex gap-2"><AlertCircle className="w-4 h-4 flex-shrink-0"/> Offline — set VITE_API_URL to publish live.</div>}

      <div className="card p-6 space-y-5">
        {/* 1. App */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-rx-gray-medium">Application</label>
            <select value={appId} onChange={e=>setAppId(e.target.value)} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm">
              {apps.map(a => <option key={a.slug} value={a.slug}>{a.name} ({a.slug}) — v{a.version}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-rx-gray-medium">Release</label>
            <div className="flex gap-2 mt-1">
              <select value={releaseId || '__new__'} onChange={e=>setReleaseId(e.target.value === '__new__' ? '' : e.target.value)} className="flex-1 bg-rx-dark border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm">
                <option value="__new__">＋ New version…</option>
                {releases.filter(r => r.status !== 'published').map(r => <option key={r.id} value={r.id}>{r.version} — {r.status}{r.package_count ? ` (${r.package_count} pkg: ${r.package_platforms})` : ' (no packages yet)'}</option>)}
                {releases.filter(r => r.status === 'published').slice(0,3).map(r => <option key={r.id} value={r.id}>{r.version} — published ✓ (replace binary)</option>)}
              </select>
              <button onClick={fetchReleases} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-rx-gray-medium" title="Refresh releases"><RefreshCw className="w-4 h-4"/></button>
            </div>
          </div>
        </div>

        {/* 2. New version details (only when creating) */}
        {creatingNew && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-rx-gray-medium">Version * <span className="text-rx-yellow">(saved to the release + set as app version on publish)</span></label>
              <input value={version} onChange={e=>setVersion(e.target.value)} placeholder="3.3.0" className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm placeholder:text-rx-gray-medium/60 focus:outline-none focus:border-rx-yellow/40"/>
            </div>
            <div>
              <label className="text-xs text-rx-gray-medium">Release Notes (one per line)</label>
              <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder={"- Windows EXE signed\n- Android APK fixes"} rows={2} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-white text-sm placeholder:text-rx-gray-medium/60 focus:outline-none focus:border-rx-yellow/40"/>
            </div>
          </div>
        )}
        {release && (
          <p className="text-xs text-rx-gray-medium -mt-2">Release <b className="text-white">{release.version}</b> — status <b className="text-rx-yellow">{release.status}</b>{release.package_count ? ` • ${release.package_count} package(s): ${release.package_platforms}` : ' • no packages yet'}. Upload below {release.status === 'published' ? 'replaces the live binary for that platform instantly.' : 'then hit Publish.'}</p>
        )}

        {/* 3. Platform pickers */}
        <div>
          <div className="mb-3 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 flex gap-3">
            <Globe className="w-5 h-5 text-blue-300 flex-shrink-0" />
            <div><p className="text-sm font-medium text-white">Web / PWA uses a live website link — no ZIP upload needed</p><p className="text-xs text-rx-gray-medium mt-0.5">Set <b className="text-white">Applications → Edit → Website URL</b> to the deployed HTTPS site (for example Cloudflare Pages). RX Store opens that URL directly; a dist ZIP stored in R2 is not a deployed website.</p>{app?.website && <a href={app.website} target="_blank" rel="noreferrer" className="text-xs text-blue-300 hover:underline mt-1 inline-block">Test {app.website} ↗</a>}</div>
          </div>
          <label className="text-xs text-rx-gray-medium mb-2 block">Platform Binaries — each upload stores to R2 <code className="px-1 py-0.5 bg-white/10 rounded">apps/{appId || 'slug'}/{release?.version || version || 'x.y.z'}/{'{platform}'}/</code>, computes sha256, and writes a packages row for the release</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {platforms.map(p => {
              const Icon = p.icon;
              const f = files[p.id];
              const status = uploading[p.id];
              return (
                <div key={p.id} className={`flex items-center gap-3 p-3 rounded-xl border-2 ${status?.startsWith('Failed') ? 'border-red-500/40 bg-red-500/5' : f ? 'border-green-500/30 bg-green-500/5' : status?.startsWith('Stored') ? 'border-green-500/30 bg-green-500/5' : 'border-dashed border-white/10 hover:border-rx-yellow/30 bg-rx-dark/50'}`}>
                  <div className="w-10 h-10 rounded-lg bg-rx-dark-tertiary flex items-center justify-center"><Icon className="w-5 h-5 text-rx-gray-medium"/></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white flex items-center gap-2">{p.label} <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-rx-gray-medium">{p.ext}</span> {status && <span className={`text-[10px] px-1.5 py-0.5 rounded ${status.startsWith('Failed') ? 'bg-red-500/20 text-red-300' : 'bg-rx-yellow/20 text-rx-yellow'}`}>{status}</span>}</p>
                    <p className="text-xs text-rx-gray-medium truncate">{f ? `${f.name} (${(f.size/1024/1024).toFixed(1)} MB)` : `Select ${p.ext}`}</p>
                    {status && !status.startsWith('Stored') && !status.startsWith('Failed') && <div className="mt-1 h-1 bg-white/10 rounded-full overflow-hidden"><div className="h-full bg-rx-yellow animate-pulse" style={{width:'70%'}}/></div>}
                  </div>
                  {f ? (
                    <>
                      <span className="text-xs px-2 py-1 rounded-full bg-green-500/20 text-green-400 flex items-center gap-1"><Check className="w-3 h-3"/> Ready</span>
                      <button onClick={()=>setFiles(prev=>{ const n={...prev}; delete n[p.id]; return n; })} className="p-1 rounded hover:bg-white/10 text-rx-gray-medium"><span className="text-xs">✕</span></button>
                    </>
                  ) : (
                    <label className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs cursor-pointer flex items-center gap-1"><Upload className="w-3 h-3"/> Select<input type="file" className="hidden" accept={p.accept} onChange={e=>setFiles(prev=>({ ...prev, [p.id]: e.target.files?.[0] || null }))} /></label>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-rx-gray-medium mt-2">Files ≤50 MB upload in one shot; bigger installers (up to 500 MB) go in 8 MB chunks with the checksum computed in your browser — just select and go. iOS/macOS need the one-time packages migration; the API prints the exact wrangler command if it's not done yet.</p>
        </div>

        {/* 4. Actions */}
        <div className="flex flex-col sm:flex-row gap-2">
          {!creatingNew && release?.status !== 'published' && (
            <button onClick={()=>uploadAll()} disabled={publishing || !Object.values(files).some(Boolean)} className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white text-sm flex items-center justify-center gap-2 disabled:opacity-50">
              <Upload className="w-4 h-4"/> Upload selected ({Object.values(files).filter(Boolean).length}) to draft
            </button>
          )}
          <button onClick={publishEverything} disabled={publishing || creating || (creatingNew ? !version.trim() : false) || (!creatingNew && !Object.values(files).some(Boolean) && !release?.package_count && !anyUploaded)} className="flex-1 btn-primary py-2.5 flex items-center justify-center gap-2 disabled:opacity-50">
            {(publishing || creating) ? <><Loader2 className="w-4 h-4 animate-spin"/> Working…</> : <><Play className="w-4 h-4"/> {creatingNew ? 'Create release → upload → publish' : release?.status === 'published' ? 'Upload & go live' : 'Upload & publish release'}</>}
          </button>
        </div>

        {publishedVersion && (
          <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20 text-green-300 text-sm flex items-center gap-2">
            <Check className="w-4 h-4"/> v{publishedVersion} is live. {app?.slug && <>Test install: <code className="px-1 py-0.5 bg-white/10 rounded text-xs">GET /apps/{app.slug}/download?platform={'{windows|linux_deb|android|web}'}</code> — or click Install on the store.</>}
          </div>
        )}
      </div>

      <div className="card p-4">
        <h3 className="font-semibold text-white text-sm">The pipeline (all connected now):</h3>
        <p className="text-xs text-rx-gray-medium mt-1">Upload → R2 + sha256 + <code className="px-1 bg-white/10 rounded">packages</code> row for the release → Publish flips release + packages to <b className="text-white">published</b>, sets the app version, merges platforms into the Install modal, and syncs the legacy updater. Install → <code className="px-1 bg-white/10 rounded">GET /apps/:slug/download?platform=X</code> → serves the published package from R2 and counts the download.</p>
      </div>
    </div>
  );
}
