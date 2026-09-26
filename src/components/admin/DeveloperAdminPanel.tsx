/**
 * Admin → Developers panel (Phase 11 §8/§9).
 * Real application review workflow (approve / reject / request changes —
 * reasons REQUIRED for reject & changes), developer organizations with
 * suspend/reinstate, and the admin side of developer communications.
 * All actions hit server-enforced admin endpoints.
 */
import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Edit3, PauseCircle, PlayCircle, Eye, MessageSquare, Send, Shield, RefreshCw , UserCheck, ShieldCheck, Ban} from 'lucide-react';
import { api } from '../../services/api';
import { formatDate } from '../../utils/helpers';
import toast from 'react-hot-toast';
import SubmissionReviewWorkspace from './SubmissionReviewWorkspace';

type Tab = 'applications' | 'organizations' | 'apps' | 'releases' | 'submissions' | 'security' | 'communications';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-white/5 text-rx-gray-medium',
  SUBMITTED: 'bg-rx-yellow/10 text-rx-yellow',
  UNDER_REVIEW: 'bg-blue-400/10 text-blue-300',
  CHANGES_REQUESTED: 'bg-amber-500/10 text-amber-300',
  APPROVED: 'bg-green-400/10 text-green-400',
  REJECTED: 'bg-red-400/10 text-red-400',
  SUSPENDED: 'bg-amber-500/10 text-amber-300',
};

function StatusBadge({ status }: { status: string }) {
  return <span className={`text-[10px] font-bold px-2 py-1 rounded ${STATUS_COLORS[status] || STATUS_COLORS.DRAFT}`}>{String(status).replace('_', ' ')}</span>;
}

