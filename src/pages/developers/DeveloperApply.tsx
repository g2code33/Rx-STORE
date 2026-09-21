/**
 * /developers/apply — the "Become a Developer" application (Phase 11 §2).
 * Draft -> save anytime -> submit. Users with CHANGES_REQUESTED / REJECTED
 * applications edit and resubmit here (the admin's reason is shown).
 */
import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Send, AlertCircle, CheckCircle2 } from 'lucide-react';
import { api, isApiConfigured } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { clearDeveloperStatusCache } from './useDeveloperStatus';
import toast from 'react-hot-toast';

const EMPTY = {
  publisherName: '', developerType: 'individual', contactEmail: '', supportEmail: '',
  website: '', country: '', description: '', category: '', acceptedTerms: false,
};

const CATEGORIES = ['Healthcare', 'Education', 'Productivity', 'Technology', 'Gaming', 'Social', 'Tools', 'Other'];

export default function DeveloperApply() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ ...EMPTY, contactEmail: user?.email || '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [appStatus, setAppStatus] = useState<string | null>(null);
  const [reviewReason, setReviewReason] = useState('');

  useEffect(() => {
    if (!user) { navigate('/login'); return; }
    if (!isApiConfigured()) { setLoading(false); return; }
    let alive = true;
    api.developers.status().then((s: any) => {
      if (!alive) return;
      setAppStatus(s.status);
      const a = s.application;
      if (a) {
        setForm({
          publisherName: a.publisherName || '', developerType: a.developerType || 'individual',
          contactEmail: a.contactEmail || user?.email || '', supportEmail: a.supportEmail || '',
          website: a.website || '', country: a.country || '', description: a.description || '',
          category: a.category || '', acceptedTerms: !!a.acceptedTerms,
        });
        setReviewReason(a.reviewReason || '');
      }
    }).catch(() => {}).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return null;

  const editable = ['NOT_APPLIED', 'DRAFT', 'CHANGES_REQUESTED', 'REJECTED'].includes(appStatus || 'NOT_APPLIED');
  const inputCls = 'w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-3 text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 transition-all';

  const saveDraft = async () => {
    setSaving(true);
    try {
      await api.developers.saveApplication({
        publisher_name: form.publisherName, developer_type: form.developerType,
        contact_email: form.contactEmail, support_email: form.supportEmail,
        website: form.website, country: form.country, description: form.description,
        category: form.category, accepted_terms: form.acceptedTerms,
      });
      clearDeveloperStatusCache();
      toast.success('Draft saved — continue anytime');
      setAppStatus('DRAFT');
    } catch (e: any) { toast.error(e?.message || 'Could not save draft'); }
    setSaving(false);
  };

  const submit = async () => {
    if (!form.acceptedTerms) { toast.error('Please accept the developer terms first'); return; }
    setSubmitting(true);
    try {
      // Save the latest fields, then submit the full record for validation.
      await api.developers.saveApplication({
        publisher_name: form.publisherName, developer_type: form.developerType,
        contact_email: form.contactEmail, support_email: form.supportEmail,
        website: form.website, country: form.country, description: form.description,
        category: form.category, accepted_terms: form.acceptedTerms,
      });
      await api.developers.submitApplication();
      clearDeveloperStatusCache();
      toast.success('Application submitted for review');
      navigate('/developers/status');
    } catch (e: any) { toast.error(e?.message || 'Could not submit — check the required fields'); }
    setSubmitting(false);
  };

  return (
    <div className="section-container max-w-3xl py-10 md:py-14">
      <Link to="/developers" className="inline-flex items-center gap-1.5 text-sm text-rx-gray-medium hover:text-white transition-colors">
        <ArrowLeft className="w-4 h-4" /> Developer Platform
      </Link>
      <h1 className="text-2xl sm:text-3xl font-black text-white mt-4">Become a Developer</h1>
      <p className="text-rx-gray-medium mt-2 text-sm">
        Apply to publish on RX Store. Your application is reviewed by our team —
        approval is separate from publishing any app.
      </p>

      {appStatus && !['NOT_APPLIED', 'DRAFT'].includes(appStatus) && (
        <div className={`mt-6 p-4 rounded-xl border flex gap-3 items-start ${appStatus === 'CHANGES_REQUESTED' || appStatus === 'REJECTED' ? 'bg-amber-500/10 border-amber-500/20' : 'bg-rx-yellow/10 border-rx-yellow/20'}`}>
          <AlertCircle className="w-5 h-5 text-rx-yellow flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-white">Current status: {String(appStatus).replace('_', ' ')}</p>
            {reviewReason && <p className="text-rx-gray-medium mt-1">Reviewer note: {reviewReason}</p>}
            {!editable && <p className="text-rx-gray-medium mt-1">This application can no longer be edited. <Link to="/developers/status" className="text-rx-yellow hover:underline">View status</Link></p>}
          </div>
        </div>
      )}

      {!isApiConfigured() ? (
        <div className="card p-8 text-center mt-8">
          <AlertCircle className="w-8 h-8 text-rx-yellow mx-auto" />
          <h2 className="font-semibold text-white mt-3">Backend not connected</h2>
          <p className="text-sm text-rx-gray-medium mt-1">Developer applications need the RX Store backend. Install a correctly configured build.</p>
        </div>
      ) : loading ? (
        <div className="card p-8 mt-8 animate-pulse space-y-4">
          <div className="h-4 bg-white/5 rounded w-1/3" /><div className="h-10 bg-white/5 rounded" />
          <div className="h-4 bg-white/5 rounded w-1/4" /><div className="h-10 bg-white/5 rounded" />
        </div>
      ) : (
        <div className="card p-6 md:p-8 mt-8 space-y-5">
          <div className="grid sm:grid-cols-2 gap-5">
            <div>
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Publisher / developer name *</label>
              <input className={inputCls} value={form.publisherName} onChange={(e) => setForm({ ...form, publisherName: e.target.value })} placeholder="e.g. Calcitonin Technologies" />
            </div>
            <div>
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Developer type *</label>
              <select className={inputCls} value={form.developerType} onChange={(e) => setForm({ ...form, developerType: e.target.value })}>
                <option value="individual">Individual</option>
                <option value="organization">Organization</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Contact email *</label>
              <input type="email" className={inputCls} value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} placeholder="you@company.com" />
              <p className="text-[11px] text-rx-gray-medium/70 mt-1">Private — never shown on your public profile.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Support email *</label>
              <input type="email" className={inputCls} value={form.supportEmail} onChange={(e) => setForm({ ...form, supportEmail: e.target.value })} placeholder="support@company.com" />
            </div>
            <div>
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Website</label>
              <input className={inputCls} value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://…" />
            </div>
            <div>
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Country / region *</label>
              <input className={inputCls} value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="Ghana" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Developer category</label>
              <select className={inputCls} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                <option value="">Select a category…</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Description *</label>
              <textarea rows={4} className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Tell us about your team and what you build (20+ characters)" />
            </div>
          </div>

          <label className="flex items-start gap-3 cursor-pointer p-4 rounded-xl bg-rx-dark-tertiary/50 border border-white/10">
            <input type="checkbox" checked={form.acceptedTerms} onChange={(e) => setForm({ ...form, acceptedTerms: e.target.checked })} className="mt-1 w-4 h-4 rounded border-white/20 bg-rx-dark-tertiary text-rx-yellow" />
            <span className="text-sm text-rx-gray-medium">
              I accept the <Link to="/terms" className="text-rx-yellow hover:underline" target="_blank">RX Store Terms</Link> and
              <Link to="/privacy" className="text-rx-yellow hover:underline" target="_blank"> Privacy Policy</Link>, and confirm the
              information above is accurate. *
            </span>
          </label>

          <div className="flex flex-col sm:flex-row gap-3 sm:justify-end">
            <button onClick={saveDraft} disabled={saving || !editable} className="btn-secondary flex items-center justify-center gap-2 disabled:opacity-40">
              <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save draft'}
            </button>
            <button onClick={submit} disabled={submitting || !editable} className="btn-primary flex items-center justify-center gap-2 disabled:opacity-40">
              {submitting ? 'Submitting…' : <><Send className="w-4 h-4" /> Submit application</>}
            </button>
          </div>
          <p className="text-[11px] text-rx-gray-medium/70 flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> Required fields are validated again at submission — a draft can be incomplete.
          </p>
        </div>
      )}
    </div>
  );
}
