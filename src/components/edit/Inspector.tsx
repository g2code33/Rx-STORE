import React, { useEffect, useMemo, useState } from 'react';
import { X, Save, Loader2, Check, Trash2, ArrowUp, ArrowDown, Plus, UploadCloud, RotateCcw, Paintbrush, Monitor, Tablet, Smartphone, History } from 'lucide-react';
import toast from 'react-hot-toast';
import { useContent } from '../../context/ContentContext';
import { useEditMode } from './EditMode';
import { StyleOverrides } from './Editable';
import { API_URL } from '../../services/api';

/**
 * The focused edit drawer — mirrors the reference Live Website Builder:
 * Content | Style | Layout | Responsive | Theme tabs. Every editor opens
 * PRE-FILLED with the exact text the visitor currently sees, and every Save
 * publishes immediately (failures queue for Publish All).
 */

type Tab = 'content' | 'style' | 'layout' | 'responsive' | 'theme';
const TABS: { id: Tab; label: string }[] = [
  { id: 'content', label: 'Content' },
  { id: 'style', label: 'Style' },
  { id: 'layout', label: 'Layout' },
  { id: 'responsive', label: 'Responsive' },
  { id: 'theme', label: 'Theme' },
];

const inputCls = 'w-full bg-rx-dark border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-rx-yellow/50';
const labelCls = 'block text-[11px] uppercase tracking-wider text-rx-gray-medium mb-1';
const selCls = `${inputCls} cursor-pointer`;

function Row({ children }: { children: React.ReactNode }) { return <div className="mb-3">{children}</div>; }

