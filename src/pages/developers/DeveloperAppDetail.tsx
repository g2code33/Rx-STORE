/**
 * /developers/apps/:id — App Management (Phase 12 §2).
 * App metadata → submit for review → releases → packages → submit release.
 * Everything server-gated; this UI only reflects what the backend allows.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Plus, Upload, Send, X, AlertCircle, CheckCircle2, PauseCircle, ExternalLink, FileCheck, MessageSquare, ShieldAlert, ShieldCheck,
} from 'lucide-react';
import { api, isApiConfigured } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { formatDate } from '../../utils/helpers';
import AppLogo from '../../components/apps/AppLogo';
import toast from 'react-hot-toast';

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-white/5 text-rx-gray-medium', submitted: 'bg-rx-yellow/10 text-rx-yellow',
  under_review: 'bg-blue-400/10 text-blue-300', changes_requested: 'bg-amber-500/10 text-amber-300',
  approved: 'bg-green-400/10 text-green-400', rejected: 'bg-red-400/10 text-red-400',
  published: 'bg-green-400/10 text-green-400', withdrawn: 'bg-white/5 text-rx-gray-medium',
  active: 'bg-green-400/10 text-green-400', suspended: 'bg-amber-500/10 text-amber-300',
  pending: 'bg-white/5 text-rx-gray-medium', passed: 'bg-green-400/10 text-green-400',
  clean: 'bg-green-400/10 text-green-400', detected: 'bg-red-400/10 text-red-400',
  unavailable: 'bg-amber-500/10 text-amber-300', needs_review: 'bg-amber-500/10 text-amber-300',
  scanning: 'bg-blue-400/10 text-blue-300', not_applicable: 'bg-white/5 text-rx-gray-medium',
  quarantined: 'bg-white/5 text-rx-gray-medium', security_review_complete: 'bg-green-400/10 text-green-400',
  security_override: 'bg-amber-500/10 text-amber-300', structure_check: 'bg-blue-400/10 text-blue-300',
  integrity_check: 'bg-blue-400/10 text-blue-300', duplicate_check: 'bg-blue-400/10 text-blue-300',
  malware_scan: 'bg-blue-400/10 text-blue-300', signature_check: 'bg-blue-400/10 text-blue-300',
  certificate_check: 'bg-blue-400/10 text-blue-300', dependency_security_check: 'bg-blue-400/10 text-blue-300',
  native_identity_check: 'bg-blue-400/10 text-blue-300', warning: 'bg-amber-500/10 text-amber-300',
  signed: 'bg-green-400/10 text-green-400', unsigned: 'bg-amber-500/10 text-amber-300',
  failed: 'bg-red-400/10 text-red-400',
};

function Badge({ status }: { status: string }) {
  return <span className={`text-[10px] font-bold px-2 py-1 rounded whitespace-nowrap ${STATUS_BADGE[status] || STATUS_BADGE.draft}`}>{String(status).replace('_', ' ')}</span>;
}

function fmtSize(bytes: number) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const CATEGORIES = ['healthcare', 'education', 'productivity', 'technology', 'gaming', 'social'];
const PLATFORMS = ['web', 'windows', 'linux', 'android', 'ios'];
const PKG_PLATFORMS = [
  { id: 'windows', label: 'Windows (.exe / .msi)' },
  { id: 'linux_deb', label: 'Linux .deb' },
  { id: 'linux_appimage', label: 'Linux .AppImage' },
  { id: 'android', label: 'Android (.apk / .aab)' },
  { id: 'web', label: 'Web deployment URL' },
];
const ARCHS = ['x64', 'arm64', 'x86', 'arm', 'universal'];

export default function DeveloperAppDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showReleaseForm, setShowReleaseForm] = useState(false);
  const [openRelease, setOpenRelease] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!isApiConfigured()) { setLoading(false); setError('not-configured'); return; }
    return api.developers.apps.get(String(id)).then((d) => { setData(d); setError(''); })
      .catch((e: any) => setError(e?.message || 'Could not load the app'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!user) { navigate('/login'); return; }
    load();
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return null;

  const app = data?.app;
  const releases: any[] = data?.releases || [];
  const editableApp = ['draft', 'changes_requested'].includes(app?.status);
  const canCreateRelease = (data?.permissions || []).includes('release.create') && app?.status === 'active';

  const submitApp = async () => {
    try {
      await api.developers.apps.submit(app.id);
      toast.success('App submitted for review');
      setLoading(true); load();
    } catch (e: any) { toast.error(e?.message || 'Could not submit'); }
  };

  return (
    <div className="section-container max-w-5xl py-8 md:py-12">
      <Link to="/developers/apps" className="inline-flex items-center gap-1.5 text-sm text-rx-gray-medium hover:text-white transition-colors">
        <ArrowLeft className="w-4 h-4" /> My Apps
      </Link>

      {loading ? (
        <div className="card p-8 mt-6 animate-pulse space-y-4"><div className="h-6 bg-white/5 rounded w-1/3" /><div className="h-3 bg-white/5 rounded w-2/3" /></div>
      ) : error === 'not-configured' ? (
        <div className="card p-8 mt-6 text-center"><AlertCircle className="w-8 h-8 text-rx-yellow mx-auto" /><p className="text-sm text-rx-gray-medium mt-3">Backend not connected.</p></div>
      ) : error ? (
        <div className="card p-8 mt-6 text-center"><AlertCircle className="w-8 h-8 text-red-400 mx-auto" /><p className="text-sm text-rx-gray-medium mt-3">{error}</p></div>
      ) : app ? (
        <>
          {/* Header */}
          <div className="card p-5 md:p-6 mt-6">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <AppLogo app={app} size="w-16 h-16" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-xl sm:text-2xl font-black text-white truncate">{app.name}</h1>
                  <Badge status={app.status} />
                </div>
                <p className="text-xs text-rx-gray-medium mt-1">
                  {app.slug} · {app.category} · {(app.platforms || []).join(', ')} · created {formatDate(app.createdAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {editableApp && (
                  <button onClick={submitApp} className="btn-primary text-sm flex items-center gap-2"><Send className="w-4 h-4" /> Submit for review</button>
                )}
                {app.status === 'active' && (
                  <Link to={`/app/${app.slug}`} target="_blank" className="btn-secondary text-sm flex items-center gap-2"><ExternalLink className="w-4 h-4" /> View live</Link>
                )}
              </div>
            </div>
            {app.status === 'changes_requested' && (
              <p className="text-xs text-amber-300 mt-3">Admin requested changes — update the metadata below and resubmit.</p>
            )}
            {app.status === 'active' && data?.thread && (
              <Link to="/developers/messages" className="text-xs text-rx-yellow hover:underline mt-3 inline-flex items-center gap-1.5"><MessageSquare className="w-3.5 h-3.5" /> Admin communication for this app</Link>
            )}
          </div>

          {/* Metadata (editable in draft / changes requested) */}
          <MetadataEditor app={app} editable={editableApp} onSaved={load} />

          {/* Releases */}
          <div className="flex items-center justify-between mt-10">
            <div>
              <h2 className="text-lg font-bold text-white">Releases</h2>
              <p className="text-xs text-rx-gray-medium mt-0.5">Each version is its own release — approved releases become public when published by admin.</p>
            </div>
            {canCreateRelease && (
              <button onClick={() => setShowReleaseForm(true)} className="btn-primary text-sm flex items-center gap-2"><Plus className="w-4 h-4" /> New release</button>
            )}
          </div>

          {showReleaseForm && (
            <ReleaseForm appId={app.id} onDone={() => { setShowReleaseForm(false); load(); }} onCancel={() => setShowReleaseForm(false)} />
          )}

          <div className="mt-4 space-y-3">
            {releases.length === 0 ? (
              <div className="card p-8 text-center">
                <Upload className="w-8 h-8 text-rx-gray-medium/40 mx-auto" />
                <p className="text-sm text-rx-gray-medium mt-3">
                  {app.status === 'active' ? 'No releases yet — create the first release to ship an update.' : 'Releases unlock after the app is approved and listed.'}
                </p>
              </div>
            ) : releases.map((rel) => (
              <ReleaseCard
                key={rel.id} rel={rel} expanded={openRelease === rel.id}
                onToggle={() => setOpenRelease(openRelease === rel.id ? null : rel.id)}
                onChanged={load}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function MetadataEditor({ app, editable, onSaved }: { app: any; editable: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: app.name, description: app.description, longDescription: app.longDescription || '',
    category: app.category, icon: app.icon || '', website: app.website || '',
    tags: Array.isArray(app.tags) ? app.tags.join(', ') : String(app.tags || ''),
    platforms: Array.isArray(app.platforms) ? app.platforms : [],
  });

  const inputCls = 'w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 disabled:opacity-50';

  const save = async () => {
    setBusy(true);
    try {
      await api.developers.apps.update(app.id, {
        name: form.name, description: form.description, longDescription: form.longDescription,
        category: form.category, icon: form.icon, website: form.website,
        tags: form.tags.split(',').map((t: string) => t.trim()).filter(Boolean), platforms: form.platforms,
      });
      toast.success('Metadata saved');
      setEditing(false);
      onSaved();
    } catch (e: any) { toast.error(e?.message || 'Could not save'); }
    setBusy(false);
  };

  return (
    <div className="card p-5 md:p-6 mt-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-white text-sm">App metadata</h3>
        {editable && !editing && <button onClick={() => setEditing(true)} className="text-xs text-rx-yellow hover:underline">Edit</button>}
      </div>
      {!editing ? (
        <div className="grid sm:grid-cols-2 gap-3 mt-4 text-sm">
          <div className="sm:col-span-2"><p className="text-rx-gray-medium text-xs">Description</p><p className="text-white">{app.description || '—'}</p></div>
          <div><p className="text-rx-gray-medium text-xs">Category</p><p className="text-white">{app.category}</p></div>
          <div><p className="text-rx-gray-medium text-xs">Platforms</p><p className="text-white">{(app.platforms || []).join(', ') || '—'}</p></div>
          <div><p className="text-rx-gray-medium text-xs">Icon</p><p className="text-white break-all">{app.icon ? '✓ set' : '— (required before submission)'}</p></div>
          <div><p className="text-rx-gray-medium text-xs">Website</p><p className="text-white break-all">{app.website || '—'}</p></div>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4 mt-4">
          <div><label className="block text-xs text-rx-gray-medium mb-1.5">Name</label><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label className="block text-xs text-rx-gray-medium mb-1.5">Category</label>
            <select className={inputCls} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
          <div className="sm:col-span-2"><label className="block text-xs text-rx-gray-medium mb-1.5">Short description</label><input className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div className="sm:col-span-2"><label className="block text-xs text-rx-gray-medium mb-1.5">Full description</label><textarea rows={3} className={inputCls} value={form.longDescription} onChange={(e) => setForm({ ...form, longDescription: e.target.value })} /></div>
          <div><label className="block text-xs text-rx-gray-medium mb-1.5">Icon URL</label><input className={inputCls} value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} placeholder="https://…" /></div>
          <div><label className="block text-xs text-rx-gray-medium mb-1.5">Website</label><input className={inputCls} value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://…" /></div>
          <div className="sm:col-span-2"><label className="block text-xs text-rx-gray-medium mb-1.5">Tags (comma separated)</label><input className={inputCls} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} /></div>
          <div className="sm:col-span-2">
            <label className="block text-xs text-rx-gray-medium mb-1.5">Platforms</label>
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map((p) => (
                <button key={p} type="button" onClick={() => setForm((f) => ({ ...f, platforms: f.platforms.includes(p) ? f.platforms.filter((x: string) => x !== p) : [...f.platforms, p] }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${form.platforms.includes(p) ? 'bg-rx-yellow/10 text-rx-yellow border-rx-yellow/30' : 'text-rx-gray-medium border-white/10'}`}>{p}</button>
              ))}
            </div>
          </div>
          <div className="sm:col-span-2 flex gap-2 justify-end">
            <button onClick={() => setEditing(false)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={save} disabled={busy} className="btn-primary text-sm disabled:opacity-40">{busy ? 'Saving…' : 'Save metadata'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ReleaseForm({ appId, onDone, onCancel }: { appId: string; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({ version: '', buildNumber: '', releaseType: 'patch', channel: 'stable', releaseNotes: '', featureSummary: '', callToAction: '', minimumSupportedVersion: '' });
  const [busy, setBusy] = useState(false);
  const inputCls = 'w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50';

  const create = async () => {
    setBusy(true);
    try {
      await api.developers.apps.createRelease(appId, {
        version: form.version, buildNumber: form.buildNumber, releaseType: form.releaseType, channel: form.channel,
        releaseNotes: form.releaseNotes.split('\n').map((n) => n.trim()).filter(Boolean),
        featureSummary: form.featureSummary, callToAction: form.callToAction, minimumSupportedVersion: form.minimumSupportedVersion,
      });
      toast.success('Draft release created');
      onDone();
    } catch (e: any) { toast.error(e?.message || 'Could not create the release'); }
    setBusy(false);
  };

  return (
    <div className="card p-5 md:p-6 mt-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-white text-sm">New release</h3>
        <button onClick={onCancel} className="text-rx-gray-medium hover:text-white"><X className="w-4 h-4" /></button>
      </div>
      <div className="grid sm:grid-cols-2 gap-4 mt-4">
        <div><label className="block text-xs text-rx-gray-medium mb-1.5">Version * <span className="text-rx-gray-medium/60">(semver, immutable per app)</span></label>
          <input className={inputCls} value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} placeholder="1.2.0" /></div>
        <div><label className="block text-xs text-rx-gray-medium mb-1.5">Build number * <span className="text-rx-gray-medium/60">(required to submit)</span></label>
          <input className={inputCls} value={form.buildNumber} onChange={(e) => setForm({ ...form, buildNumber: e.target.value })} placeholder="42" /></div>
        <div><label className="block text-xs text-rx-gray-medium mb-1.5">Release type</label>
          <select className={inputCls} value={form.releaseType} onChange={(e) => setForm({ ...form, releaseType: e.target.value })}>
            <option value="patch">patch</option><option value="minor">minor</option><option value="major">major</option>
          </select></div>
        <div><label className="block text-xs text-rx-gray-medium mb-1.5">Channel</label>
          <select className={inputCls} value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
            <option value="stable">stable</option><option value="beta">beta</option>
          </select></div>
        <div className="sm:col-span-2"><label className="block text-xs text-rx-gray-medium mb-1.5">Release notes * <span className="text-rx-gray-medium/60">(one per line)</span></label>
          <textarea rows={3} className={inputCls} value={form.releaseNotes} onChange={(e) => setForm({ ...form, releaseNotes: e.target.value })} placeholder={'Fixed login bug\nImproved performance'} /></div>
        <div className="sm:col-span-2"><label className="block text-xs text-rx-gray-medium mb-1.5">Feature summary</label>
          <input className={inputCls} value={form.featureSummary} onChange={(e) => setForm({ ...form, featureSummary: e.target.value })} placeholder="What's the headline change?" /></div>
        <div><label className="block text-xs text-rx-gray-medium mb-1.5">Call to action</label>
          <input className={inputCls} value={form.callToAction} onChange={(e) => setForm({ ...form, callToAction: e.target.value })} placeholder="Update now" /></div>
        <div><label className="block text-xs text-rx-gray-medium mb-1.5">Minimum supported version</label>
          <input className={inputCls} value={form.minimumSupportedVersion} onChange={(e) => setForm({ ...form, minimumSupportedVersion: e.target.value })} placeholder="1.0.0" /></div>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
        <button onClick={create} disabled={busy || !form.version} className="btn-primary text-sm disabled:opacity-40">{busy ? 'Creating…' : 'Create draft release'}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ReleaseCard({ rel, expanded, onToggle, onChanged }: { rel: any; expanded: boolean; onToggle: () => void; onChanged: () => void }) {
  const canEdit = ['draft', 'changes_requested'].includes(rel.status);
  const notes: string[] = Array.isArray(rel.releaseNotes) ? rel.releaseNotes : [];

  return (
    <div className="card overflow-hidden">
      <button onClick={onToggle} className="w-full p-4 flex flex-wrap items-center gap-3 hover:bg-white/[0.03] text-left">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white">
            v{rel.version} {rel.buildNumber ? <span className="text-rx-gray-medium font-normal">· build {rel.buildNumber}</span> : null}
          </p>
          <p className="text-xs text-rx-gray-medium mt-0.5">
            created {formatDate(rel.createdAt)}
            {rel.submittedAt ? ` · submitted ${formatDate(rel.submittedAt)}` : ''}
            {rel.publishedAt ? ` · published ${formatDate(rel.publishedAt)}` : ''}
            {` · ${(rel.packages || []).length} package${(rel.packages || []).length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {rel.securityStatus && rel.securityStatus !== 'pending' && <Badge status={rel.securityStatus} />}
          <Badge status={rel.status} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/5 p-4 md:p-5 space-y-5">
          {rel.reviewReason && ['changes_requested', 'rejected'].includes(rel.status) && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm">
              <p className="font-semibold text-amber-200 text-xs uppercase tracking-wide">Reviewer note</p>
              <p className="text-rx-gray-medium mt-1">{rel.reviewReason}</p>
            </div>
          )}
          {notes.length > 0 && (
            <div><p className="text-xs text-rx-gray-medium uppercase tracking-wide mb-1.5">Release notes</p>
              <ul className="text-sm text-rx-gray-medium space-y-1">{notes.map((n, i) => <li key={i}>• {n}</li>)}</ul></div>
          )}

          <PackagesSection rel={rel} canEdit={canEdit} onChanged={onChanged} />

          <div className="flex flex-wrap gap-2 border-t border-white/5 pt-4">
            {canEdit && (
              <button
                onClick={async () => {
                  try { await api.developers.apps.submitRelease(rel.id); toast.success('Release submitted for review'); onChanged(); }
                  catch (e: any) { toast.error(e?.message || 'Could not submit'); }
                }}
                className="btn-primary text-sm flex items-center gap-2"
              ><FileCheck className="w-4 h-4" /> Submit release for review</button>
            )}
            {['draft', 'submitted', 'changes_requested'].includes(rel.status) && (
              <button
                onClick={async () => {
                  if (!confirm(`Withdraw release ${rel.version}? You can create a new release later.`)) return;
                  try { await api.developers.apps.withdrawRelease(rel.id); toast.success('Release withdrawn'); onChanged(); }
                  catch (e: any) { toast.error(e?.message || 'Could not withdraw'); }
                }}
                className="btn-secondary text-sm flex items-center gap-2"
              ><PauseCircle className="w-4 h-4" /> Withdraw</button>
            )}
            <Link to="/developers/messages" className="text-xs text-rx-yellow hover:underline self-center inline-flex items-center gap-1.5 ml-auto">
              <MessageSquare className="w-3.5 h-3.5" /> Communication
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const CHECK_LABELS: Record<string, string> = {
  structure: 'Package structure', integrity: 'Integrity (SHA-256)', duplicate: 'Duplicate check',
  malware: 'Malware scan', signature: 'Signature', certificate: 'Certificate',
  dependency: 'Dependency check', native_identity: 'Native identity',
};

/** Developer security view: actionable per-check status, honest wording. */
function PackageChecks({ checks }: { checks: any[] }) {
  if (!checks.length) {
    return <p className="text-[11px] text-rx-gray-medium/70 mt-1.5">Security verification has not run yet for this package.</p>;
  }
  return (
    <div className="mt-1.5 space-y-0.5">
      {checks.map((c) => {
        const ok = c.status === 'PASSED' || c.status === 'CLEAN';
        const bad = c.status === 'FAILED' || c.status === 'DETECTED';
        const warn = c.status === 'WARNING' || c.status === 'NEEDS_REVIEW' || c.status === 'UNAVAILABLE';
        const na = c.status === 'NOT_APPLICABLE';
        const Icon = bad ? ShieldAlert : ok ? ShieldCheck : warn ? AlertCircle : CheckCircle2;
        const color = bad ? 'text-red-400' : ok ? 'text-green-400' : warn ? 'text-amber-300' : 'text-rx-gray-medium';
        return (
          <div key={c.check_type} className="flex items-start gap-1.5 text-[11px]" title={c.details || c.result}>
            <Icon className={`w-3 h-3 mt-0.5 flex-shrink-0 ${color}`} />
            <span className="text-rx-gray-medium">
              <span className="text-white">{CHECK_LABELS[c.check_type] || c.check_type}:</span>{' '}
              {ok ? (c.check_type === 'malware' ? 'Automated security checks passed' : 'Passed') : na ? 'Not applicable' : `${String(c.status).replace('_', ' ').toLowerCase()} — ${c.result}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PackagesSection({ rel, canEdit, onChanged }: { rel: any; canEdit: boolean; onChanged: () => void }) {
  const [platform, setPlatform] = useState('windows');
  const [arch, setArch] = useState('x64');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const isUrlPlatform = platform === 'web';
  const inputCls = 'flex-1 min-w-0 bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50';

  const upload = async () => {
    if (!file) { toast.error('Choose a file first'); return; }
    setBusy(true); setProgress(0);
    try {
      await api.developers.apps.uploadPackage(rel.id, file, platform, arch, setProgress);
      toast.success('Package uploaded — awaiting verification');
      setFile(null); setProgress(null);
      onChanged();
    } catch (e: any) { toast.error(e?.message || 'Upload failed'); setProgress(null); }
    setBusy(false);
  };

  const saveUrl = async () => {
    if (!url.trim()) { toast.error('Enter the deployment URL'); return; }
    setBusy(true);
    try {
      await api.developers.apps.setDeploymentUrl(rel.id, url.trim(), 'web');
      toast.success('Deployment URL saved');
      setUrl('');
      onChanged();
    } catch (e: any) { toast.error(e?.message || 'Could not save'); }
    setBusy(false);
  };

  return (
    <div>
      <p className="text-xs text-rx-gray-medium uppercase tracking-wide mb-2">Packages</p>
      <div className="rounded-xl border border-white/5 divide-y divide-white/5">
        {(rel.packages || []).length === 0 ? (
          <p className="p-3 text-xs text-rx-gray-medium">No packages yet — at least one is required to submit.</p>
        ) : rel.packages.map((p: any) => (
          <div key={p.id} className="p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-white">{p.platform}{p.architecture && p.architecture !== 'universal' ? ` (${p.architecture})` : ''}</span>
              <span className="text-rx-gray-medium text-xs truncate flex-1 min-w-0">{p.deployment_url || p.filename}</span>
              <span className="text-xs text-rx-gray-medium">{fmtSize(Number(p.file_size) || 0)}</span>
              <Badge status={p.status} />
              {p.security_state && p.security_state !== 'PUBLISHED' && <Badge status={p.security_state} />}
              {p.overall_security && p.overall_security !== 'PENDING' && <Badge status={p.overall_security} />}
            </div>
            {p.deployment_url ? (
              <p className="text-[11px] text-rx-gray-medium/70 mt-1.5">URL deployment — no binary to verify (the HTTPS endpoint owns integrity).</p>
            ) : (
              <PackageChecks checks={p.checks || []} />
            )}
          </div>
        ))}
      </div>

      {canEdit && (
        <div className="mt-3 p-3 rounded-xl bg-rx-dark-tertiary/50 border border-white/5 space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <select className={`${inputCls} sm:w-56`} value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {PKG_PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {!isUrlPlatform && (
              <select className={`${inputCls} sm:w-32`} value={arch} onChange={(e) => setArch(e.target.value)}>
                {ARCHS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            )}
            {isUrlPlatform ? (
              <>
                <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-app.pages.dev" />
                <button onClick={saveUrl} disabled={busy} className="btn-primary text-sm px-4 disabled:opacity-40">{busy ? '…' : 'Save URL'}</button>
              </>
            ) : (
              <>
                <label className="flex-1 min-w-0 cursor-pointer flex items-center gap-2 bg-rx-dark border border-white/10 rounded-xl px-3 py-2.5 text-sm text-rx-gray-medium hover:text-white truncate">
                  <Upload className="w-4 h-4 flex-shrink-0" /> {file ? file.name : 'Choose file…'}
                  <input type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
                </label>
                <button onClick={upload} disabled={busy || !file} className="btn-primary text-sm px-4 disabled:opacity-40 flex items-center gap-2">
                  {busy ? `${progress ?? 0}%` : <><Upload className="w-4 h-4" /> Upload</>}
                </button>
              </>
            )}
          </div>
          {progress !== null && (
            <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div className="h-full bg-rx-yellow transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}
          <p className="text-[11px] text-rx-gray-medium/70">
            Size and SHA-256 are computed by the server from the uploaded file. Max 50 MB in this phase.
            Security verification happens automatically before publication (Phase 13).
          </p>
        </div>
      )}
    </div>
  );
}