export default function DeveloperAdminPanel() {
  const [tab, setTab] = useState<Tab>('applications');
  const [applications, setApplications] = useState<any[]>([]);
  const [developers, setDevelopers] = useState<any[]>([]);
  const [threads, setThreads] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [detail, setDetail] = useState<any>(null); // application detail
  const [orgDetail, setOrgDetail] = useState<any>(null);
  const [thread, setThread] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [reply, setReply] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const [devApps, setDevApps] = useState<any[]>([]);
  const [devReleases, setDevReleases] = useState<any[]>([]);
  const [securityPackages, setSecurityPackages] = useState<any[]>([]);
  const [securityDetail, setSecurityDetail] = useState<any>(null);
  const [reviewQueue, setReviewQueue] = useState<any[]>([]);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [submissions, setSubmissions] = useState<any[]>([]);
  const [activeSubmission, setActiveSubmission] = useState<string | null>(null);
  const [appDetail, setAppDetail] = useState<any>(null);
  const [releaseDetail, setReleaseDetail] = useState<any>(null);
  const [releaseFilter, setReleaseFilter] = useState('');

  const load = () => {
    setLoading(true);
    Promise.all([
      api.developers.admin.applications().catch(() => ({ applications: [] })),
      api.developers.admin.developers().catch(() => ({ developers: [] })),
      api.developers.admin.threads().catch(() => ({ threads: [] })),
      api.developers.admin.devApps().catch(() => ({ apps: [] })),
      api.developers.admin.devReleases().catch(() => ({ releases: [] })),
      (api as any).developers.security.packages().catch(() => ({ packages: [] })),
      (api as any).developers.security.reviewQueue().catch(() => ({ queue: [] })),
      (api as any).adminSubmissions.list().catch(() => ({ submissions: [] })),
    ]).then(([a, d, t, da, dr, sp, sub, rq]) => {
      setApplications((a as any).applications || []);
      setDevelopers((d as any).developers || []);
      setThreads((t as any).threads || []);
      setDevApps((da as any).apps || []);
      setDevReleases((dr as any).releases || []);
      setSecurityPackages((sp as any).packages || []);
      setReviewQueue((rq as any)?.queue || []);
      setSubmissions((sub as any).submissions || []);
    }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const openDetail = async (id: string) => {
    setReason('');
    try {
      const d = await api.developers.admin.application(id);
      setDetail(d.application);
    } catch (e: any) { toast.error(e?.message || 'Could not load application'); }
  };

  const openThread = async (t: any) => {
    setThread(t); setMessages([]);
    try {
      const d = await api.developers.admin.thread(t.id);
      setThread(d.thread); setMessages(d.messages || []);
    } catch (e: any) { toast.error(e?.message || 'Could not open thread'); }
  };

  const openOrg = async (id: string) => {
    try {
      const d = await api.developers.admin.developer(id);
      setOrgDetail(d.developer);
    } catch (e: any) { toast.error(e?.message || 'Could not load organization'); }
  };

  const act = async (fn: () => Promise<any>, okMsg: string) => {
    setBusy(true);
    try { await fn(); toast.success(okMsg); setDetail(null); setOrgDetail(null); setReason(''); load(); }
    catch (e: any) { toast.error(e?.message || 'Action failed'); }
    setBusy(false);
  };

  const actRelease = async (id: string, action: 'review' | 'approve' | 'reject' | 'request-changes', reason?: string) => {
    setBusy(true);
    try {
      await api.developers.admin.devReleaseAction(id, action, reason);
      toast.success(`Release ${action === 'request-changes' ? 'changes requested' : action + 'd'}`);
      setReleaseDetail(null); setReason(''); load();
    } catch (e: any) { toast.error(e?.message || 'Action failed'); }
    setBusy(false);
  };

  const sendReply = async () => {
    if (!reply.trim() || !thread) return;
    setBusy(true);
    try { await api.developers.admin.sendMessage(thread.id, reply.trim()); setReply(''); openThread(thread); }
    catch (e: any) { toast.error(e?.message || 'Could not send'); }
    setBusy(false);
  };

  const filtered = filter ? applications.filter((a) => a.status === filter) : applications;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Developers</h2>
        <p className="text-sm text-rx-gray-medium mt-1">Review developer applications, manage organizations and communicate with developers.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-rx-dark-secondary rounded-xl p-1 w-fit">
        {([['applications', `Applications (${applications.length})`], ['apps', `Apps (${devApps.length})`], ['releases', `Releases (${devReleases.filter((r) => ['submitted', 'under_review', 'changes_requested'].includes(r.status)).length} in review)`], ['submissions', `Submissions (${submissions.filter((x) => ['SUBMITTED', 'SECURITY_REVIEW', 'ADMIN_REVIEW'].includes(x.status)).length} in review)`], ['security', `Security (${securityPackages.filter((p) => p.overall_security !== 'PASSED').length} blocked)`], ['organizations', `Organizations (${developers.length})`], ['communications', `Messages (${threads.filter((t) => Number(t.unread) > 0).length} new)`]] as [Tab, string][]).map(([id, label]) => (
          <button key={id} onClick={() => { setTab(id); setDetail(null); setOrgDetail(null); setThread(null); setAppDetail(null); setReleaseDetail(null); setSecurityDetail(null); setActiveSubmission(null); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === id ? 'bg-rx-yellow text-rx-dark' : 'text-rx-gray-medium hover:text-white'}`}>
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card p-8 animate-pulse space-y-3"><div className="h-4 bg-white/5 rounded w-1/3" /><div className="h-16 bg-white/5 rounded" /><div className="h-16 bg-white/5 rounded" /></div>
      ) : tab === 'applications' ? (
        detail ? (
          <div className="card p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-white">{detail.publisherName}</h3>
                <p className="text-sm text-rx-gray-medium mt-0.5">{detail.developerType} · applied {formatDate(detail.createdAt)} · applicant: {detail.applicant?.name} ({detail.applicant?.email})</p>
              </div>
              <div className="flex items-center gap-2"><StatusBadge status={detail.status} /><button onClick={() => setDetail(null)} className="text-xs text-rx-gray-medium hover:text-white">Close</button></div>
            </div>
            <div className="grid sm:grid-cols-2 gap-4 text-sm">
              <div><p className="text-rx-gray-medium">Contact email</p><p className="text-white">{detail.contactEmail || '—'}</p></div>
              <div><p className="text-rx-gray-medium">Support email</p><p className="text-white">{detail.supportEmail || '—'}</p></div>
              <div><p className="text-rx-gray-medium">Website</p><p className="text-white break-all">{detail.website || '—'}</p></div>
              <div><p className="text-rx-gray-medium">Country</p><p className="text-white">{detail.country || '—'}</p></div>
              <div className="sm:col-span-2"><p className="text-rx-gray-medium">Description</p><p className="text-white mt-1 leading-relaxed">{detail.description || '—'}</p></div>
              <div className="sm:col-span-2"><p className="text-rx-gray-medium">Terms accepted</p><p className={detail.acceptedTerms ? 'text-green-400' : 'text-amber-300'}>{detail.acceptedTerms ? `Yes (${formatDate(detail.termsAcceptedAt)})` : 'No'}</p></div>
            </div>

            {detail.reviewReason && <div className="p-3 rounded-xl bg-white/5 text-sm"><p className="text-rx-gray-medium">Previous review note: {detail.reviewReason}</p></div>}

            {/* Reason box for reject / changes */}
            {['SUBMITTED', 'UNDER_REVIEW'].includes(detail.status) && (
              <>
                {/* Manual security review — the controlled fallback */}
            {['UNAVAILABLE', 'SCANNING', 'UNKNOWN', 'NEEDS_REVIEW', 'FAILED', 'PENDING', 'pending'].includes(String(securityDetail.package.malwareStatus)) && (
              <div className="rounded-xl bg-blue-500/5 border border-blue-400/20 p-4 space-y-3">
                <p className="text-sm font-semibold text-white flex items-center gap-2"><UserCheck className="w-4 h-4 text-blue-300" /> Manual security review</p>
                {(securityDetail.manualReviews || []).length > 0 && (
                  <div className="space-y-2">
                    {(securityDetail.manualReviews || []).map((m: any) => (
                      <div key={m.id} className={`p-3 rounded-lg border text-xs ${m.status === 'APPROVED' ? 'bg-green-400/10 border-green-400/20' : m.status === 'REJECTED' ? 'bg-red-400/10 border-red-400/20' : m.invalidatedAt ? 'bg-white/5 border-white/10' : 'bg-amber-500/10 border-amber-500/20'}`}>
                        <p className="font-semibold text-white">
                          {m.status}{m.invalidatedAt ? ' (INVALIDATED — package bytes changed)' : ''}{!m.bindsCurrentBytes && !m.invalidatedAt ? ' (bound to older bytes)' : ''}
                          <span className="text-rx-gray-medium font-normal"> · {m.adminName || 'pending decision'} · {m.reviewedAt ? formatDate(m.reviewedAt) : `opened ${formatDate(m.openedAt)}`}</span>
                        </p>
                        <p className="text-rx-gray-medium mt-1">Reason: {m.reason}</p>
                        {m.adminNotes && <p className="text-rx-gray-medium">Notes: {m.adminNotes}</p>}
                      </div>
                    ))}
                  </div>
                )}
                {(() => {
                  const pending = (securityDetail.manualReviews || []).find((m: any) => m.status === 'PENDING' && !m.invalidatedAt && m.bindsCurrentBytes);
                  if (!pending) return <p className="text-xs text-rx-gray-medium">No pending review for the current bytes — re-run the security pipeline to open one when verification cannot conclude.</p>;
                  return (
                    <div className="space-y-2">
                      <textarea rows={2} value={reviewNotes[pending.id] || ''} onChange={(e) => setReviewNotes({ ...reviewNotes, [pending.id]: e.target.value })}
                        className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white"
                        placeholder="Review decision notes (REQUIRED, min 10 characters — what you checked and why this decision is safe)…" />
                      <div className="flex flex-wrap gap-2">
                        <button onClick={async () => {
                          try {
                            const res = await (api as any).developers.security.manualReview(securityDetail.package.id, 'APPROVE', reviewNotes[pending.id] || '');
                            toast.success(res.publicationAuthorization === 'MANUAL_APPROVAL' ? 'Manual review APPROVED — publication authorized for these exact bytes' : 'Approved');
                            setSecurityDetail(await (api as any).developers.security.package(securityDetail.package.id)); load();
                          } catch (e: any) { toast.error(e?.message || 'Approval failed'); }
                        }} disabled={busy || (reviewNotes[pending.id] || '').trim().length < 10}
                          className="text-sm flex items-center gap-2 px-4 py-2 rounded-xl bg-green-500/10 text-green-300 border border-green-500/20 hover:bg-green-500/20 disabled:opacity-40">
                          <ShieldCheck className="w-4 h-4" /> Approve (authorizes this SHA-256)
                        </button>
                        <button onClick={async () => {
                          try {
                            await (api as any).developers.security.manualReview(securityDetail.package.id, 'REJECT', reviewNotes[pending.id] || '');
                            toast.success('Manual review REJECTED — publication stays blocked');
                            setSecurityDetail(await (api as any).developers.security.package(securityDetail.package.id)); load();
                          } catch (e: any) { toast.error(e?.message || 'Rejection failed'); }
                        }} disabled={busy || (reviewNotes[pending.id] || '').trim().length < 10}
                          className="text-sm flex items-center gap-2 px-4 py-2 rounded-xl bg-red-500/10 text-red-300 border border-red-500/20 hover:bg-red-500/20 disabled:opacity-40">
                          <Ban className="w-4 h-4" /> Reject
                        </button>
                      </div>
                      <p className="text-[11px] text-rx-gray-medium">Approval authorizes publication for exactly the reviewed bytes (SHA-256 bound). Detected malware can never be approved. The automated verdict stays on record.</p>
                    </div>
                  );
                })()}
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t border-white/5 pt-4">
                  <button onClick={() => act(() => api.developers.admin.startReview(detail.id), 'Review started')} disabled={busy || detail.status !== 'SUBMITTED'}
                    className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-40"><Eye className="w-4 h-4" /> Start review</button>
                  <button onClick={() => act(() => api.developers.admin.approve(detail.id), 'Developer approved — organization created')} disabled={busy}
                    className="btn-primary text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Approve</button>
                </div>
                <div className="border-t border-white/5 pt-4">
                  <label className="block text-sm font-medium text-rx-gray-medium mb-2">Reason (required for reject / request changes — min 10 characters)</label>
                  <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" placeholder="Explain what needs to change or why this is rejected…" />
                  <div className="flex flex-wrap gap-2 mt-2">
                    <button onClick={() => act(() => api.developers.admin.requestChanges(detail.id, reason), 'Changes requested')} disabled={busy || reason.trim().length < 10}
                      className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-40"><Edit3 className="w-4 h-4" /> Request changes</button>
                    <button onClick={() => act(() => api.developers.admin.reject(detail.id, reason), 'Application rejected')} disabled={busy || reason.trim().length < 10}
                      className="text-sm flex items-center gap-2 px-4 py-2 rounded-xl bg-red-400/10 text-red-400 border border-red-400/20 hover:bg-red-400/20 disabled:opacity-40"><XCircle className="w-4 h-4" /> Reject</button>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="card">
            <div className="p-4 border-b border-white/5 flex flex-wrap gap-2 items-center">
              {['', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED'].map((s) => (
                <button key={s || 'all'} onClick={() => setFilter(s)} className={`text-xs px-3 py-1.5 rounded-lg ${filter === s ? 'bg-rx-yellow text-rx-dark font-bold' : 'bg-white/5 text-rx-gray-medium hover:text-white'}`}>
                  {s ? String(s).replace('_', ' ') : 'All'}
                </button>
              ))}
            </div>
            <div className="divide-y divide-white/5">
              {filtered.length === 0 ? (
                <p className="p-8 text-center text-sm text-rx-gray-medium">No applications{filter ? ` with status ${filter}` : ''}.</p>
              ) : filtered.map((a) => (
                <button key={a.id} onClick={() => openDetail(a.id)} className="w-full p-4 flex flex-wrap items-center gap-3 hover:bg-white/5 text-left">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{a.publisherName || '(unnamed draft)'}</p>
                    <p className="text-xs text-rx-gray-medium truncate">{a.applicant?.email || '—'} · {formatDate(a.submittedAt || a.createdAt)}</p>
                  </div>
                  <StatusBadge status={a.status} />
                </button>
              ))}
            </div>
          </div>
        )
      ) : tab === 'apps' ? (
        appDetail ? (
          <div className="card p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-white">{appDetail.app.name}</h3>
                <p className="text-sm text-rx-gray-medium mt-0.5">{appDetail.app.slug} · {appDetail.publisher?.publisher_name || appDetail.app.developerOrgId}</p>
              </div>
              <div className="flex items-center gap-2"><StatusBadge status={appDetail.app.status} /><button onClick={() => setAppDetail(null)} className="text-xs text-rx-gray-medium hover:text-white">Close</button></div>
            </div>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <div className="sm:col-span-2"><p className="text-rx-gray-medium">Description</p><p className="text-white">{appDetail.app.description}</p></div>
              <div><p className="text-rx-gray-medium">Category</p><p className="text-white">{appDetail.app.category}</p></div>
              <div><p className="text-rx-gray-medium">Platforms</p><p className="text-white">{(appDetail.app.platforms || []).join(', ')}</p></div>
              <div><p className="text-rx-gray-medium">Icon</p><p className="text-white break-all">{appDetail.app.icon || '—'}</p></div>
              <div><p className="text-rx-gray-medium">Website</p><p className="text-white break-all">{appDetail.app.website || '—'}</p></div>
            </div>
            {appDetail.releases?.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-white mb-2">Releases</p>
                <div className="space-y-1.5">
                  {appDetail.releases.map((r: any) => (
                    <div key={r.id} className="flex items-center justify-between text-sm p-2 rounded-lg bg-white/5">
                      <span className="text-white">v{r.version} {r.buildNumber ? `(build ${r.buildNumber})` : ''}</span>
                      <StatusBadge status={r.status} />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {['submitted', 'under_review', 'changes_requested'].includes(appDetail.app.status) && (
              <div className="flex flex-wrap gap-2 border-t border-white/5 pt-4">
                <button onClick={() => act(() => api.developers.admin.devAppAction(appDetail.app.id, 'approve'), 'App approved and listed')} disabled={busy}
                  className="btn-primary text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Approve & list</button>
                <button onClick={() => act(() => api.developers.admin.devAppAction(appDetail.app.id, 'request-changes', reason), 'Changes requested')} disabled={busy || reason.trim().length < 10}
                  className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-40"><Edit3 className="w-4 h-4" /> Request changes</button>
                <button onClick={() => act(() => api.developers.admin.devAppAction(appDetail.app.id, 'reject', reason), 'App rejected')} disabled={busy || reason.trim().length < 10}
                  className="text-sm flex items-center gap-2 px-4 py-2 rounded-xl bg-red-400/10 text-red-400 border border-red-400/20 hover:bg-red-400/20 disabled:opacity-40"><XCircle className="w-4 h-4" /> Reject</button>
              </div>
            )}
            {appDetail.app.status === 'active' && (
              <button onClick={() => act(() => api.developers.admin.devAppAction(appDetail.app.id, 'suspend'), 'App suspended (unlisted)')} disabled={busy}
                className="text-sm flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20"><PauseCircle className="w-4 h-4" /> Suspend (unlist)</button>
            )}
            {appDetail.app.status === 'suspended' && (
              <button onClick={() => act(() => api.developers.admin.devAppAction(appDetail.app.id, 'reinstate'), 'App reinstated')} disabled={busy}
                className="btn-primary text-sm flex items-center gap-2"><PlayCircle className="w-4 h-4" /> Reinstate</button>
            )}
            {['submitted', 'under_review'].includes(appDetail.app.status) && (
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" placeholder="Reason (required for reject / request changes — min 10 characters)…" />
            )}
          </div>
        ) : (
          <div className="card divide-y divide-white/5">
            {devApps.length === 0 ? (
              <p className="p-8 text-center text-sm text-rx-gray-medium">No developer apps yet.</p>
            ) : devApps.map((a) => (
              <button key={a.id} onClick={async () => { setReason(''); try { setAppDetail(await api.developers.admin.devApp(a.id)); } catch (e: any) { toast.error(e?.message || 'Could not load'); } }}
                className="w-full p-4 flex flex-wrap items-center gap-3 hover:bg-white/5 text-left">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{a.name}</p>
                  <p className="text-xs text-rx-gray-medium truncate">{a.publisherName || a.developerOrgId} · {a.slug}</p>
                </div>
                <StatusBadge status={a.status} />
              </button>
            ))}
          </div>
        )
      ) : tab === 'releases' ? (
        releaseDetail ? (
          <div className="card p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-white">{releaseDetail.app?.name} <span className="text-rx-yellow">v{releaseDetail.release?.version}</span></h3>
                <p className="text-sm text-rx-gray-medium mt-0.5">
                  build {releaseDetail.release?.buildNumber || '—'} · {releaseDetail.release?.publisherName || releaseDetail.release?.developerId}
                  {releaseDetail.release?.previousVersion ? ` · previous published: v${releaseDetail.release.previousVersion}` : ' · first release'}
                </p>
              </div>
              <div className="flex items-center gap-2"><StatusBadge status={releaseDetail.release?.status} /><button onClick={() => setReleaseDetail(null)} className="text-xs text-rx-gray-medium hover:text-white">Close</button></div>
            </div>
            {(releaseDetail.release?.featureSummary || releaseDetail.release?.reviewReason) && (
              <div className="text-sm space-y-1">
                {releaseDetail.release?.featureSummary && <p className="text-white">{releaseDetail.release.featureSummary}</p>}
                {releaseDetail.release?.reviewReason && <p className="text-amber-300">Previous note: {releaseDetail.release.reviewReason}</p>}
              </div>
            )}
            <div>
              <p className="text-sm font-semibold text-white mb-2">Packages</p>
              <div className="rounded-xl border border-white/5 divide-y divide-white/5">
                {releaseDetail.packages?.length === 0 && <p className="p-3 text-xs text-rx-gray-medium">No packages.</p>}
                {releaseDetail.packages?.map((p: any) => (
                  <div key={p.id} className="p-3 flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-white">{p.platform}{p.architecture !== 'universal' ? ` (${p.architecture})` : ''}</span>
                    <span className="text-rx-gray-medium text-xs truncate flex-1 min-w-0">{p.deployment_url || p.filename}</span>
                    <span className="text-xs text-rx-gray-medium">{p.file_size ? `${(p.file_size / 1024 / 1024).toFixed(1)} MB` : 'URL'}</span>
                    <span className="text-[10px] text-rx-gray-medium/70 font-mono" title="SHA-256 (server-computed)">{String(p.sha256 || '').slice(0, 10)}…</span>
                    <StatusBadge status={p.status} />
                    <span className="text-[10px] text-rx-gray-medium/70">scan: {p.security_scan_status || 'pending'}</span>
                  </div>
                ))}
              </div>
            </div>
            {['submitted', 'under_review', 'changes_requested'].includes(releaseDetail.release?.status) && (
              <>
                <div className="flex flex-wrap gap-2 border-t border-white/5 pt-4">
                  {releaseDetail.release?.status === 'submitted' && (
                    <button onClick={() => actRelease(releaseDetail.release.id, 'review')} disabled={busy}
                      className="btn-secondary text-sm flex items-center gap-2"><Eye className="w-4 h-4" /> Start review</button>
                  )}
                  <button onClick={() => actRelease(releaseDetail.release.id, 'approve')} disabled={busy}
                    className="btn-primary text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Approve</button>
                  <button onClick={() => actRelease(releaseDetail.release.id, 'request-changes', reason)} disabled={busy || reason.trim().length < 10}
                    className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-40"><Edit3 className="w-4 h-4" /> Request changes</button>
                  <button onClick={() => actRelease(releaseDetail.release.id, 'reject', reason)} disabled={busy || reason.trim().length < 10}
                    className="text-sm flex items-center gap-2 px-4 py-2 rounded-xl bg-red-400/10 text-red-400 border border-red-400/20 hover:bg-red-400/20 disabled:opacity-40"><XCircle className="w-4 h-4" /> Reject</button>
                </div>
                <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" placeholder="Reason (required for reject / request changes — min 10 characters)…" />
                <p className="text-[11px] text-rx-gray-medium/70">Approval is separate from publication — publish approved releases from the Releases section (existing flow). Phase 13 adds the security-verification gate.</p>
              </>
            )}
            {releaseDetail.release?.status === 'approved' && (
              <p className="text-xs text-green-400">Approved — publish it from the Releases section to make it live.</p>
            )}
          </div>
        ) : (
          <div className="card">
            <div className="p-4 border-b border-white/5 flex flex-wrap gap-2 items-center">
              {['', 'submitted', 'under_review', 'changes_requested', 'approved', 'rejected', 'published'].map((st) => (
                <button key={st || 'all'} onClick={() => setReleaseFilter(st)} className={`text-xs px-3 py-1.5 rounded-lg ${releaseFilter === st ? 'bg-rx-yellow text-rx-dark font-bold' : 'bg-white/5 text-rx-gray-medium hover:text-white'}`}>
                  {st ? String(st).replace('_', ' ') : 'All'}
                </button>
              ))}
            </div>
            <div className="divide-y divide-white/5">
              {(releaseFilter ? devReleases.filter((r) => r.status === releaseFilter) : devReleases).length === 0 ? (
                <p className="p-8 text-center text-sm text-rx-gray-medium">No developer releases{releaseFilter ? ` with status ${releaseFilter}` : ''}.</p>
              ) : (releaseFilter ? devReleases.filter((r) => r.status === releaseFilter) : devReleases).map((r) => (
                <button key={r.id} onClick={async () => { setReason(''); try { setReleaseDetail(await api.developers.admin.devRelease(r.id)); } catch (e: any) { toast.error(e?.message || 'Could not load'); } }}
                  className="w-full p-4 flex flex-wrap items-center gap-3 hover:bg-white/5 text-left">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{r.appName} <span className="text-rx-yellow">v{r.version}</span> <span className="text-rx-gray-medium font-normal">build {r.buildNumber || '—'}</span></p>
                    <p className="text-xs text-rx-gray-medium truncate">{r.publisherName || r.developerId} · {r.packageCount} package{r.packageCount === 1 ? '' : 's'} · {formatDate(r.submittedAt || r.createdAt)}</p>
                  </div>
                  <StatusBadge status={r.status} />
                </button>
              ))}
            </div>
          </div>
        )
      ) : tab === 'organizations' ? (
        orgDetail ? (
          <div className="card p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-white">{orgDetail.profile?.publisher_name || orgDetail.id}</h3>
                <p className="text-sm text-rx-gray-medium">{orgDetail.id} · since {formatDate(orgDetail.createdAt)}</p>
              </div>
              <div className="flex items-center gap-2"><StatusBadge status={orgDetail.status} /><button onClick={() => setOrgDetail(null)} className="text-xs text-rx-gray-medium hover:text-white">Close</button></div>
            </div>
            <div>
              <p className="text-sm font-semibold text-white mb-2">Members</p>
              <div className="space-y-2">
                {orgDetail.members?.map((m: any) => (
                  <div key={m.user_id} className="flex items-center justify-between text-sm p-2 rounded-lg bg-white/5">
                    <span className="text-white truncate">{m.name} <span className="text-rx-gray-medium">({m.email})</span></span>
                    <span className="text-[10px] font-bold text-rx-yellow">{m.role}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-sm font-semibold text-white mb-2">Audit history</p>
              <div className="max-h-48 overflow-y-auto space-y-1.5">
                {orgDetail.audit?.length === 0 && <p className="text-xs text-rx-gray-medium">No events.</p>}
                {orgDetail.audit?.map((e: any, i: number) => (
                  <div key={i} className="text-xs text-rx-gray-medium flex gap-2"><span className="text-rx-yellow whitespace-nowrap">{formatDate(e.created_at)}</span><span>{e.action}</span></div>
                ))}
              </div>
            </div>
            {orgDetail.status === 'ACTIVE' ? (
              <div className="border-t border-white/5 pt-4">
                <label className="block text-sm font-medium text-rx-gray-medium mb-2">Suspension reason (required)</label>
                <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" placeholder="Why is this developer being suspended?" />
                <button onClick={() => act(() => api.developers.admin.suspend(orgDetail.id, reason), 'Developer suspended')} disabled={busy || reason.trim().length < 10}
                  className="mt-2 text-sm flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20 disabled:opacity-40">
                  <PauseCircle className="w-4 h-4" /> Suspend developer
                </button>
              </div>
            ) : (
              <button onClick={() => act(() => api.developers.admin.reinstate(orgDetail.id), 'Developer reinstated')} disabled={busy}
                className="btn-primary text-sm flex items-center gap-2"><PlayCircle className="w-4 h-4" /> Reinstate developer</button>
            )}
          </div>
        ) : (
          <div className="card divide-y divide-white/5">
            {developers.length === 0 ? (
              <p className="p-8 text-center text-sm text-rx-gray-medium">No developer organizations yet — approve an application first.</p>
            ) : developers.map((d) => (
              <button key={d.id} onClick={() => openOrg(d.id)} className="w-full p-4 flex flex-wrap items-center gap-3 hover:bg-white/5 text-left">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{d.publisher_name || d.id}</p>
                  <p className="text-xs text-rx-gray-medium">{d.id} · {d.member_count} member{d.member_count === 1 ? '' : 's'} · {d.app_count} app{d.app_count === 1 ? '' : 's'}</p>
                </div>
                <StatusBadge status={d.status} />
              </button>
            ))}
          </div>
        )
      ) : tab === 'submissions' ? (
        activeSubmission ? (
          <SubmissionReviewWorkspace submissionId={activeSubmission} onClose={() => { setActiveSubmission(null); load(); }} onChanged={load} />
        ) : (
          <div className="card">
            <div className="p-4 border-b border-white/5 flex flex-wrap gap-2 items-center">
              {['', 'SUBMITTED', 'SECURITY_REVIEW', 'ADMIN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED'].map((st) => (
                <button key={st || 'all'} onClick={() => setFilter(st)} className={`text-xs px-3 py-1.5 rounded-lg ${filter === st ? 'bg-rx-yellow text-rx-dark font-bold' : 'bg-white/5 text-rx-gray-medium hover:text-white'}`}>
                  {st ? String(st).replace(/_/g, ' ') : 'All'}
                </button>
              ))}
            </div>
            <div className="divide-y divide-white/5">
              {(filter ? submissions.filter((x) => x.status === filter) : submissions).length === 0 ? (
                <p className="p-8 text-center text-sm text-rx-gray-medium">No submissions{filter ? ` with status ${filter}` : ''}.</p>
              ) : (filter ? submissions.filter((x) => x.status === filter) : submissions).map((x) => (
                <button key={x.id} onClick={() => setActiveSubmission(x.id)} className="w-full p-4 flex flex-wrap items-center gap-3 hover:bg-white/5 text-left">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{x.appName} <span className="text-rx-yellow">v{x.version}</span> <span className="text-rx-gray-medium font-normal">build {x.buildNumber || '—'}</span></p>
                    <p className="text-xs text-rx-gray-medium truncate">
                      {x.publisherName || x.developerId} · {x.packageCount} package{x.packageCount === 1 ? '' : 's'} · submitted {formatDate(x.submittedAt)}
                      {x.reviewerName ? ` · reviewer: ${x.reviewerName}` : ''}
                    </p>
                  </div>
                  <StatusBadge status={x.status} />
                </button>
              ))}
            </div>
          </div>
        )
      ) : tab === 'security' ? (
        securityDetail ? (
          <div className="card p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-white break-all">{securityDetail.package.filename}</h3>
                <p className="text-sm text-rx-gray-medium mt-0.5">
                  {securityDetail.package.app?.name} · v{securityDetail.package.release?.version} · {securityDetail.package.platform}
                  {securityDetail.package.architecture !== 'universal' ? ` (${securityDetail.package.architecture})` : ''} · {(securityDetail.package.sizeBytes / 1024 / 1024).toFixed(1)} MB
                </p>
                <p className="text-xs text-rx-gray-medium mt-1 font-mono break-all">{securityDetail.package.sha256}</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <StatusBadge status={securityDetail.package.securityState} />
                <button onClick={() => setSecurityDetail(null)} className="text-xs text-rx-gray-medium hover:text-white">Close</button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              {[
                ['Malware', securityDetail.package.malwareStatus],
                ['Signature', securityDetail.package.signatureStatus],
                ['Overall', securityDetail.package.overallSecurity],
                ['State', securityDetail.package.securityState],
                ['Public', securityDetail.package.publiclyServed ? 'SERVED' : 'PRIVATE'],
                ['Overrides', String(securityDetail.overrides.length)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-rx-dark-tertiary border border-white/5 p-3 text-center">
                  <p className="text-[10px] uppercase tracking-wide text-rx-gray-medium">{label}</p>
                  <p className="text-xs font-bold text-white mt-1 truncate" title={String(value)}>{String(value).replace('_', ' ')}</p>
                </div>
              ))}
            </div>

            <div>
              <p className="text-sm font-semibold text-white mb-2">Checks</p>
              <div className="space-y-2">
                {securityDetail.checks.length === 0 && <p className="text-xs text-rx-gray-medium">No checks recorded yet.</p>}
                {securityDetail.checks.map((c: any) => (
                  <div key={c.check_type} className="p-3 rounded-xl bg-rx-dark-tertiary/60 border border-white/5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusBadge status={c.status} />
                      <span className="text-sm font-medium text-white">{String(c.check_type).replace('_', ' ')}</span>
                      {c.provider && <span className="text-[10px] text-rx-gray-medium">via {c.provider}{c.provider_version ? ` ${c.provider_version}` : ''}</span>}
                      {c.fingerprint && <span className="text-[10px] font-mono text-rx-gray-medium">cert {String(c.fingerprint).slice(0, 12)}…</span>}
                    </div>
                    <p className="text-xs text-rx-gray-medium mt-1.5">{c.result}{c.details ? ` — ${c.details}` : ''}</p>
                  </div>
                ))}
              </div>
            </div>

            {securityDetail.overrides.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-white mb-2">Overrides (audited)</p>
                {securityDetail.overrides.map((o: any) => (
                  <div key={o.id} className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm">
                    <p className="text-amber-200 text-xs">{o.admin_name || o.admin_user_id} · {formatDate(o.created_at)} · prior: {String(o.prior_state).replace('_', ' ')} / {String(o.prior_overall)}</p>
                    <p className="text-rx-gray-medium mt-1">{o.reason}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t border-white/5 pt-4">
              <button onClick={async () => { try { await (api as any).developers.security.rescan(securityDetail.package.id); toast.success('Rescan complete'); setSecurityDetail(await (api as any).developers.security.package(securityDetail.package.id)); load(); } catch (e: any) { toast.error(e?.message || 'Rescan failed'); } }} disabled={busy}
                className="btn-secondary text-sm flex items-center gap-2"><RefreshCw className="w-4 h-4" /> Re-run security pipeline</button>
              {securityDetail.package.overallSecurity !== 'PASSED' && (
                <div className="flex-1 min-w-[260px] space-y-2">
                  <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" placeholder="Override reason (REQUIRED, min 10 characters — this is an audited decision)…" />
                  <button onClick={async () => {
                    try {
                      await (api as any).developers.security.override(securityDetail.package.id, reason);
                      toast.success('Security override recorded');
                      setSecurityDetail(await (api as any).developers.security.package(securityDetail.package.id));
                      setReason(''); load();
                    } catch (e: any) { toast.error(e?.message || 'Override failed'); }
                  }} disabled={busy || reason.trim().length < 10}
                    className="text-sm flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20 disabled:opacity-40">
                    <Shield className="w-4 h-4" /> Override security blocker
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
          {reviewQueue.filter((q) => q.manualReview?.status === 'PENDING' && q.manualReviewEligible).length > 0 && (
            <div className="card p-5 border-blue-400/20">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-blue-300" /> Manual review queue ({reviewQueue.filter((q) => q.manualReview?.status === 'PENDING' && q.manualReviewEligible).length})
              </h3>
              <p className="text-xs text-rx-gray-medium mt-1 mb-3">Automated verification could not produce a definitive verdict for these packages. Open a package below to approve or reject with audited notes — approvals authorize exactly the reviewed SHA-256.</p>
              <div className="space-y-2">
                {reviewQueue.filter((q) => q.manualReview?.status === 'PENDING' && q.manualReviewEligible).map((q) => (
                  <div key={q.packageId} className="p-3 rounded-xl bg-rx-dark-tertiary/60 border border-white/5 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-white truncate flex-1 min-w-40">{q.app?.name} v{q.release?.version} — {q.filename}</span>
                      <span className="text-[10px] font-bold px-2 py-1 rounded bg-blue-400/10 text-blue-300">{String(q.automated.malwareStatus).toUpperCase()}</span>
                      <span className="text-[10px] font-bold px-2 py-1 rounded bg-white/5 text-rx-gray-medium">{(q.sizeBytes / 1024 / 1024).toFixed(1)} MB · {q.platform}</span>
                    </div>
                    <p className="text-xs text-rx-gray-medium">{q.manualReview.reason}</p>
                    <p className="text-[10px] font-mono text-rx-gray-medium/70 break-all">{q.sha256}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="card divide-y divide-white/5">
            {securityPackages.length === 0 ? (
              <p className="p-8 text-center text-sm text-rx-gray-medium">No binary packages yet — uploads appear here with their security state.</p>
            ) : securityPackages.map((p) => (
              <button key={p.id} onClick={async () => { setReason(''); try { setSecurityDetail(await (api as any).developers.security.package(p.id)); } catch (e: any) { toast.error(e?.message || 'Could not load'); } }}
                className="w-full p-4 flex flex-wrap items-center gap-3 hover:bg-white/5 text-left">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{p.filename}</p>
                  <p className="text-xs text-rx-gray-medium truncate">
                    {p.app_name} · v{p.version || '—'} · {p.platform}{p.architecture && p.architecture !== 'universal' ? `/${p.architecture}` : ''} · {(Number(p.file_size) / 1024 / 1024).toFixed(1)} MB
                    {p.publisher_name ? ` · ${p.publisher_name}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {p.overridden && <span className="text-[10px] font-bold px-2 py-1 rounded bg-amber-500/10 text-amber-300">OVERRIDDEN</span>}
                  <StatusBadge status={String(p.security_scan_status || 'pending')} />
                  <StatusBadge status={String(p.overall_security || 'PENDING')} />
                </div>
              </button>
            ))}
          </div>
          </div>
        )
      ) : (
        /* Communications */
        <div className="grid lg:grid-cols-[300px,1fr] gap-4">
          <div className="card divide-y divide-white/5 max-h-[480px] overflow-y-auto">
            {threads.length === 0 ? (
              <p className="p-6 text-center text-sm text-rx-gray-medium">No developer threads yet.</p>
            ) : threads.map((t) => (
              <button key={t.id} onClick={() => openThread(t)} className={`w-full p-4 text-left hover:bg-white/5 ${thread?.id === t.id ? 'bg-rx-yellow/5' : ''}`}>
                <p className="text-sm text-white truncate">{t.subject}</p>
                <p className="text-[11px] text-rx-gray-medium mt-0.5">{t.publisher_name || t.developer_id} · {t.status?.replace('_', ' ')} · {formatDate(t.updated_at)}</p>
                {Number(t.unread) > 0 && <span className="inline-block mt-1 text-[10px] bg-rx-yellow/15 text-rx-yellow px-1.5 py-0.5 rounded">{t.unread} new</span>}
              </button>
            ))}
          </div>
          <div className="card p-5 flex flex-col min-h-[320px]">
            {!thread ? (
              <div className="m-auto text-center">
                <MessageSquare className="w-10 h-10 text-rx-gray-medium/40 mx-auto" />
                <p className="text-sm text-rx-gray-medium mt-3">Select a thread to read and reply.</p>
              </div>
            ) : (
              <>
                <div className="border-b border-white/5 pb-3">
                  <h3 className="font-semibold text-white text-sm">{thread.subject}</h3>
                  <p className="text-[11px] text-rx-gray-medium">{thread.publisher_name || thread.developer_id} · {thread.status?.replace('_', ' ')}</p>
                </div>
                <div className="flex-1 space-y-3 py-4 overflow-y-auto max-h-80">
                  {messages.map((m) => (
                    <div key={m.id} className={`max-w-[85%] rounded-xl p-3 text-sm ${m.sender_context === 'ADMIN' ? 'bg-rx-yellow/10 text-white ml-auto' : 'bg-rx-dark-tertiary text-rx-gray-medium'}`}>
                      <p className="text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: m.sender_context === 'ADMIN' ? '#FFD600' : undefined }}>
                        {m.sender_context === 'ADMIN' ? 'RX Store (you)' : 'Developer'}
                      </p>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                      <p className="text-[10px] text-rx-gray-medium/60 mt-1">{formatDate(m.created_at)}</p>
                    </div>
                  ))}
                  {messages.length === 0 && <p className="text-xs text-rx-gray-medium">No messages.</p>}
                </div>
                {thread.status !== 'CLOSED' && (
                  <div className="flex gap-2 border-t border-white/5 pt-3">
                    <input className="flex-1 bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" placeholder="Reply to the developer…" value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendReply()} />
                    <button onClick={sendReply} disabled={busy} className="btn-primary text-sm px-4 disabled:opacity-40"><Send className="w-4 h-4" /></button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