export default function Inspector() {
  const edit = useEditMode();
  const { getEffective, getEffectiveJSON, save, applyLocal, saving, savedAt, pending } = useContent();
  const [tab, setTab] = useState<Tab>('content');
  const [draft, setDraft] = useState<any>('');
  const [sty, setSty] = useState<StyleOverrides>({});
  const [uploading, setUploading] = useState(false);

  const d = edit?.inspector;
  const styleKey = d ? `style.${d.id}` : '';

  // Load current values (pre-filled with exactly what the visitor sees)
  useEffect(() => {
    if (!d) return;
    setTab('content');
    if (d.type === 'text' || d.type === 'textarea' || d.type === 'color') setDraft(getEffective(d.id, ''));
    else if (d.type === 'link') setDraft(getEffectiveJSON(d.id, { label: '', to: '' }));
    else if (d.type === 'image') setDraft(getEffectiveJSON(d.id, { url: '', alt: '', pos: 'center' }));
    else if (d.type === 'design') setDraft('');
    else setDraft(getEffectiveJSON(d.id, []));
    setSty(getEffectiveJSON(`style.${d.id}`, {}));
  }, [d?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeKey = tab === 'content' ? d?.id : styleKey;
  const isPending = activeKey ? pending.some((p) => p.key === activeKey) : false;
  const justSaved = activeKey ? savedAt[activeKey] : 0;
  const busySaving = activeKey ? saving === activeKey : false;

  const doSave = async () => {
    if (!d) return;
    if (tab === 'content') {
      const ok = await save(d.id, draft);
      if (ok) { toast.success('Published — live on the website ✓'); edit.closeInspector(); }
    } else {
      const ok = await save(styleKey, cleanSty(sty));
      if (ok) toast.success('Styling published ✓');
    }
  };

  const resetStyling = async () => {
    if (!d) return;
    setSty({});
    const ok = await save(styleKey, '');
    if (ok) toast.success('Styling reset to site defaults ✓');
  };

  // Style helpers — '' / undefined / false removes the key (back to default)
  const setStyField = (k: keyof StyleOverrides, v: any) =>
    setSty((s) => { const n: any = { ...s }; if (v === '' || v === undefined || v === false) delete n[k]; else n[k] = v; return n; });

  // Load a raw stored string back into the active editor (used by History restore)
  const loadValueIntoEditor = (raw: string) => {
    if (tab === 'content') {
      if (d?.type === 'text' || d?.type === 'textarea' || d?.type === 'color') setDraft(raw);
      else { try { setDraft(JSON.parse(raw)); } catch { setDraft(d?.type === 'link' ? { label: '', to: '' } : d?.type === 'image' ? { url: '', alt: '', pos: 'center' } : []); } }
    } else {
      try { setSty(JSON.parse(raw) || {}); } catch { setSty({}); }
    }
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
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-widest text-rx-yellow truncate">{d.type} · {d.id}</p>
                <h3 className="text-lg font-bold text-white truncate">{d.label}</h3>
                <p className="text-[11px] text-rx-gray-medium">Live Website Builder · editing in place</p>
              </div>
              <button onClick={() => edit.closeInspector()} className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-rx-gray-medium hover:text-white flex-shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Tabs — reference builder parity (design editor stays single-tab) */}
            {d.type !== 'design' && (
              <div className="flex rounded-xl overflow-hidden border border-white/10 my-4">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`flex-1 py-2 text-[11px] font-bold transition-colors ${tab === t.id ? 'bg-rx-yellow text-rx-dark' : 'text-rx-gray-medium hover:text-white hover:bg-white/5'}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}

            {/* status line */}
            <p className="text-xs mb-4">
              {busySaving ? (
                <span className="text-rx-yellow flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Publishing…</span>
              ) : isPending ? (
                <span className="text-amber-300">● Not yet published — queued for Publish All</span>
              ) : justSaved ? (
                <span className="text-green-400 flex items-center gap-1"><Check className="w-3 h-3" /> Published {new Date(justSaved).toLocaleTimeString()}</span>
              ) : (
                <span className="text-rx-gray-medium">Pre-filled with the live text. Saves publish immediately.</span>
              )}
            </p>

            {/* Revision history — every save is versioned server-side (last 30) */}
            {d.type !== 'design' && activeKey && (
              <HistoryPanel keyName={activeKey} onReverted={loadValueIntoEditor} applyLocal={applyLocal} />
            )}

            {/* ================= CONTENT TAB ================= */}
            {tab === 'content' && (
              <>
                {d.type === 'text' && (
                  <Row><label className={labelCls}>Text</label><input className={inputCls} value={draft || ''} onChange={(e) => setDraft(e.target.value)} /></Row>
                )}
                {d.type === 'textarea' && (
                  <Row><label className={labelCls}>Text</label><textarea className={`${inputCls} min-h-[120px] resize-y`} value={draft || ''} onChange={(e) => setDraft(e.target.value)} /></Row>
                )}
                {d.type === 'link' && (
                  <>
                    <Row><label className={labelCls}>Button / link label</label><input className={inputCls} value={draft?.label || ''} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></Row>
                    <Row><label className={labelCls}>Destination (path or URL)</label><input className={inputCls} placeholder="/browse or https://…" value={draft?.to || ''} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Row>
                  </>
                )}
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
                      <select className={selCls} value={draft?.pos || 'center'} onChange={(e) => setDraft({ ...draft, pos: e.target.value })}>
                        {['center', 'top', 'bottom', 'left', 'right'].map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </Row>
                  </>
                )}
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
                {d.type === 'features' && (
                  <ListShell onAdd={() => setList([...list, { icon: 'star', title: 'New feature', description: '', color: '#FFD600' }])}>
                    {list.map((f, i) => (
                      <div key={i} className="rounded-xl border border-white/10 p-3 mb-3 bg-rx-dark/50">
                        <div className="flex items-center gap-1.5 mb-2">
                          <select className={selCls} value={f.icon || 'star'} onChange={(e) => setField(i, 'icon', e.target.value)}>
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
                {d.type === 'design' && <DesignEditor onClose={() => edit.closeInspector()} />}
              </>
            )}

            {/* ================= STYLE TAB ================= */}
            {tab === 'style' && (
              <>
                <Row>
                  <label className={labelCls}>Text color</label>
                  <ColorField value={sty.color || ''} onChange={(v) => setStyField('color', v)} />
                </Row>
                <Row>
                  <label className={labelCls}>Background color</label>
                  <ColorField value={sty.bg || ''} onChange={(v) => setStyField('bg', v)} />
                </Row>
                <Row>
                  <label className={labelCls}>Font size</label>
                  <select className={selCls} value={sty.fontSize || ''} onChange={(e) => setStyField('fontSize', e.target.value)}>
                    <option value="">Default (inherit)</option>
                    <option value="xs">Extra small</option>
                    <option value="sm">Small</option>
                    <option value="base">Normal</option>
                    <option value="lg">Large</option>
                    <option value="xl">Extra large</option>
                    <option value="2xl">Huge</option>
                  </select>
                </Row>
                <Row>
                  <label className={labelCls}>Font weight</label>
                  <select className={selCls} value={sty.fontWeight || ''} onChange={(e) => setStyField('fontWeight', e.target.value)}>
                    <option value="">Default</option>
                    <option value="400">Regular</option>
                    <option value="500">Medium</option>
                    <option value="600">Semi-bold</option>
                    <option value="700">Bold</option>
                    <option value="800">Extra bold</option>
                  </select>
                </Row>
                <Row>
                  <label className={labelCls}>Text alignment</label>
                  <div className="flex rounded-xl overflow-hidden border border-white/10">
                    {(['', 'left', 'center', 'right'] as const).map((a) => (
                      <button key={a || 'default'} onClick={() => setStyField('align', a)} className={`flex-1 py-2 text-xs font-semibold capitalize ${(sty.align || '') === a ? 'bg-rx-yellow text-rx-dark' : 'text-rx-gray-medium hover:text-white'}`}>
                        {a || 'Default'}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row>
                  <label className={labelCls}>Opacity — {Math.round((sty.opacity ?? 1) * 100)}%</label>
                  <input type="range" min={30} max={100} value={Math.round((sty.opacity ?? 1) * 100)} onChange={(e) => { const v = Number(e.target.value); setStyField('opacity', v >= 100 ? '' : v / 100); }} className="w-full accent-rx-yellow" />
                </Row>
              </>
            )}

            {/* ================= LAYOUT TAB ================= */}
            {tab === 'layout' && (
              <>
                <Row>
                  <label className={labelCls}>Padding</label>
                  <select className={selCls} value={sty.pad || ''} onChange={(e) => setStyField('pad', e.target.value)}>
                    <option value="">Default</option>
                    <option value="none">None</option>
                    <option value="sm">Small</option>
                    <option value="md">Medium</option>
                    <option value="lg">Large</option>
                    <option value="xl">Extra large</option>
                  </select>
                </Row>
                <Row>
                  <label className={labelCls}>Corner radius</label>
                  <select className={selCls} value={sty.radius || ''} onChange={(e) => setStyField('radius', e.target.value)}>
                    <option value="">Default</option>
                    <option value="none">Square</option>
                    <option value="sm">Small</option>
                    <option value="md">Medium</option>
                    <option value="lg">Large</option>
                    <option value="full">Pill</option>
                  </select>
                </Row>
                <Row>
                  <label className={labelCls}>Width</label>
                  <div className="flex rounded-xl overflow-hidden border border-white/10">
                    {(['', '100%', '75%', '50%', '33.333%'] as const).map((w) => (
                      <button key={w || 'auto'} onClick={() => setStyField('width', w)} className={`flex-1 py-2 text-[11px] font-semibold ${(sty.width || '') === w ? 'bg-rx-yellow text-rx-dark' : 'text-rx-gray-medium hover:text-white'}`}>
                        {w ? w.replace('.333%', '') + (w.startsWith('33') ? '⅓' : '') : 'Auto'}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row>
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className={labelCls}>Center horizontally</span>
                    <button onClick={() => setStyField('center', !sty.center)} className={`w-11 h-6 rounded-full relative transition-colors ${sty.center ? 'bg-rx-yellow' : 'bg-rx-dark-tertiary border border-white/10'}`}>
                      <span className={`w-4 h-4 rounded-full absolute top-1 transition-all ${sty.center ? 'right-1 bg-rx-dark' : 'left-1 bg-white/70'}`} />
                    </button>
                  </label>
                  <p className="text-[11px] text-rx-gray-medium mt-1">Applies auto margins — combine with a width below 100% to center the block.</p>
                </Row>
              </>
            )}

            {/* ================= RESPONSIVE TAB ================= */}
            {tab === 'responsive' && (
              <>
                <p className="text-[11px] text-rx-gray-medium mb-3">Choose where this element appears. Hidden elements are unpublished styling, not deleted content.</p>
                {([
                  { key: 'hideMobile', label: 'Hide on phones', desc: 'Screens under 640px', Icon: Smartphone },
                  { key: 'hideTablet', label: 'Hide on tablets', desc: '640 – 1024px', Icon: Tablet },
                  { key: 'hideDesktop', label: 'Hide on desktop', desc: 'Over 1024px', Icon: Monitor },
                ] as const).map(({ key, label, desc, Icon }) => (
                  <div key={key} className="flex items-center justify-between gap-3 py-3 border-b border-white/5">
                    <div className="flex items-center gap-3">
                      <Icon className="w-4 h-4 text-rx-gray-medium flex-shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-white">{label}</p>
                        <p className="text-[11px] text-rx-gray-medium">{desc}</p>
                      </div>
                    </div>
                    <button onClick={() => setStyField(key as any, !(sty as any)[key])} className={`w-11 h-6 rounded-full relative transition-colors flex-shrink-0 ${(sty as any)[key] ? 'bg-rx-yellow' : 'bg-rx-dark-tertiary border border-white/10'}`}>
                      <span className={`w-4 h-4 rounded-full absolute top-1 transition-all ${(sty as any)[key] ? 'right-1 bg-rx-dark' : 'left-1 bg-white/70'}`} />
                    </button>
                  </div>
                ))}
                <p className="text-[11px] text-rx-gray-medium mt-3">Use the device buttons in the builder toolbar to preview each size.</p>
              </>
            )}

            {/* ================= THEME TAB ================= */}
            {tab === 'theme' && (
              <>
                <p className="text-[11px] text-rx-gray-medium mb-3">One-tap looks for this element, on top of the site-wide theme.</p>
                <div className="grid grid-cols-2 gap-2 mb-4">
                  {([
                    { id: '', label: 'Default', hint: 'Inherit site theme' },
                    { id: 'accent', label: 'Accent', hint: 'Brand yellow text' },
                    { id: 'muted', label: 'Muted', hint: 'Quiet gray text' },
                    { id: 'card', label: 'Card', hint: 'Surface panel look' },
                  ] as const).map((t) => (
                    <button
                      key={t.id || 'default'}
                      onClick={() => setStyField('theme', t.id)}
                      className={`p-3 rounded-xl border text-left transition-all ${((sty.theme || '') === t.id) ? 'border-rx-yellow bg-rx-yellow/10' : 'border-white/10 hover:border-rx-yellow/40'}`}
                    >
                      <p className="text-sm font-bold text-white">{t.label}</p>
                      <p className="text-[11px] text-rx-gray-medium mt-0.5">{t.hint}</p>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => edit.openInspector({ id: 'design', type: 'design', label: 'Site-wide design' })}
                  className="w-full py-2.5 rounded-xl bg-white/5 border border-rx-yellow/30 text-rx-yellow text-sm font-semibold flex items-center justify-center gap-2 hover:bg-rx-yellow/10"
                >
                  <Paintbrush className="w-4 h-4" /> Open site-wide Design (brand & surfaces)
                </button>
              </>
            )}

            {/* Footer — per-tab immediate publish */}
            {d.type !== 'design' && (
              <>
                <div className="flex gap-2 mt-5 sticky bottom-0 bg-rx-dark-secondary pt-3 pb-1 border-t border-white/10">
                  <button onClick={() => edit.closeInspector()} className="flex-1 py-2.5 rounded-xl bg-white/5 text-white border border-white/10 text-sm">
                    Cancel
                  </button>
                  <button
                    onClick={doSave}
                    disabled={busySaving}
                    className="flex-1 py-2.5 rounded-xl bg-rx-yellow text-rx-dark font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 hover:bg-rx-yellow-light transition-colors"
                  >
                    {busySaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Save & publish
                  </button>
                </div>
                {tab !== 'content' && (
                  <button onClick={resetStyling} className="w-full mt-2 text-center text-xs text-rx-gray-medium hover:text-rx-yellow transition-colors flex items-center justify-center gap-1.5 pb-1">
                    <RotateCcw className="w-3 h-3" /> Reset desktop styling
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

/** Version history for the active element — auto-recorded on every save. */
function HistoryPanel({ keyName, onReverted, applyLocal }: { keyName: string; onReverted: (value: string) => void; applyLocal: (id: string, value: string) => void }) {
  const [revs, setRevs] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(0);

  useEffect(() => { setRevs(null); }, [keyName]);

  const load = () => {
    if (!API_URL) { setRevs([]); return; }
    fetch(`${API_URL}/admin/content/history?key=${encodeURIComponent(keyName)}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('rx-store-token') || ''}` },
    })
      .then((r) => r.json())
      .then((j) => setRevs(Array.isArray(j?.data?.revisions) ? j.data.revisions : []))
      .catch(() => setRevs([]));
  };

  const restore = async (r: any) => {
    setBusy(r.id);
    try {
      const res = await fetch(`${API_URL}/admin/content/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('rx-store-token') || ''}` },
        body: JSON.stringify({ key: keyName, id: r.id }),
      });
      const j = await res.json();
      if (!res.ok || !j?.success) throw new Error(j?.error?.message || 'Restore failed');
      applyLocal(keyName, r.value ?? '');
      onReverted(r.value ?? '');
      toast.success('Restored an earlier version ✓ (live now)');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(0);
    }
  };

  return (
    <details className="mb-4 rounded-xl border border-white/10 bg-rx-dark/40 overflow-hidden" onToggle={(e: any) => { if (e.target.open) load(); }}>
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-rx-gray-medium hover:text-white list-none flex items-center gap-2">
        <History className="w-3.5 h-3.5 text-rx-yellow" /> Version history
        <span className="text-[10px] text-rx-gray-medium/60 font-normal">— last 30 saves · undo to any</span>
      </summary>
      <div className="max-h-44 overflow-y-auto px-1.5 pb-1.5 border-t border-white/5">
        {revs === null && (
          <p className="px-2 py-3 text-xs text-rx-gray-medium flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Loading versions…</p>
        )}
        {revs !== null && revs.length === 0 && (
          <p className="px-2 py-3 text-xs text-rx-gray-medium">No versions yet — every Save & publish records one automatically.</p>
        )}
        {revs?.map((r, i) => (
          <div key={r.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5">
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-white truncate">{r.value ? String(r.value) : <i className="text-rx-gray-medium">(empty / reset)</i>}</p>
              <p className="text-[10px] text-rx-gray-medium">{r.created_at}{i === 0 ? ' · current' : ''}</p>
            </div>
            {i !== 0 && (
              <button
                disabled={busy === r.id}
                onClick={() => restore(r)}
                className="px-2 py-1 rounded-lg bg-rx-yellow/15 text-rx-yellow text-[10px] font-bold hover:bg-rx-yellow/25 disabled:opacity-50 flex-shrink-0"
              >
                {busy === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Restore'}
              </button>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

/** '#RRGGBB' picker with a typed field + auto (clear) button */
function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#8899AA'}
        onChange={(e) => onChange(e.target.value)}
        className="w-12 h-10 rounded-lg bg-transparent border border-white/10 cursor-pointer flex-shrink-0"
      />
      <input className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} placeholder="(default)" />
      {value && (
        <button onClick={() => onChange('')} className="px-2.5 py-2 rounded-lg bg-white/5 text-rx-gray-medium hover:text-white text-xs flex-shrink-0" title="Back to default">
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

function cleanSty(sty: StyleOverrides): StyleOverrides | '' {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(sty || {})) {
    if (v !== undefined && v !== '' && v !== false) out[k] = v;
  }
  return Object.keys(out).length ? (out as StyleOverrides) : '';
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
  const { getEffective, save } = useContent();
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const f of DESIGN_FIELDS) o[f.key] = getEffective(f.key, '');
    return o;
  });
  const [busy, setBusy] = useState(false);

  const saveAll = async () => {
    setBusy(true);
    let ok = true;
    for (const f of DESIGN_FIELDS) {
      const v = (vals[f.key] || '').trim();
      const cur = getEffective(f.key, '');
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
          <ColorField value={vals[f.key] || ''} onChange={(v) => setVals({ ...vals, [f.key]: v })} />
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
