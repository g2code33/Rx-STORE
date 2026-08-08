import { useState } from 'react';
import { X, Save, Trash2, Plus, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL } from '../../services/api';
import { App } from '../../types';

export default function AppEditor({ app, onClose, onSaved }: { app: Partial<App> & { slug: string }; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>({
    name: app.name || '',
    slug: app.slug || '',
    description: app.description || '',
    longDescription: (app as any).longDescription || app.description || '',
    category: app.category || 'healthcare',
    tags: (app.tags || []).join(', '),
    icon: app.icon || '📦',
    color: app.color || '#FFD600',
    gradient: app.gradient || 'from-rx-dark to-rx-dark-secondary',
    developer: app.developer || 'Calcitonin Technologies',
    version: app.version || '1.0.0',
    size: app.size || '',
    rating: app.rating || 4.5,
    price: app.price || 'free',
    priceAmount: app.priceAmount || '',
    platforms: (app.platforms || ['web']).join(', '),
    screenshots: (app.screenshots || []).join(', '),
    features: (app.features || []).join('\n'),
    releaseNotes: (app.releaseNotes || []).join('\n'),
    status: app.status || 'active',
    isFeatured: !!(app as any).isFeatured,
  });
  const [saving, setSaving] = useState(false);

  const token = localStorage.getItem('rx-store-token') || '';

  const save = async () => {
    if (!API_URL) { toast.error('Set VITE_API_URL to save live'); return; }
    if (!token) { toast.error('Login as admin'); return; }
    setSaving(true);
    try {
      const payload: any = {
        name: form.name,
        description: form.description,
        long_description: form.longDescription,
        category: form.category,
        tags: form.tags.split(',').map((s:string)=>s.trim()).filter(Boolean),
        icon: form.icon,
        color: form.color,
        gradient: form.gradient,
        developer: form.developer,
        current_version: form.version,
        size_mb: form.size ? parseInt(String(form.size).replace(/[^0-9]/g,'')) || null : null,
        rating: parseFloat(form.rating) || 0,
        price_type: form.price,
        price_amount: form.priceAmount ? parseFloat(form.priceAmount) : null,
        platforms: form.platforms.split(',').map((s:string)=>s.trim()).filter(Boolean),
        screenshots: form.screenshots.split(',').map((s:string)=>s.trim()).filter(Boolean),
        features: form.features.split('\n').map((s:string)=>s.trim()).filter(Boolean),
        release_notes: form.releaseNotes.split('\n').map((s:string)=>s.trim()).filter(Boolean),
        status: form.status,
        is_featured: form.isFeatured ? 1 : 0,
      };
      // If slug changed or new app, use POST, else PUT
      const isNew = !(app as any).id || (app as any).isNewPlaceholder;
      let res: Response;
      if (isNew) {
        res = await fetch(`${API_URL}/admin/apps`, { method: 'POST', headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` }, body: JSON.stringify({ ...payload, slug: form.slug }) });
      } else {
        res = await fetch(`${API_URL}/admin/apps/${app.slug}`, { method: 'PUT', headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` }, body: JSON.stringify(payload) });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed to save');
      toast.success(isNew ? 'App created' : 'App updated');
      onSaved();
      onClose();
    } catch (e:any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const del = async () => {
    if (!confirm(`Delete ${app.name || app.slug}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${API_URL}/admin/apps/${app.slug}`, { method: 'DELETE', headers: { 'Authorization':`Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed');
      toast.success('Deleted');
      onSaved(); onClose();
    } catch (e:any) { toast.error(e.message); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-rx-dark-secondary border border-white/10 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-rx-dark-secondary border-b border-white/10 p-4 flex items-center justify-between">
          <h3 className="font-bold text-white">{(app as any).id ? 'Edit Application' : 'New Application'}</h3>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 text-rx-gray-medium"><X className="w-5 h-5"/></button>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="text-xs text-rx-gray-medium">Name *</label><input value={form.name} onChange={e=>setForm({...form, name:e.target.value})} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
            <div><label className="text-xs text-rx-gray-medium">Slug *</label><input value={form.slug} onChange={e=>setForm({...form, slug:e.target.value})} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
            <div><label className="text-xs text-rx-gray-medium">Category</label>
              <select value={form.category} onChange={e=>setForm({...form, category:e.target.value})} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white">
                <option value="healthcare">Healthcare</option><option value="education">Education</option><option value="productivity">Productivity</option><option value="technology">Technology</option><option value="gaming">Gaming</option><option value="social">Social</option>
              </select>
            </div>
            <div><label className="text-xs text-rx-gray-medium">Status</label>
              <select value={form.status} onChange={e=>setForm({...form, status:e.target.value})} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white">
                <option value="active">Active</option><option value="beta">Beta</option><option value="coming-soon">Coming Soon</option><option value="archived">Archived</option>
              </select>
            </div>
            <div><label className="text-xs text-rx-gray-medium">Price</label>
              <select value={form.price} onChange={e=>setForm({...form, price:e.target.value})} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white">
                <option value="free">Free</option><option value="paid">Paid</option><option value="subscription">Subscription</option>
              </select>
            </div>
            <div><label className="text-xs text-rx-gray-medium">Price Amount</label><input value={form.priceAmount} onChange={e=>setForm({...form, priceAmount:e.target.value})} placeholder="29.99" className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
            <div><label className="text-xs text-rx-gray-medium">Version</label><input value={form.version} onChange={e=>setForm({...form, version:e.target.value})} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
            <div><label className="text-xs text-rx-gray-medium">Size (e.g. 148 MB)</label><input value={form.size} onChange={e=>setForm({...form, size:e.target.value})} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
            <div><label className="text-xs text-rx-gray-medium">Logo (image file or URL / emoji)</label>
              <div className="flex gap-2">
                <input value={form.icon} onChange={e=>setForm({...form, icon:e.target.value})} placeholder="https://.../logo.png or 📦" className="flex-1 bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/>
                <label className="px-3 py-2 rounded-xl bg-white/10 text-white text-sm cursor-pointer hover:bg-white/20 flex items-center gap-1">
                  Upload
                  <input type="file" accept="image/*" className="hidden" onChange={async (e)=>{
                    const f=(e.target as HTMLInputElement).files?.[0]; if(!f) return;
                    const fd=new FormData(); fd.append('file', f); fd.append('kind','icons'); fd.append('slug', form.slug||'app');
                    try {
                      const token=localStorage.getItem('rx-store-token')||'';
                      const r=await fetch(`${(import.meta as any).env.VITE_API_URL}/admin/upload`,{method:'POST',headers:{'Authorization':`Bearer ${token}`},body:fd});
                      const j=await r.json(); if(!r.ok) throw new Error(j.error?.message||'Upload failed');
                      setForm((prev:any)=>({...prev, icon:j.data?.url || j.data?.key}));
                      // @ts-ignore
                      import('react-hot-toast').then(m=>m.default.success('Logo uploaded'));
                    } catch(err:any){ (await import('react-hot-toast')).default.error(err.message); }
                  }}/>
                </label>
              </div>
              {form.icon?.startsWith('http') && <img src={form.icon} alt="logo" className="mt-2 w-16 h-16 rounded-xl object-cover border border-white/10"/>}
            </div>
            <div><label className="text-xs text-rx-gray-medium">Rating</label><input type="number" step="0.1" value={form.rating} onChange={e=>setForm({...form, rating:e.target.value})} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
          </div>
          <div><label className="text-xs text-rx-gray-medium">Short Description</label><textarea value={form.description} onChange={e=>setForm({...form, description:e.target.value})} rows={2} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
          <div><label className="text-xs text-rx-gray-medium">Long Description</label><textarea value={form.longDescription} onChange={e=>setForm({...form, longDescription:e.target.value})} rows={4} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
          <div><label className="text-xs text-rx-gray-medium">Developer</label><input value={form.developer} onChange={e=>setForm({...form, developer:e.target.value})} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
          <div>
            <label className="text-xs text-rx-gray-medium">Platforms *</label>
            <div className="mt-1 p-3 rounded-xl bg-rx-dark border border-white/10">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-rx-gray-medium">Select platforms</span>
                <button type="button" onClick={()=>{
                  const all = ['web','windows','linux','android','ios'];
                  const cur = form.platforms.split(',').map((s:string)=>s.trim()).filter(Boolean);
                  if (cur.length === all.length) setForm({...form, platforms: ''});
                  else setForm({...form, platforms: all.join(', ')});
                }} className="text-xs px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white">
                  {(form.platforms.split(',').map((s:string)=>s.trim()).filter(Boolean).length === 5) ? 'Deselect All' : 'Select All'}
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {[
                  { id: 'web', label: 'Web', icon: '🌐' },
                  { id: 'windows', label: 'Windows', icon: '🪟' },
                  { id: 'linux', label: 'Linux', icon: '🐧' },
                  { id: 'android', label: 'Android', icon: '🤖' },
                  { id: 'ios', label: 'iOS', icon: '🍎' },
                ].map(opt => {
                  const selected = form.platforms.split(',').map((s:string)=>s.trim()).includes(opt.id);
                  return (
                    <label key={opt.id} className={`flex items-center gap-2 p-2.5 rounded-xl border cursor-pointer transition-all ${selected ? 'bg-rx-yellow/10 border-rx-yellow/30 text-white' : 'bg-rx-dark-tertiary border-white/10 text-rx-gray-medium hover:border-white/20'}`}>
                      <input type="checkbox" checked={selected} onChange={e=>{
                        const cur = form.platforms.split(',').map((s:string)=>s.trim()).filter(Boolean);
                        if (e.target.checked) {
                          if (!cur.includes(opt.id)) cur.push(opt.id);
                        } else {
                          const idx = cur.indexOf(opt.id);
                          if (idx>=0) cur.splice(idx,1);
                        }
                        setForm({...form, platforms: cur.join(', ')});
                      }} className="rounded" />
                      <span className="text-sm">{opt.icon} {opt.label}</span>
                    </label>
                  );
                })}
              </div>
              <p className="text-[11px] text-rx-gray-medium mt-2">Selected: <span className="text-white">{form.platforms || 'none'}</span> — choose one, some, or all.</p>
            </div>
          </div>
          <div>
            <label className="text-xs text-rx-gray-medium">Tags</label>
            <div className="mt-1 p-3 rounded-xl bg-rx-dark border border-white/10">
              <div className="flex flex-wrap gap-2">
                {['clinical','education','healthcare','productivity','technology','gaming','social','AI','mobile','desktop'].map(tag => {
                  const selected = form.tags.split(',').map((s:string)=>s.trim()).includes(tag);
                  return (
                    <button key={tag} type="button" onClick={()=>{
                      const cur = form.tags.split(',').map((s:string)=>s.trim()).filter(Boolean);
                      if (selected) {
                        setForm({...form, tags: cur.filter((c:string)=>c!==tag).join(', ')});
                      } else {
                        cur.push(tag);
                        setForm({...form, tags: cur.join(', ')});
                      }
                    }} className={`px-2.5 py-1 rounded-full text-xs border transition-all ${selected ? 'bg-rx-yellow text-rx-dark border-rx-yellow' : 'bg-white/5 text-rx-gray-medium border-white/10 hover:border-white/20'}`}>#{tag}</button>
                  );
                })}
              </div>
              <input value={form.tags} onChange={e=>setForm({...form, tags:e.target.value})} placeholder="Or type custom tags, comma separated" className="mt-2 w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder:text-rx-gray-medium/60" />
              <p className="text-[11px] text-rx-gray-medium mt-1">Tap to select, or type custom.</p>
            </div>
          </div>
          <div><label className="text-xs text-rx-gray-medium">Screenshots (URLs, comma separated)</label><textarea value={form.screenshots} onChange={e=>setForm({...form, screenshots:e.target.value})} placeholder="https://.../1.png, https://.../2.png" rows={2} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
          <div><label className="text-xs text-rx-gray-medium">Features (one per line)</label><textarea value={form.features} onChange={e=>setForm({...form, features:e.target.value})} rows={3} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
          <div><label className="text-xs text-rx-gray-medium">Release Notes (one per line)</label><textarea value={form.releaseNotes} onChange={e=>setForm({...form, releaseNotes:e.target.value})} rows={3} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="text-xs text-rx-gray-medium">Gradient</label><input value={form.gradient} onChange={e=>setForm({...form, gradient:e.target.value})} className="mt-1 w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"/></div>
            <div className="flex items-end gap-2"><label className="flex items-center gap-2 text-sm text-white"><input type="checkbox" checked={form.isFeatured} onChange={e=>setForm({...form, isFeatured:e.target.checked})} className="rounded"/> Featured</label></div>
          </div>
        </div>
        <div className="sticky bottom-0 bg-rx-dark-secondary border-t border-white/10 p-4 flex gap-2 justify-between">
          <button onClick={del} className="px-4 py-2 rounded-xl bg-red-500/10 text-red-400 border border-red-500/20 text-sm flex items-center gap-1"><Trash2 className="w-4 h-4"/> Delete</button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-xl bg-white/5 text-white border border-white/10 text-sm">Cancel</button>
            <button onClick={save} disabled={saving} className="btn-primary text-sm flex items-center gap-1 disabled:opacity-50">{saving ? <><Loader2 className="w-4 h-4 animate-spin"/> Saving…</> : <><Save className="w-4 h-4"/> Save</>}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
