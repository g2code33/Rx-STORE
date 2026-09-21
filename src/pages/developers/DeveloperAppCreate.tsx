/**
 * /developers/apps/new — create an application (Phase 12 §3).
 * Creates a DRAFT: never publicly visible until admin approval.
 */
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, AlertCircle } from 'lucide-react';
import { api, isApiConfigured } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';

const CATEGORIES = ['healthcare', 'education', 'productivity', 'technology', 'gaming', 'social'];
const PLATFORMS = ['web', 'windows', 'linux', 'android', 'ios'];

export default function DeveloperAppCreate() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '', description: '', longDescription: '', category: 'healthcare',
    tags: '', platforms: ['web'] as string[], icon: '', website: '',
  });
  const [busy, setBusy] = useState(false);

  if (!user) { navigate('/login'); return null; }
  const inputCls = 'w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-3 text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 transition-all';

  const togglePlatform = (p: string) => {
    setForm((f) => ({ ...f, platforms: f.platforms.includes(p) ? f.platforms.filter((x) => x !== p) : [...f.platforms, p] }));
  };

  const create = async () => {
    setBusy(true);
    try {
      const res = await api.developers.apps.create({
        name: form.name, description: form.description, longDescription: form.longDescription,
        category: form.category, tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        platforms: form.platforms, icon: form.icon, website: form.website,
      });
      toast.success('App created as a draft');
      navigate(`/developers/apps/${res.app.id}`);
    } catch (e: any) { toast.error(e?.message || 'Could not create the app'); }
    setBusy(false);
  };

  return (
    <div className="section-container max-w-3xl py-10 md:py-14">
      <Link to="/developers/apps" className="inline-flex items-center gap-1.5 text-sm text-rx-gray-medium hover:text-white transition-colors">
        <ArrowLeft className="w-4 h-4" /> My Apps
      </Link>
      <h1 className="text-2xl sm:text-3xl font-black text-white mt-4">Create an App</h1>
      <p className="text-rx-gray-medium mt-2 text-sm">
        The app is created as a <b className="text-white">draft</b> — invisible to the marketplace until an admin approves it.
      </p>

      {!isApiConfigured() ? (
        <div className="card p-8 text-center mt-8">
          <AlertCircle className="w-8 h-8 text-rx-yellow mx-auto" />
          <p className="text-sm text-rx-gray-medium mt-3">Backend not connected — install a correctly configured build.</p>
        </div>
      ) : (
        <div className="card p-6 md:p-8 mt-8 space-y-5">
          <div className="grid sm:grid-cols-2 gap-5">
            <div>
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">App name *</label>
              <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Clinical Rx" />
            </div>
            <div>
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Category *</label>
              <select className={inputCls} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Short description * <span className="text-rx-gray-medium/60 font-normal">(shown on cards)</span></label>
              <input className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="One line about what your app does (10+ characters)" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Full description</label>
              <textarea rows={4} className={inputCls} value={form.longDescription} onChange={(e) => setForm({ ...form, longDescription: e.target.value })} placeholder="Tell users everything about your app…" />
            </div>
            <div>
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Icon URL * <span className="text-rx-gray-medium/60 font-normal">(required before submission)</span></label>
              <input className={inputCls} value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} placeholder="https://…/icon.png" />
            </div>
            <div>
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Website</label>
              <input className={inputCls} value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://…" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Tags <span className="text-rx-gray-medium/60 font-normal">(comma separated)</span></label>
              <input className={inputCls} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="healthcare, offline, AI" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-rx-gray-medium mb-2">Supported platforms * <span className="text-rx-gray-medium/60 font-normal">(iOS is PWA-based)</span></label>
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map((p) => (
                <button key={p} type="button" onClick={() => togglePlatform(p)}
                  className={`px-4 py-2 rounded-xl text-sm font-medium border transition-all ${form.platforms.includes(p) ? 'bg-rx-yellow/10 text-rx-yellow border-rx-yellow/30' : 'text-rx-gray-medium border-white/10 hover:text-white'}`}>
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="flex justify-end">
            <button onClick={create} disabled={busy || !form.name || !form.description} className="btn-primary disabled:opacity-40">
              {busy ? 'Creating…' : 'Create draft app'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
