/**
 * Admin Submission Review Workspace (Phase 14 §2).
 * One screen with the complete review context: developer, app, release,
 * packages + security results, previous versions, review history and the
 * developer communication thread — plus the review actions
 * (Assign / Start / Approve / Reject / Request Changes / Suspend / Resume).
 * Reject + Request Changes REQUIRE reasons; Request Changes requires concrete
 * action items (the backend enforces both).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Edit3, PauseCircle, PlayCircle, UserCheck, Eye, Send, Paperclip, ExternalLink } from 'lucide-react';
import { api } from '../../services/api';
import { formatDate } from '../../utils/helpers';
import toast from 'react-hot-toast';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-white/5 text-rx-gray-medium', SUBMITTED: 'bg-rx-yellow/10 text-rx-yellow',
  SECURITY_REVIEW: 'bg-blue-400/10 text-blue-300', ADMIN_REVIEW: 'bg-blue-400/10 text-blue-300',
  REVIEW_SUSPENDED: 'bg-amber-500/10 text-amber-300', CHANGES_REQUESTED: 'bg-amber-500/10 text-amber-300',
  APPROVED: 'bg-green-400/10 text-green-400', REJECTED: 'bg-red-400/10 text-red-400',
  WITHDRAWN: 'bg-white/5 text-rx-gray-medium', PUBLISHED: 'bg-green-400/10 text-green-400',
  PASSED: 'bg-green-400/10 text-green-400', CLEAN: 'bg-green-400/10 text-green-400',
  FAILED: 'bg-red-400/10 text-red-400', DETECTED: 'bg-red-400/10 text-red-400',
  WARNING: 'bg-amber-500/10 text-amber-300', NEEDS_REVIEW: 'bg-amber-500/10 text-amber-300',
  UNAVAILABLE: 'bg-amber-500/10 text-amber-300', NOT_APPLICABLE: 'bg-white/5 text-rx-gray-medium',
  PENDING: 'bg-white/5 text-rx-gray-medium', QUARANTINED: 'bg-white/5 text-rx-gray-medium',
};

function Badge({ status }: { status: string }) {
  return <span className={`text-[10px] font-bold px-2 py-1 rounded whitespace-nowrap ${STATUS_COLORS[status] || STATUS_COLORS.DRAFT}`}>{String(status).replace(/_/g, ' ')}</span>;
}

export default function SubmissionReviewWorkspace({ submissionId, onClose, onChanged }: { submissionId: string; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [actionItems, setActionItems] = useState<string[]>(['']);
  const [reply, setReply] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return api.adminSubmissions.get(submissionId).then((d: any) => setData(d)).catch((e: any) => toast.error(e?.message || 'Could not load submission'));
  }, [submissionId]);

  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); }, [load]);

  const act = async (action: string, body: Record<string, unknown> = {}, okMsg: string) => {
    setBusy(true);
    try {
      await api.adminSubmissions.action(submissionId, action as any, body);
      toast.success(okMsg);
      setReason(''); setActionItems(['']);
      await load();
      onChanged();
    } catch (e: any) { toast.error(e?.message || 'Action failed'); }
    setBusy(false);
  };

  const sendMessage = async () => {
    const message = reply.trim();
    if (!message && !file) { toast.error('Write a message or attach a file'); return; }
    setBusy(true);
    try {
      if (file) {
        await api.adminSubmissions.uploadAttachment(data.thread.id, file, message || undefined);
        setFile(null);
      } else {
        await api.developers.admin.sendMessage(data.thread.id, message);
      }
      setReply('');
      await load();
    } catch (e: any) { toast.error(e?.message || 'Could not send'); }
    setBusy(false);
  };

  if (loading && !data) return <div className="card p-8 animate-pulse space-y-3"><div className="h-5 bg-white/5 rounded w-1/3" /><div className="h-20 bg-white/5 rounded" /></div>;
  if (!data) return <div className="card p-8 text-center text-sm text-rx-gray-medium">Submission not found.</div>;

  const s = data.submission;
  const active = ['SUBMITTED', 'SECURITY_REVIEW', 'ADMIN_REVIEW', 'CHANGES_REQUESTED', 'REVIEW_SUSPENDED'].includes(s.status);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="card p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-lg font-bold text-white">{data.app?.name} <span className="text-rx-yellow">v{data.release?.version}</span></h3>
              <Badge status={s.status} />
            </div>
            <p className="text-sm text-rx-gray-medium mt-1">
              {data.developer?.publisherName || s.developerId} · build {data.release?.buildNumber || '—'} · submitted {formatDate(s.submittedAt)}
              {s.reviewerName ? ` · reviewer: ${s.reviewerName}` : ' · unassigned'}
            </p>
          </div>
          <button onClick={onClose} className="text-xs text-rx-gray-medium hover:text-white">Close</button>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2 mt-5">
          {['SUBMITTED', 'SECURITY_REVIEW', 'ADMIN_REVIEW'].includes(s.status) && (
            <button onClick={() => act('review', {}, 'Review started')} disabled={busy} className="btn-secondary text-sm flex items-center gap-2"><Eye className="w-4 h-4" /> Start review</button>
          )}
          {active && (
            <button onClick={() => act('assign', {}, 'Assigned to you')} disabled={busy || s.reviewerId} className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-40"><UserCheck className="w-4 h-4" /> {s.reviewerId ? 'Assigned' : 'Assign to me'}</button>
          )}
          {['SECURITY_REVIEW', 'ADMIN_REVIEW', 'CHANGES_REQUESTED'].includes(s.status) && (
            <button onClick={() => act('approve', { notes }, 'Submission approved')} disabled={busy} className="btn-primary text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Approve</button>
          )}
          {s.status === 'ADMIN_REVIEW' && (
            <button onClick={() => act('suspend', { reason }, 'Review suspended')} disabled={busy} className="btn-secondary text-sm flex items-center gap-2"><PauseCircle className="w-4 h-4" /> Suspend review</button>
          )}
          {s.status === 'REVIEW_SUSPENDED' && (
            <button onClick={() => act('resume', {}, 'Review resumed')} disabled={busy} className="btn-primary text-sm flex items-center gap-2"><PlayCircle className="w-4 h-4" /> Resume review</button>
          )}
          {data.app?.slug && <a href={`/app/${data.app.slug}`} target="_blank" rel="noreferrer" className="btn-secondary text-sm flex items-center gap-2"><ExternalLink className="w-4 h-4" /> Public page</a>}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* App + release context */}
        <div className="card p-5 space-y-4">
          <h4 className="font-semibold text-white text-sm">App & release</h4>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><p className="text-rx-gray-medium text-xs">Category</p><p className="text-white">{data.app?.category}</p></div>
            <div><p className="text-rx-gray-medium text-xs">Platforms</p><p className="text-white">{(data.app?.platforms || []).join(', ')}</p></div>
            <div className="col-span-2"><p className="text-rx-gray-medium text-xs">Description</p><p className="text-white">{data.app?.description}</p></div>
            <div className="col-span-2"><p className="text-rx-gray-medium text-xs">Release notes</p>
              <ul className="text-rx-gray-medium text-sm space-y-0.5">{(data.release?.releaseNotes || []).map((n: string, i: number) => <li key={i}>• {n}</li>)}</ul></div>
            {data.release?.featureSummary && <div className="col-span-2"><p className="text-rx-gray-medium text-xs">Feature summary</p><p className="text-white">{data.release.featureSummary}</p></div>}
          </div>
          {data.app?.icon && <img src={data.app.icon} alt="" className="w-16 h-16 rounded-xl object-cover border border-white/10" />}
          {(data.app?.screenshots || []).length > 0 && (
            <div className="flex gap-2 overflow-x-auto">
              {data.app.screenshots.slice(0, 6).map((shot: string, i: number) => (
                <img key={i} src={shot} alt={`screenshot ${i + 1}`} className="h-24 rounded-lg border border-white/10 object-cover" />
              ))}
            </div>
          )}
        </div>

        {/* Packages + security */}
        <div className="card p-5 space-y-3">
          <h4 className="font-semibold text-white text-sm">Packages & security</h4>
          {(data.packages || []).length === 0 && <p className="text-xs text-rx-gray-medium">No binary packages (web deployment).</p>}
          {(data.packages || []).map((p: any) => (
            <div key={p.id} className="p-3 rounded-xl bg-rx-dark-tertiary/60 border border-white/5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-white">{p.platform}{p.architecture !== 'universal' ? ` (${p.architecture})` : ''}</span>
                <span className="text-xs text-rx-gray-medium truncate flex-1 min-w-0">{p.deployment_url || p.filename}</span>
                {p.security_state && p.security_state !== 'PUBLISHED' && <Badge status={p.security_state} />}
                {p.overall_security && <Badge status={p.overall_security} />}
              </div>
              <div className="mt-1.5 space-y-0.5">
                {(p.checks || []).map((c: any) => (
                  <div key={c.check_type} className="flex items-start gap-1.5 text-[11px]">
                    <span className={`w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0 ${['PASSED', 'CLEAN'].includes(c.status) ? 'bg-green-400' : ['FAILED', 'DETECTED'].includes(c.status) ? 'bg-red-400' : c.status === 'NOT_APPLICABLE' ? 'bg-rx-gray-medium/40' : 'bg-amber-300'}`} />
                    <span className="text-rx-gray-medium"><span className="text-white">{String(c.check_type).replace(/_/g, ' ')}:</span> {c.result}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Previous versions */}
        <div className="card p-5">
          <h4 className="font-semibold text-white text-sm">Previous versions</h4>
          {(data.previousVersions || []).length === 0 ? (
            <p className="text-xs text-rx-gray-medium mt-2">First release of this app.</p>
          ) : (
            <div className="mt-2 space-y-1.5">
              {data.previousVersions.map((v: any, i: number) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="text-white">v{v.version}</span>
                  <span className="flex items-center gap-2"><Badge status={v.status} /><span className="text-[11px] text-rx-gray-medium">{formatDate(v.publishedAt || v.created_at)}</span></span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Review history */}
        <div className="card p-5">
          <h4 className="font-semibold text-white text-sm">Review history</h4>
          <div className="mt-2 space-y-1.5 max-h-56 overflow-y-auto">
            {(data.events || []).map((e: any, i: number) => (
              <div key={i} className="text-xs flex gap-2">
                <span className="text-rx-yellow whitespace-nowrap">{formatDate(e.created_at)}</span>
                <span className="text-white">{String(e.event).replace(/_/g, ' ')}</span>
                <span className="text-rx-gray-medium truncate" title={e.notes || ''}>{e.notes || ''}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Decision forms */}
      {['SUBMITTED', 'SECURITY_REVIEW', 'ADMIN_REVIEW', 'CHANGES_REQUESTED'].includes(s.status) && (
        <div className="card p-5 space-y-4">
          <h4 className="font-semibold text-white text-sm">Decisions</h4>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" placeholder="Approval notes (optional, shared with the developer)…" />
          <div className="border-t border-white/5 pt-4">
            <label className="block text-xs text-rx-gray-medium mb-1.5">Reason (required for reject / request changes — min 10 characters)</label>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" placeholder="Explain exactly what must change and why…" />
          </div>
          <div>
            <label className="block text-xs text-rx-gray-medium mb-1.5">Action items for the developer (required for request changes — be specific)</label>
            {actionItems.map((item, i) => (
              <div key={i} className="flex gap-2 mb-2">
                <input
                  className="flex-1 bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2 text-sm text-white"
                  placeholder={i === 0 ? 'e.g. Add release notes describing the permission change in 2.1.0' : 'Another concrete action item…'}
                  value={item}
                  onChange={(e) => setActionItems(actionItems.map((x, j) => j === i ? e.target.value : x))}
                />
                {actionItems.length > 1 && (
                  <button onClick={() => setActionItems(actionItems.filter((_, j) => j !== i))} className="text-rx-gray-medium hover:text-red-400 px-2">✕</button>
                )}
              </div>
            ))}
            <button onClick={() => setActionItems([...actionItems, ''])} className="text-xs text-rx-yellow hover:underline">+ add action item</button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => act('request-changes', { reason, actionItems: actionItems.filter((a) => a.trim().length >= 3) }, 'Changes requested')} disabled={busy || reason.trim().length < 10 || !actionItems.some((a) => a.trim().length >= 3)}
              className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-40"><Edit3 className="w-4 h-4" /> Request changes</button>
            <button onClick={() => act('reject', { reason }, 'Submission rejected')} disabled={busy || reason.trim().length < 10}
              className="text-sm flex items-center gap-2 px-4 py-2 rounded-xl bg-red-400/10 text-red-400 border border-red-400/20 hover:bg-red-400/20 disabled:opacity-40"><XCircle className="w-4 h-4" /> Reject</button>
          </div>
        </div>
      )}

      {/* Communication thread */}
      {data.thread && (
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-white text-sm">Communication with the developer</h4>
            <Badge status={String(data.thread.status || 'OPEN').replace(/_/g, ' ')} />
          </div>
          <div className="mt-3 space-y-3 max-h-72 overflow-y-auto">
            {(data.thread.messages || []).map((m: any) => (
              <div key={m.id} className={`max-w-[85%] rounded-xl p-3 text-sm ${m.sender_context === 'ADMIN' ? 'bg-rx-yellow/10 text-white ml-auto' : 'bg-rx-dark-tertiary text-rx-gray-medium'}`}>
                <p className="text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: m.sender_context === 'ADMIN' ? '#FFD600' : undefined }}>
                  {m.sender_context === 'ADMIN' ? 'RX Store' : 'Developer'}
                </p>
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className="text-[10px] text-rx-gray-medium/60 mt-1">{formatDate(m.created_at)}</p>
              </div>
            ))}
            {(data.thread.attachments || []).length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2 border-t border-white/5">
                {data.thread.attachments.map((a: any) => (
                  <a key={a.id} href={api.adminSubmissions.attachmentUrl(a.id)} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-rx-yellow hover:underline">
                    <Paperclip className="w-3.5 h-3.5" /> {a.filename}
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${STATUS_COLORS[a.scan_status] || ''}`}>{String(a.scan_status || 'PENDING').toLowerCase()}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
          {String(data.thread.status) !== 'CLOSED' && (
            <div className="flex flex-col sm:flex-row gap-2 mt-3 border-t border-white/5 pt-3">
              <input className="flex-1 bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" placeholder="Message the developer…" value={reply} onChange={(e) => setReply(e.target.value)} />
              <label className="btn-secondary text-sm flex items-center gap-2 cursor-pointer">
                <Paperclip className="w-4 h-4" /> {file ? file.name.slice(0, 18) : 'Attach'}
                <input type="file" className="hidden" accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.log,.md,.json" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              </label>
              <button onClick={sendMessage} disabled={busy} className="btn-primary text-sm px-4 disabled:opacity-40"><Send className="w-4 h-4" /></button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
