/**
 * Admin → Storefront (Phase 15).
 * Manage the storefront WITHOUT source edits: hero banner (site settings),
 * featured placements (app, section, ordering, start/end dates, banner,
 * promo text, enable/disable). Everything is stored in D1 and consumed by
 * GET /storefront/home.
 */
import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Search, GripVertical } from 'lucide-react';
import { api } from '../../services/api';
import { formatDate } from '../../utils/helpers';
import toast from 'react-hot-toast';

const PLACEMENTS = [
  { id: 'home_featured', label: 'Home — Featured' },
  { id: 'games_featured', label: 'Home — Games row' },
  { id: 'apps_featured', label: 'Home — Apps row' },
];

export default function StorefrontAdminPanel() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [hero, setHero] = useState({ title: '', subtitle: '', banner: '', ctaLabel: '', ctaTo: '' });
  const [picker, setPicker] = useState<{ open: boolean; q: string; results: any[]; placement: string }>({ open: false, q: '', results: [], placement: 'home_featured' });

  const load = () => {
    setLoading(true);
    api.adminStorefront.get().then((d: any) => {
      setData(d);
      setHero(d.hero || { title: '', subtitle: '', banner: '', ctaLabel: '', ctaTo: '' });
    }).catch((e: any) => toast.error(e?.message || 'Could not load storefront config'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const searchApps = async (q: string) => {
    setPicker((p) => ({ ...p, q }));
    if (q.trim().length < 2) { setPicker((p) => ({ ...p, results: [] })); return; }
    try {
      const d = await api.adminStorefront.searchApps(q.trim());
      setPicker((p) => ({ ...p, results: d.apps || [] }));
    } catch { setPicker((p) => ({ ...p, results: [] })); }
  };

  const addFeatured = async (appId: string) => {
    setBusy(true);
    try {
      const maxOrder = Math.max(0, ...(data?.featured || []).filter((f: any) => f.placement === picker.placement).map((f: any) => f.sortOrder));
      await api.adminStorefront.saveFeatured({ appId, placement: picker.placement, sortOrder: maxOrder + 1 });
      toast.success('Added to the storefront');
      setPicker({ open: false, q: '', results: [], placement: 'home_featured' });
      load();
    } catch (e: any) { toast.error(e?.message || 'Could not add'); }
    setBusy(false);
  };

  const saveFeatured = async (f: any, patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.adminStorefront.saveFeatured({
        id: f.id, appId: f.appId, placement: f.placement, sortOrder: f.sortOrder,
        startsAt: f.startsAt || '', endsAt: f.endsAtAt || f.endsAt || '', bannerUrl: f.bannerUrl || '',
        promoText: f.promoText || '', enabled: f.enabled, ...patch,
      });
      load();
    } catch (e: any) { toast.error(e?.message || 'Could not save'); }
    setBusy(false);
  };

  const removeFeatured = async (id: string) => {
    if (!confirm('Remove this featured placement?')) return;
    setBusy(true);
    try { await api.adminStorefront.deleteFeatured(id); toast.success('Removed'); load(); }
    catch (e: any) { toast.error(e?.message || 'Could not remove'); }
    setBusy(false);
  };

  const saveHero = async () => {
    setBusy(true);
    try { await api.adminStorefront.saveHero(hero); toast.success('Hero banner saved'); }
    catch (e: any) { toast.error(e?.message || 'Could not save hero'); }
    setBusy(false);
  };

  const inputCls = 'w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50';

  if (loading) return <div className="card p-8 animate-pulse space-y-3"><div className="h-5 bg-white/5 rounded w-1/3" /><div className="h-20 bg-white/5 rounded" /></div>;

  const featured = data?.featured || [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Storefront</h2>
        <p className="text-sm text-rx-gray-medium mt-1">Home hero banner and featured content — no source edits needed. Changes are live immediately on the storefront.</p>
      </div>

      {/* Hero banner */}
      <div className="card p-5 md:p-6 space-y-4">
        <h3 className="font-semibold text-white text-sm">Hero banner (Home top)</h3>
        <div className="grid sm:grid-cols-2 gap-4">
          <div><label className="block text-xs text-rx-gray-medium mb-1.5">Title</label><input className={inputCls} value={hero.title} onChange={(e) => setHero({ ...hero, title: e.target.value })} placeholder="Healthcare tools, delivered" /></div>
          <div><label className="block text-xs text-rx-gray-medium mb-1.5">Banner image URL</label><input className={inputCls} value={hero.banner} onChange={(e) => setHero({ ...hero, banner: e.target.value })} placeholder="https://…/banner.png" /></div>
          <div className="sm:col-span-2"><label className="block text-xs text-rx-gray-medium mb-1.5">Subtitle</label><input className={inputCls} value={hero.subtitle} onChange={(e) => setHero({ ...hero, subtitle: e.target.value })} placeholder="Professional apps for healthcare, education and beyond" /></div>
          <div><label className="block text-xs text-rx-gray-medium mb-1.5">Button label</label><input className={inputCls} value={hero.ctaLabel} onChange={(e) => setHero({ ...hero, ctaLabel: e.target.value })} placeholder="Browse apps" /></div>
          <div><label className="block text-xs text-rx-gray-medium mb-1.5">Button link</label><input className={inputCls} value={hero.ctaTo} onChange={(e) => setHero({ ...hero, ctaTo: e.target.value })} placeholder="/browse" /></div>
        </div>
        {hero.banner && <img src={hero.banner} alt="Hero preview" className="h-28 w-full object-cover rounded-xl border border-white/10" />}
        <div className="flex justify-end"><button onClick={saveHero} disabled={busy} className="btn-primary text-sm disabled:opacity-40">{busy ? 'Saving…' : 'Save hero'}</button></div>
      </div>

      {/* Featured placements */}
      <div className="card p-5 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-semibold text-white text-sm">Featured content</h3>
          <button onClick={() => setPicker({ open: !picker.open, q: '', results: [], placement: 'home_featured' })} className="btn-primary text-sm flex items-center gap-2"><Plus className="w-4 h-4" /> Feature an app</button>
        </div>

        {picker.open && (
          <div className="p-4 rounded-xl bg-rx-dark-tertiary/50 border border-white/5 space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <select className="bg-rx-dark border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" value={picker.placement} onChange={(e) => setPicker({ ...picker, placement: e.target.value })}>
                {PLACEMENTS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-rx-gray-medium" />
                <input autoFocus className={`${inputCls} pl-9`} placeholder="Search apps by name…" value={picker.q} onChange={(e) => searchApps(e.target.value)} />
              </div>
            </div>
            {picker.results.length > 0 && (
              <div className="divide-y divide-white/5 rounded-xl border border-white/10 max-h-56 overflow-y-auto">
                {picker.results.map((a: any) => (
                  <button key={a.id} onClick={() => addFeatured(a.id)} className="w-full p-3 flex items-center gap-3 hover:bg-white/5 text-left">
                    {a.icon ? <img src={a.icon} alt="" className="w-9 h-9 rounded-lg object-cover" /> : <div className="w-9 h-9 rounded-lg bg-rx-dark-tertiary" />}
                    <div className="flex-1 min-w-0"><p className="text-sm text-white truncate">{a.name}</p><p className="text-xs text-rx-gray-medium">{a.slug} · {a.status}</p></div>
                    <span className="text-xs text-rx-yellow">Feature →</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {featured.length === 0 ? (
          <p className="text-sm text-rx-gray-medium py-4 text-center">No featured placements yet — feature an app to pin it to a home section. Without curation, sections still render from real marketplace data automatically.</p>
        ) : (
          <div className="space-y-3">
            {featured.map((f: any) => (
              <div key={f.id} className="p-4 rounded-xl bg-rx-dark-tertiary/60 border border-white/5">
                <div className="flex items-center gap-3 flex-wrap">
                  {f.appIcon ? <img src={f.appIcon} alt="" className="w-10 h-10 rounded-lg object-cover" /> : <div className="w-10 h-10 rounded-lg bg-rx-dark" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{f.appName || f.appId} <span className="text-rx-gray-medium font-normal">· {PLACEMENTS.find((p) => p.id === f.placement)?.label || f.placement}</span></p>
                    <p className="text-xs text-rx-gray-medium">{f.appStatus === 'active' ? 'listed' : `app ${f.appStatus}`}</p>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-rx-gray-medium cursor-pointer">
                    <input type="checkbox" checked={f.enabled} onChange={(e) => saveFeatured(f, { enabled: e.target.checked })} className="w-4 h-4 rounded" title="Enabled" />
                    Enabled
                  </label>
                  <button onClick={() => removeFeatured(f.id)} className="p-1.5 rounded-lg text-rx-gray-medium hover:text-red-400 hover:bg-red-400/10" title="Remove"><Trash2 className="w-4 h-4" /></button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
                  <div className="flex items-center gap-1.5">
                    <GripVertical className="w-3.5 h-3.5 text-rx-gray-medium/50" />
                    <input type="number" className="w-full bg-rx-dark border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white" value={f.sortOrder}
                      onChange={(e) => saveFeatured(f, { sortOrder: Number(e.target.value) || 0 })} title="Sort order (lower first)" />
                  </div>
                  <div><input type="date" className="w-full bg-rx-dark border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white" value={(f.startsAt || '').slice(0, 10)}
                    onChange={(e) => saveFeatured(f, { startsAt: e.target.value })} title="Start date (optional)" /></div>
                  <div><input type="date" className="w-full bg-rx-dark border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white" value={(f.endsAt || '').slice(0, 10)}
                    onChange={(e) => saveFeatured(f, { endsAt: e.target.value })} title="End date (optional)" /></div>
                  <div><input className="w-full bg-rx-dark border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white" value={f.promoText || ''}
                    onChange={(e) => saveFeatured(f, { promoText: e.target.value })} placeholder="Promo text (optional)" /></div>
                </div>
                <p className="text-[10px] text-rx-gray-medium/60 mt-2">
                  Live {f.startsAt ? `from ${formatDate(f.startsAt)}` : 'anytime'}{f.endsAt ? ` until ${formatDate(f.endsAt)}` : ''} — date windows hide expired placements automatically.
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
