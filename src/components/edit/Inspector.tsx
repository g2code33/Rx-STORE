import React, { useEffect, useMemo, useState } from 'react';
import { X, Save, Loader2, Check, Trash2, ArrowUp, ArrowDown, Plus, UploadCloud, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useContent } from '../../context/ContentContext';
import { useEditMode } from './EditMode';
import { API_URL } from '../../services/api';

/**
 * The focused edit drawer. Every editable element on the site opens here with
 * the right editor for its content type. Each item has its own Save that
 * publishes immediately (failures queue for Publish All).
 */

const inputCls = 'w-full bg-rx-dark border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-rx-yellow/50';
const labelCls = 'block text-[11px] uppercase tracking-wider text-rx-gray-medium mb-1';

function Row({ children }: { children: React.ReactNode }) { return <div className="mb-3">{children}</div>; }

export default function Inspector() {
  const edit = useEditMode();
  const { get, getJSON, save, saving, savedAt, pending } = useContent();
  const [draft, setDraft] = useState<any>('');
  const [uploading, setUploading] = useState(false);

  const d = edit?.inspector;

  // Load the current value whenever a different element is opened
  useEffect(() => {
    if (!d) return;
    if (d.type === 'text' || d.type === 'textarea' || d.type === 'color') setDraft(get(d.id, ''));
    else if (d.type === 'link') setDraft(getJSON(d.id, { label: '', to: '' }));
    else if (d.type === 'image') setDraft(getJSON(d.id, { url: '', alt: '', pos: 'center' }));
    else setDraft(getJSON(d.id, []));
  }, [d?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isPending = d ? pending.some((p) => p.key === d.id) : false;
  const justSaved = d ? savedAt[d.id] : 0;

  const doSave = async () => {
    if (!d) return;
    const ok = await save(d.id, draft);
    if (ok) { toast.success('Published — live on the website ✓'); edit.closeInspector(); }
  };

  const uploadImage = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', 'site');
      fd.append('slug', 'builder');
      const res = await fetch(`${API_URL}/admin/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('rx-store-token') || ''}` },
        body: fd,
      });
      const j = await res.json();
      const url = j?.data?.url;
      if (!res.ok || !url) throw new Error(j?.error?.message || 'Upload failed');
      setDraft((v: any) => ({ ...(v || {}), url }));
      toast.success('Image uploaded to R2');
    } catch (e: any) {
      toast.error(e.message);
    } finally { setUploading(false); }
  };

  const list: any[] = useMemo(() => (Array.isArray(draft) ? draft : []), [draft]);
  const setList = (next: any[]) => setDraft(next);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    setList(next);
  };
  const removeAt = (i: number) => setList(list.filter((_, x) => x !== i));
  const setField = (i: number, k: string, v: any) => setList(list.map((it, x) => (x === i ? { ...it, [k]: v } : it)));

  return (
    <div className={`fixed inset-0 z-[70] ${d ? '' : 'pointer-events-none'}`}>
      {/* backdrop */}
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity ${d ? 'opacity-100' : 'opacity-0'}`}
        onClick={() => edit?.closeInspector()}
      />
      <aside className={`absolute right-0 top-0 h-full w-full max-w-md bg-rx-dark-secondary border-l border-white/10 shadow-2xl transition-transform duration-200 overflow-y-auto ${d ? 'translate-x-0' : 'translate-x-full'}`}>
        {d && (
          <div className="p-5">
            <div className="flex items-start justify-between mb-1">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-rx-yellow">{d.type} · {d.id}</p>
                <h3 className="text-lg font-bold text-white">Edit — {d.label}</h3>
              </div>
              <button onClick={() => edit.closeInspector()} className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-rx-gray-medium hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* status line */}
            <p className="text-xs mb-4">
              {saving === d.id ? (
                <span className="text-rx-yellow flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Publishing…</span>
              ) : isPending ? (
                <span className="text-amber-300">● Not yet published — queued for Publish All</span>
              ) : justSaved ? (
                <span className="text-green-400 flex items-center gap-1"><Check className="w-3 h-3" /> Published {new Date(justSaved).toLocaleTimeString()}</span>
              ) : (
                <span className="text-rx-gray-medium">Saves publish to the live site immediately.</span>
              )}
            </p>

            {/* ---- text / textarea ---- */}
            {d.type === 'text' && (
              <Row><label className={labelCls}>Text</label><input className={inputCls} value={draft || ''} onChange={(e) => setDraft(e.target.value)} /></Row>
            )}
            {d.type === 'textarea' && (
              <Row><label className={labelCls}>Text</label><textarea className={`${inputCls} min-h-[120px] resize-y`} value={draft || ''} onChange={(e) => setDraft(e.target.value)} /></Row>
            )}

            {/* ---- link ---- */}
            {d.type === 'link' && (
              <>
                <Row><label className={labelCls}>Button / link label</label><input className={inputCls} value={draft?.label || ''} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></Row>
                <Row><label className={labelCls}>Destination (path or URL)</label><input className={inputCls} placeholder="/browse or https://…" value={draft?.to || ''} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Row>
              </>
            )}

            {/* ---- color ---- */}
            {d.type === 'color' && (
              <Row>
                <label className={labelCls}>Color</label>
                <div className="flex items-center gap-2">
                  <input type="color" value={/^#[0-9a-f]{6}$/i.test(draft || '') ? draft : '#FFD600'} onChange={(e) => setDraft(e.target.value)} className="w-12 h-10 rounded-lg bg-transparent border border-white/10 cursor-pointer" />
                  <input className={inputCls} value={draft || ''} onChange={(e) => setDraft(e.target.value)} placeholder="#FFD600" />
                </div>
                <p className="text-[11px] text-rx-gray-medium mt-1.5">Applies site-wide as soon as it's published.</p>
              </Row>
            )}

            {/* ---- image: URL + drag-drop upload ---- */}
            {d.type === 'image' && (
              <>
                <Row>
                  <label className={labelCls}>Image</label>
                  <div
                    className="border-2 border-dashed border-white/15 rounded-xl p-4 text-center hover:border-rx-yellow/40 transition-colors"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) uploadImage(f); }}
                  >
                    {draft?.url ? (
                      <img src={draft.url} alt={draft.alt || ''} className="max-h-36 mx-auto rounded-lg object-contain mb-3" />
                    ) : (
                      <UploadCloud className="w-8 h-8 text-rx-gray-medium mx-auto mb-2" />
                    )}
                    <label className="inline-block px-3 py-1.5 rounded-lg bg-rx-yellow text-rx-dark text-xs font-bold cursor-pointer hover:bg-rx-yellow-light">
                      {uploading ? 'Uploading…' : draft?.url ? 'Replace image' : 'Upload image'}
                      <input type="file" accept="image/*" className="hidden" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f); e.target.value = ''; }} />
                    </label>
                    <p className="text-[11px] text-rx-gray-medium mt-2">Drag & drop works too — uploads straight to R2.</p>
                  </div>
                </Row>
                <Row><label className={labelCls}>…or paste an image URL</label><input className={inputCls} value={draft?.url || ''} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://…" /></Row>
                <Row><label className={labelCls}>Alt text</label><input className={inputCls} value={draft?.alt || ''} onChange={(e) => setDraft({ ...draft, alt: e.target.value })} /></Row>
                <Row>
                  <label className={labelCls}>Crop position</label>
                  <select className={inputCls} value={draft?.pos || 'center'} onChange={(e) => setDraft({ ...draft, pos: e.target.value })}>
                    {['center', 'top', 'bottom', 'left', 'right'].map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </Row>
              </>
            )}

            {/* ---- plain list of strings ---- */}
            {d.type === 'textList' && (
              <ListShell onAdd={() => setList([...list, ''])}>
                {list.map((item, i) => (
                  <div key={i} className="flex items-center gap-1.5 mb-2">
                    <input className={inputCls} value={item} onChange={(e) => setList(list.map((x, xi) => (xi === i ? e.target.value : x)))} />
                    <ListBtns i={i} len={list.length} move={move} removeAt={removeAt} />
                  </div>
                ))}
              </ListShell>
            )}

            {/* ---- link list (footer columns etc.) ---- */}
            {d.type === 'linkList' && (
              <ListShell onAdd={() => setList([...list, { label: 'New link', to: '/' }])}>
                {list.map((item, i) => (
                  <div key={i} className="flex items-center gap-1.5 mb-2">
                    <input className={inputCls} value={item.label || ''} onChange={(e) => setField(i, 'label', e.target.value)} placeholder="Label" />
                    <input className={inputCls} value={item.to || ''} onChange={(e) => setField(i, 'to', e.target.value)} placeholder="/path" />
                    <ListBtns i={i} len={list.length} move={move} removeAt={removeAt} />
                  </div>
                ))}
              </ListShell>
            )}

            {/* ---- Why-Choose feature cards ---- */}
            {d.type === 'features' && (
              <ListShell onAdd={() => setList([...list, { icon: 'star', title: 'New feature', description: '', color: '#FFD600' }])}>
                {list.map((f, i) => (
                  <div key={i} className="rounded-xl border border-white/10 p-3 mb-3 bg-rx-dark/50">
                    <div className="flex items-center gap-1.5 mb-2">
                      <select className={inputCls} value={f.icon || 'star'} onChange={(e) => setField(i, 'icon', e.target.value)}>
                        {['shield', 'zap', 'globe', 'download', 'users', 'star'].map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                      <input type="color" value={f.color || '#FFD600'} onChange={(e) => setField(i, 'color', e.target.value)} className="w-9 h-9 rounded-lg bg-transparent border border-white/10 cursor-pointer flex-shrink-0" />
                      <ListBtns i={i} len={list.length} move={move} removeAt={removeAt} />
                    </div>
                    <input className={`${inputCls} mb-2`} value={f.title || ''} onChange={(e) => setField(i, 'title', e.target.value)} placeholder="Title" />
                    <textarea className={`${inputCls} resize-y min-h-[56px]`} value={f.description || ''} onChange={(e) => setField(i, 'description', e.target.value)} placeholder="Description" />
                  </div>
                ))}
              </ListShell>
            )}

            {/* ---- platform availability cards ---- */}
            {d.type === 'platformCards' && (
              <ListShell onAdd={() => setList([...list, { name: 'New platform', icon: '📦', desc: '' }])}>
                {list.map((p, i) => (
                  <div key={i} className="flex items-center gap-1.5 mb-2">
                    <input className={`${inputCls} !w-16 text-center`} value={p.icon || ''} onChange={(e) => setField(i, 'icon', e.target.value)} title="Emoji" />
                    <input className={inputCls} value={p.name || ''} onChange={(e) => setField(i, 'name', e.target.value)} placeholder="Name" />
                    <input className={inputCls} value={p.desc || ''} onChange={(e) => setField(i, 'desc', e.target.value)} placeholder="Note" />
                    <ListBtns i={i} len={list.length} move={move} removeAt={removeAt} />
                  </div>
                ))}
              </ListShell>
            )}

            {/* ---- categories (name/description per id) ---- */}
            {d.type === 'categories' && (
              <ListShell onAdd={() => setList([...list, { id: `custom-${Date.now()}`, name: 'New category', description: '', icon: 'Globe', color: '#FFD600' }])}>
                <p className="text-[11px] text-rx-gray-medium mb-2">Categories also appear under Browse filters. App counts stay automatic.</p>
                {list.map((c, i) => (
                  <div key={c.id || i} className="rounded-xl border border-white/10 p-3 mb-3 bg-rx-dark/50">
                    <div className="flex items-center gap-1.5 mb-2">
                      <input className={`${inputCls} !w-24`} value={c.icon || ''} onChange={(e) => setField(i, 'icon', e.target.value)} title="Icon (Heart/GraduationCap/Zap/Cpu/Gamepad2/Users/Globe)" />
                      <input type="color" value={c.color || '#FFD600'} onChange={(e) => setField(i, 'color', e.target.value)} className="w-9 h-9 rounded-lg bg-transparent border border-white/10 cursor-pointer flex-shrink-0" />
                      <span className="text-[10px] text-rx-gray-medium truncate flex-1 px-1">{c.id}</span>
                      <ListBtns i={i} len={list.length} move={move} removeAt={removeAt} />
                    </div>
                    <input className={`${inputCls} mb-2`} value={c.name || ''} onChange={(e) => setField(i, 'name', e.target.value)} placeholder="Name" />
                    <input className={inputCls} value={c.description || ''} onChange={(e) => setField(i, 'description', e.target.value)} placeholder="Description" />
                  </div>
                ))}
              </ListShell>
            )}

            {/* ---- About tech-stack cards ---- */}
            {d.type === 'stackCards' && (
              <ListShell onAdd={() => setList([...list, { title: 'New area', items: [], color: '#FFD600' }])}>
                {list.map((s, i) => (
                  <div key={i} className="rounded-xl border border-white/10 p-3 mb-3 bg-rx-dark/50">
                    <div className="flex items-center gap-1.5 mb-2">
                      <input className={inputCls} value={s.title || ''} onChange={(e) => setField(i, 'title', e.target.value)} placeholder="Title" />
                      <input type="color" value={s.color || '#FFD600'} onChange={(e) => setField(i, 'color', e.target.value)} className="w-9 h-9 rounded-lg bg-transparent border border-white/10 cursor-pointer flex-shrink-0" />
                      <ListBtns i={i} len={list.length} move={move} removeAt={removeAt} />
                    </div>
                    <textarea
                      className={`${inputCls} resize-y min-h-[72px]`}
                      value={(s.items || []).join('\n')}
                      onChange={(e) => setField(i, 'items', e.target.value.split('\n').filter((x) => x.trim()))}
                      placeholder={'One item per line'}
                    />
                  </div>
                ))}
              </ListShell>
            )}

            {/* ---- hero stat labels (values stay live) ---- */}
            {d.type === 'statsLabels' && (
              <>
                <p className="text-[11px] text-rx-gray-medium mb-2">Values are always live counts — labels are editable.</p>
                {list.map((s, i) => (
                  <div key={i} className="flex items-center gap-1.5 mb-2">
                    <input className={inputCls} value={s.label || ''} onChange={(e) => setField(i, 'label', e.target.value)} />
                  </div>
                ))}
              </>
            )}

            {/* ---- global design tokens ---- */}
            {d.type === 'design' && <DesignEditor onClose={() => edit.closeInspector()} />}

            {d.type !== 'design' && (
              <div className="flex gap-2 mt-5 sticky bottom-0 bg-rx-dark-secondary pt-3 pb-1 border-t border-white/10">
                <button onClick={() => edit.closeInspector()} className="flex-1 py-2.5 rounded-xl bg-white/5 text-white border border-white/10 text-sm">
                  Cancel
                </button>
                <button
                  onClick={doSave}
                  disabled={saving === d.id}
                  className="flex-1 py-2.5 rounded-xl bg-rx-yellow text-rx-dark font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 hover:bg-rx-yellow-light transition-colors"
                >
                  {saving === d.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save — publish now
                </button>
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function ListShell({ children, onAdd }: { children: React.ReactNode; onAdd: () => void }) {
  return (
    <div>
      {children}
      <button onClick={onAdd} className="w-full mt-1 py-2 rounded-xl border border-dashed border-rx-yellow/40 text-rx-yellow text-sm flex items-center justify-center gap-1.5 hover:bg-rx-yellow/10">
        <Plus className="w-4 h-4" /> Add item
      </button>
    </div>
  );
}

function ListBtns({ i, len, move, removeAt }: { i: number; len: number; move: (i: number, d: -1 | 1) => void; removeAt: (i: number) => void }) {
  return (
    <div className="flex flex-col gap-0.5 flex-shrink-0">
      <button onClick={() => move(i, -1)} disabled={i === 0} className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-30" title="Move up"><ArrowUp className="w-3 h-3" /></button>
      <button onClick={() => move(i, 1)} disabled={i === len - 1} className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-30" title="Move down"><ArrowDown className="w-3 h-3" /></button>
      <button onClick={() => removeAt(i)} className="p-1 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20" title="Remove"><Trash2 className="w-3 h-3" /></button>
    </div>
  );
}

/** Global brand/design colors — saved token-by-token so each publishes immediately. */
const DESIGN_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: 'design.brandColor', label: 'Brand color (buttons, highlights)', hint: 'Site-wide yellow accent' },
  { key: 'design.brandColorLight', label: 'Brand hover color', hint: 'Hover state of the accent' },
  { key: 'design.brandColorDark', label: 'Brand dark color', hint: 'Pressed / dimmed accent' },
  { key: 'design.bgColor', label: 'Page background', hint: 'Darkest background' },
  { key: 'design.surfaceColor', label: 'Card surface', hint: 'Cards & panels' },
  { key: 'design.surfaceColor2', label: 'Raised surface', hint: 'Inputs, chips, hover areas' },
];

function DesignEditor({ onClose }: { onClose: () => void }) {
  const { get, save } = useContent();
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const f of DESIGN_FIELDS) o[f.key] = get(f.key, '');
    return o;
  });
  const [busy, setBusy] = useState(false);

  const saveAll = async () => {
    setBusy(true);
    let ok = true;
    for (const f of DESIGN_FIELDS) {
      const v = (vals[f.key] || '').trim();
      const cur = get(f.key, '');
      if (v === cur) continue;
      if (v && !/^#[0-9a-f]{6}$/i.test(v)) { toast.error(`${f.label}: use #RRGGBB`); ok = false; continue; }
      ok = (await save(f.key, v)) && ok;
    }
    setBusy(false);
    if (ok) { toast.success('Design published site-wide 🎨'); onClose(); }
  };

  return (
    <div>
      {DESIGN_FIELDS.map((f) => (
        <Row key={f.key}>
          <label className={labelCls}>{f.label}</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(vals[f.key] || '') ? vals[f.key] : '#0F1419'}
              onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
              className="w-12 h-10 rounded-lg bg-transparent border border-white/10 cursor-pointer"
            />
            <input className={inputCls} value={vals[f.key] || ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} placeholder="(site default)" />
          </div>
          <p className="text-[11px] text-rx-gray-medium mt-1">{f.hint} — empty resets to default.</p>
        </Row>
      ))}
      <button
        onClick={() => { setVals(Object.fromEntries(DESIGN_FIELDS.map((f) => [f.key, '']))); }}
        className="w-full mt-2 py-2 rounded-xl bg-white/5 text-rx-gray-medium border border-white/10 text-sm flex items-center justify-center gap-1.5"
      >
        <RotateCcw className="w-4 h-4" /> Reset all to site defaults
      </button>
      <div className="flex gap-2 mt-4 sticky bottom-0 bg-rx-dark-secondary pt-3 pb-1 border-t border-white/10">
        <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-white/5 text-white border border-white/10 text-sm">Cancel</button>
        <button onClick={saveAll} disabled={busy} className="flex-1 py-2.5 rounded-xl bg-rx-yellow text-rx-dark font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 hover:bg-rx-yellow-light transition-colors">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Publish design
        </button>
      </div>
    </div>
  );
}
