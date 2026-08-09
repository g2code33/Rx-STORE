import { useState } from 'react';
import { Loader2, RotateCcw, UploadCloud, Check, Shapes } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL } from '../../services/api';
import { useContent } from '../../context/ContentContext';
import { ICON_SLOTS, iconContentKey, isImageIcon, resolveIcon, IconSlot } from '../../icons/platformIcons';

/** Curated emoji quick-picks — covers every platform plus good stand-ins. */
const EMOJI_PICKS = ['🌐', '🪟', '🐧', '🤖', '🍎', '💻', '🖥️', '📱', '⌚', '🍏', '🦊', '🔷', '🟦', '💊', '🩺', '⚕️', '🏥', '🧰', '📦', '🚀', '⚡', '🔥', '⭐', '🛡️', '💼', '🎯', '🧠', '📊'];

function SlotPreview({ value, big = false }: { value: string; big?: boolean }) {
  const size = big ? 'w-14 h-14' : 'w-10 h-10';
  if (isImageIcon(value)) {
    return <img src={value} alt="" draggable={false} className={`${size} rounded-xl object-contain bg-rx-dark border border-white/10 p-1`} onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = '0.2'; }} />;
  }
  return <span className={`${size} rounded-xl bg-rx-dark border border-white/10 flex items-center justify-center ${big ? 'text-3xl' : 'text-xl'}`}>{value || '📦'}</span>;
}

function IconSlotCard({ slot }: { slot: IconSlot }) {
  const { get, save } = useContent();
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(0);
  const key = iconContentKey(slot.id);
  const raw = get(key, '');
  const current = resolveIcon(raw, slot.id);
  const isCustom = raw.trim() !== '' && raw.trim() !== slot.fallback;

  const publish = async (value: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await save(key, value);
      if (ok) { toast.success(`${slot.label} icon updated ✓ live now`); setSaved(Date.now()); }
      else toast.error('Could not publish — check the admin connection');
    } finally { setBusy(false); }
  };

  const upload = async (file: File) => {
    if (!file.type.startsWith('image/')) { toast.error('PNG/JPG/SVG image only'); return; }
    if (file.size > 512 * 1024) { toast.error('Keep icons under 512 KB'); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', 'site');
      fd.append('slug', 'icons');
      const res = await fetch(`${API_URL}/admin/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('rx-store-token') || ''}` },
        body: fd,
      });
      const j = await res.json();
      const url = j?.data?.url;
      if (!res.ok || !url) throw new Error(j?.error?.message || 'Upload failed');
      await publish(url);
    } catch (e: any) { toast.error(e?.message || 'Upload failed'); }
    finally { setUploading(false); }
  };

  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <SlotPreview value={current} big />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-white flex items-center gap-1.5">
            {slot.label}
            {saved > 0 && Date.now() - saved < 3000 && <Check className="w-3.5 h-3.5 text-green-400" />}
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-rx-gray-medium" />}
          </p>
          <p className="text-[11px] text-rx-gray-medium">{slot.usedIn}</p>
          {isCustom && (
            <button onClick={() => publish(slot.fallback)} disabled={busy}
              className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-rx-gray-medium hover:text-rx-yellow transition-colors">
              <RotateCcw className="w-3 h-3" /> Reset to default
            </button>
          )}
        </div>
        <label className={`flex-shrink-0 px-3 py-2 rounded-xl text-xs font-bold cursor-pointer transition-all ${uploading ? 'bg-rx-dark-tertiary text-rx-gray-medium' : 'bg-rx-yellow text-rx-dark hover:bg-rx-yellow-light'}`}>
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : <span className="flex items-center gap-1"><UploadCloud className="w-3.5 h-3.5" /> PNG</span>}
          <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" disabled={uploading}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
        </label>
      </div>

      {!slot.imageOnly && (
        <>
          <div className="flex flex-wrap gap-1">
            {EMOJI_PICKS.map((em) => (
              <button
                key={em}
                onClick={() => publish(em)}
                disabled={busy}
                className={`w-8 h-8 rounded-lg text-base flex items-center justify-center transition-all hover:bg-white/10 ${current === em ? 'bg-rx-yellow/20 ring-1 ring-rx-yellow' : 'bg-rx-dark/60'}`}
              >{em}</button>
            ))}
          </div>
          <EmojiInput onSubmit={publish} disabled={busy} />
        </>
      )}
      {slot.imageOnly && (
        <UrlInput placeholder="…or paste an image URL (https://… or /file.png)" onSubmit={publish} disabled={busy} />
      )}
    </div>
  );
}

function EmojiInput({ onSubmit, disabled }: { onSubmit: (v: string) => void; disabled: boolean }) {
  const [v, setV] = useState('');
  return (
    <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onSubmit(v.trim().slice(0, 4)); setV(''); } }}>
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="Any emoji…"
        className="flex-1 bg-rx-dark border border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder:text-rx-gray-medium/60 focus:outline-none focus:border-rx-yellow/40"
        maxLength={4}
      />
      <button disabled={disabled || !v.trim()} className="px-3 rounded-lg bg-white/5 text-xs font-bold text-white hover:bg-white/10 disabled:opacity-40">Set</button>
    </form>
  );
}

function UrlInput({ placeholder, onSubmit, disabled }: { placeholder: string; onSubmit: (v: string) => void; disabled: boolean }) {
  const [v, setV] = useState('');
  return (
    <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onSubmit(v.trim()); setV(''); } }}>
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-rx-dark border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder:text-rx-gray-medium/60 focus:outline-none focus:border-rx-yellow/40"
      />
      <button disabled={disabled || !v.trim()} className="px-3 rounded-lg bg-white/5 text-xs font-bold text-white hover:bg-white/10 disabled:opacity-40">Set</button>
    </form>
  );
}

/**
 * Admin → Icons — every icon in the app in one grid. Pick an emoji or upload
 * a PNG; publishes instantly (site content) and every visitor sees it.
 */
export default function IconManager() {
  const platforms = ICON_SLOTS.filter((s) => s.kind === 'platform');
  const brand = ICON_SLOTS.filter((s) => s.kind === 'brand');
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2"><Shapes className="w-5 h-5 text-rx-yellow" /> Site Icons</h2>
        <p className="text-sm text-rx-gray-medium mt-1">
          Every icon used across the store — Android, Apple, Windows, Linux, Web, macOS, and the brand marks.
          Pick another emoji or upload a picture (PNG). Changes publish instantly for every visitor.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-bold text-white mb-3 uppercase tracking-wider text-rx-gray-medium">Platform icons</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {platforms.map((s) => <IconSlotCard key={s.id} slot={s} />)}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-bold text-white mb-3 uppercase tracking-wider text-rx-gray-medium">Brand icons</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {brand.map((s) => <IconSlotCard key={s.id} slot={s} />)}
        </div>
      </div>

      <p className="text-xs text-rx-gray-medium">
        Also: category icons are edited in the Live Builder (Categories), and each app's own icon lives in its App Editor.
        Uploaded files go to site storage at <code className="px-1 py-0.5 bg-white/10 rounded">Admin → Uploads</code>.
      </p>
    </div>
  );
}
