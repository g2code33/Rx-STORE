/**
 * Security Review Workspace — the admin UI for the Manual Security Review
 * system. Lives INSIDE the existing Admin → Developers → Security tab (no
 * second admin system): a status-broken queue (Pending / Approved / Rejected /
 * Recently completed) plus a full review detail with every security signal,
 * explicit Automated-vs-Manual distinction, hash-bound confirmation flow and
 * stale-review protection.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert, Ban, RefreshCw, Fingerprint, Clock, FileSearch, ScanLine, PackageCheck, Copy, X } from 'lucide-react';
import { api } from '../../services/api';
import { formatBytes, formatDate } from '../../utils/helpers';
import toast from 'react-hot-toast';

type QueueFilter = 'pending' | 'approved' | 'rejected' | 'recent';

const FILTERS: Array<{ id: QueueFilter; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'recent', label: 'Recently completed' },
];

/** Automated-vs-manual distinction is always visually explicit. */
function StatusPill({ label, value, tone }: { label: string; value: string; tone: 'auto' | 'manual' | 'ok' | 'bad' | 'warn' }) {
  const tones: Record<string, string> = {
    auto: 'bg-blue-400/10 text-blue-300 border-blue-400/25',
    manual: 'bg-purple-400/10 text-purple-300 border-purple-400/25',
    ok: 'bg-green-400/10 text-green-300 border-green-400/25',
    bad: 'bg-red-400/10 text-red-300 border-red-400/25',
    warn: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
  };
  return (
    <div className={`rounded-xl border px-3 py-2 ${tones[tone]}`}>
      <p className="text-[9px] uppercase tracking-wider opacity-80">{label}</p>
      <p className="text-xs font-bold mt-0.5">{String(value).replace(/_/g, ' ')}</p>
    </div>
  );
}

function CheckRow({ c }: { c: any }) {
  const tone = c.status === 'PASSED' || c.status === 'CLEAN' ? 'text-green-400' : c.status === 'FAILED' || c.status === 'DETECTED' ? 'text-red-400' : 'text-amber-300';
  return (
    <div className="p-3 rounded-xl bg-rx-dark-tertiary/60 border border-white/5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${tone}`}>{String(c.status).replace(/_/g, ' ')}</span>
        <span className="text-sm font-medium text-white">{String(c.check_type).replace(/_/g, ' ')}</span>
        {c.provider && <span className="text-[10px] text-rx-gray-medium">via {c.provider}{c.provider_version ? ` ${c.provider_version}` : ''}</span>}
        {c.scanner_analysis_id && <span className="text-[10px] font-mono text-rx-gray-medium">analysis {String(c.scanner_analysis_id).slice(0, 18)}…</span>}
        {c.fingerprint && <span className="text-[10px] font-mono text-rx-gray-medium">cert {String(c.fingerprint).slice(0, 12)}…</span>}
      </div>
      <p className="text-xs text-rx-gray-medium mt-1.5">{c.result}{c.details ? ` — ${c.details}` : ''}</p>
      {c.scanner_raw_summary && <p className="text-[10px] font-mono text-rx-gray-medium/70 mt-1">{c.scanner_raw_summary}</p>}
      {(c.scanner_started_at || c.completed_at) && (
        <p className="text-[10px] text-rx-gray-medium/60 mt-0.5 flex items-center gap-1"><Clock className="w-3 h-3" />
          {c.scanner_started_at ? `scan ${formatDate(c.scanner_started_at)}` : ''}{c.scanner_started_at && c.completed_at ? ' → ' : ''}{c.completed_at ? `done ${formatDate(c.completed_at)}` : ''}
        </p>
      )}
    </div>
  );
}

export default function SecurityReviewWorkspace({ onBack }: { onBack: () => void }) {
  const [queue, setQueue] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<QueueFilter>('pending');
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notes, setNotes] = useState('');
  const [confirming, setConfirming] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [busy, setBusy] = useState(false);
  // The hash the admin SAW when opening the review — used to detect package
  // changes while the page is open (stale-review protection).
  const [openedHash, setOpenedHash] = useState<string | null>(null);

  const loadQueue = () => {
    setLoading(true);
    (api as any).developers.security.reviewQueue()
      .then((r: any) => setQueue(r.queue || []))
      .catch(() => setQueue([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => { loadQueue(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDetail = async (packageId: string, rememberHash = true) => {
    setDetailLoading(true);
    try {
      const d = await (api as any).developers.security.package(packageId);
      setDetail(d);
      if (rememberHash) setOpenedHash(d.package.sha256);
      return d;
    } catch (e: any) {
      toast.error(e?.message || 'Could not load the package');
      return null;
    } finally {
      setDetailLoading(false);
    }
  };

  const openReview = async (packageId: string) => {
    setOpenId(packageId);
    setNotes('');
    setConfirming(null);
    await loadDetail(packageId, true);
  };

  // Re-validate the hash whenever the detail refreshes: if the package bytes
  // changed while the page was open, block approval and say so.
  const hashChanged = useMemo(
    () => !!(detail && openedHash && detail.package.sha256 && String(openedHash).toLowerCase() !== String(detail.package.sha256).toLowerCase()),
    [detail, openedHash],
  );

  const counts = useMemo(() => ({
    pending: queue.filter((q) => q.manualReview?.status === 'PENDING' && !q.manualReviewInvalidated).length,
    approved: queue.filter((q) => q.manualReview?.status === 'APPROVED').length,
    rejected: queue.filter((q) => q.manualReview?.status === 'REJECTED').length,
    recent: queue.filter((q) => q.manualReview?.reviewedAt || q.manualReview?.status === 'APPROVED' || q.manualReview?.status === 'REJECTED').length,
  }), [queue]);

  const visible = useMemo(() => {
    if (filter === 'pending') return queue.filter((q) => q.manualReview?.status === 'PENDING' && !q.manualReviewInvalidated && q.manualReviewEligible);
    if (filter === 'approved') return queue.filter((q) => q.manualReview?.status === 'APPROVED');
    if (filter === 'rejected') return queue.filter((q) => q.manualReview?.status === 'REJECTED');
    return queue.filter((q) => ['APPROVED', 'REJECTED'].includes(q.manualReview?.status));
  }, [queue, filter]);

  const pendingReview = (detail?.manualReviews || []).find((m: any) => m.status === 'PENDING' && !m.invalidatedAt && m.bindsCurrentBytes);
  const decision = async (kind: 'APPROVE' | 'REJECT') => {
    if (!detail || !pendingReview) return;
    if (hashChanged) { toast.error('The package changed while this review was open — security review must restart.'); return; }
    setBusy(true);
    try {
      const res = await (api as any).developers.security.manualReview(detail.package.id, kind, notes);
      if (kind === 'APPROVE') {
        toast.success('Manual review APPROVED — publication authorized for this exact hash');
      } else {
        toast.success('Manual review REJECTED — publication stays blocked');
      }
      void res;
      setConfirming(null);
      setNotes('');
      await loadDetail(detail.package.id, true); // fresh state
      loadQueue();
    } catch (e: any) {
      toast.error(e?.message || 'Decision failed');
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string) => { try { navigator.clipboard.writeText(text); toast.success('Copied'); } catch { toast.error('Copy failed'); } };

  // ---- Detail view -------------------------------------------------------
  if (openId && detail) {
    const p = detail.package;
    const integrityCheck = (detail.checks || []).find((c: any) => c.check_type === 'integrity');
    const malwareCheck = (detail.checks || []).find((c: any) => c.check_type === 'malware');
    const latestApproved = (detail.manualReviews || []).find((m: any) => m.status === 'APPROVED' && !m.invalidatedAt && m.bindsCurrentBytes);
    return (
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <button onClick={() => { setOpenId(null); setDetail(null); setOpenedHash(null); loadQueue(); }} className="text-xs text-rx-gray-medium hover:text-white mb-2 inline-flex items-center gap-1">
              <X className="w-3.5 h-3.5" /> Back to the review queue
            </button>
            <h3 className="text-lg font-bold text-white break-all">{p.filename}</h3>
            <p className="text-sm text-rx-gray-medium mt-0.5">
              {p.app?.name} · v{p.release?.version} · {p.platform}{p.architecture !== 'universal' ? ` (${p.architecture})` : ''} · {formatBytes(p.sizeBytes)} · uploaded {p.verifiedAt ? '' : ''}{formatDate(p.scanAt || '')}
            </p>
          </div>
          <button onClick={() => loadDetail(p.id, false)} disabled={detailLoading} className="btn-secondary text-sm flex items-center gap-2">
            <RefreshCw className={`w-4 h-4 ${detailLoading ? 'animate-spin' : ''}`} /> Re-validate hash &amp; status
          </button>
        </div>

        {/* The exact SHA-256 — prominent, with the binding statement */}
        <div className="card p-4 border-rx-yellow/25">
          <div className="flex items-start gap-3">
            <Fingerprint className="w-5 h-5 text-rx-yellow mt-0.5 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-wider text-rx-gray-medium">Package SHA-256 (exact bytes)</p>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <code className="text-xs sm:text-sm font-mono text-rx-yellow break-all">{p.sha256}</code>
                <button onClick={() => copy(p.sha256)} className="p-1.5 rounded-lg text-rx-gray-medium hover:text-rx-yellow hover:bg-rx-yellow/10" title="Copy SHA-256"><Copy className="w-3.5 h-3.5" /></button>
              </div>
              <p className="text-xs text-rx-gray-medium mt-1.5">🔒 This review is bound to this exact package hash. Any replacement upload invalidates it and security review restarts.</p>
            </div>
          </div>
        </div>

        {/* Stale-review guard */}
        {hashChanged && (
          <div className="card p-4 border-red-400/40 bg-red-400/10">
            <p className="text-sm font-bold text-red-300 flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> The package changed while this review was open</p>
            <p className="text-xs text-red-200/90 mt-1">
              The current bytes ({String(p.sha256).slice(0, 16)}…) differ from the hash this review was opened for ({String(openedHash).slice(0, 16)}…).
              Approval is disabled — re-run the security pipeline so the new bytes get a fresh automated pass and a new review.
            </p>
          </div>
        )}

        {/* Automated vs manual — always visually distinct */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatusPill label="Automated security" value={p.overallSecurity} tone="auto" />
          <StatusPill label="Automated malware" value={p.malwareStatus} tone={p.malwareStatus === 'CLEAN' ? 'ok' : p.malwareStatus === 'DETECTED' ? 'bad' : 'warn'} />
          <StatusPill label="Automated integrity" value={integrityCheck?.status || 'not recorded'} tone={integrityCheck?.status === 'PASSED' ? 'ok' : 'warn'} />
          <StatusPill label="Manual review" value={latestApproved ? 'APPROVED' : pendingReview ? 'PENDING' : 'NONE'} tone={latestApproved ? 'manual' : pendingReview ? 'warn' : 'auto'} />
        </div>
        {p.malwareStatus !== 'CLEAN' && (
          <p className="text-[11px] text-rx-gray-medium -mt-2">
            Automated malware is <b className="text-amber-300">{String(p.malwareStatus).replace(/_/g, ' ')}</b> — this is <b>not</b> a clean verdict. A manual decision below authorizes publication despite the scanner being unable to provide a definitive result.
          </p>
        )}

        {/* Integrity evidence */}
        <div className="card p-4 space-y-2">
          <p className="text-sm font-semibold text-white flex items-center gap-2"><FileSearch className="w-4 h-4 text-rx-yellow" /> Integrity</p>
          <div className="grid sm:grid-cols-2 gap-2 text-xs">
            <div className="bg-rx-dark-tertiary/60 rounded-lg p-2.5"><p className="text-rx-gray-medium">Recorded SHA-256</p><p className="font-mono text-white/90 mt-0.5 break-all">{p.sha256}</p></div>
            <div className="bg-rx-dark-tertiary/60 rounded-lg p-2.5"><p className="text-rx-gray-medium">Verification</p><p className={`font-bold mt-0.5 ${integrityCheck?.status === 'PASSED' ? 'text-green-400' : 'text-amber-300'}`}>{integrityCheck ? `${integrityCheck.status} — ${integrityCheck.result}` : 'not recorded'}</p></div>
          </div>
        </div>

        {/* Malware evidence */}
        <div className="card p-4 space-y-2">
          <p className="text-sm font-semibold text-white flex items-center gap-2"><ScanLine className="w-4 h-4 text-rx-yellow" /> Malware scanner</p>
          <div className="grid sm:grid-cols-3 gap-2 text-xs">
            <div className="bg-rx-dark-tertiary/60 rounded-lg p-2.5"><p className="text-rx-gray-medium">Provider</p><p className="text-white/90 mt-0.5">{malwareCheck?.provider || '—'}</p></div>
            <div className="bg-rx-dark-tertiary/60 rounded-lg p-2.5"><p className="text-rx-gray-medium">Status</p><p className={`font-bold mt-0.5 ${malwareCheck?.status === 'CLEAN' ? 'text-green-400' : malwareCheck?.status === 'DETECTED' ? 'text-red-400' : 'text-amber-300'}`}>{malwareCheck?.status || p.malwareStatus || '—'}</p></div>
            <div className="bg-rx-dark-tertiary/60 rounded-lg p-2.5"><p className="text-rx-gray-medium">Analysis ID</p><p className="font-mono text-white/90 mt-0.5 break-all">{malwareCheck?.scanner_analysis_id || '—'}</p></div>
          </div>
          {malwareCheck?.scanner_raw_summary && <p className="text-[10px] font-mono text-rx-gray-medium">{malwareCheck.scanner_raw_summary}</p>}
          {(malwareCheck?.result || malwareCheck?.details) && <p className="text-xs text-rx-gray-medium">{malwareCheck.result}{malwareCheck.details ? ` — ${malwareCheck.details}` : ''}</p>}
          {malwareCheck?.scanner_started_at && <p className="text-[10px] text-rx-gray-medium/70">scan {formatDate(malwareCheck.scanner_started_at)}{malwareCheck.completed_at ? ` → done ${formatDate(malwareCheck.completed_at)}` : ' (in progress)'}</p>}
        </div>

        {/* Every remaining security signal */}
        <div className="card p-4 space-y-2">
          <p className="text-sm font-semibold text-white flex items-center gap-2"><PackageCheck className="w-4 h-4 text-rx-yellow" /> Package security checks</p>
          {(detail.checks || []).filter((c: any) => !['integrity', 'malware'].includes(c.check_type)).length === 0 && (
            <p className="text-xs text-rx-gray-medium">No further checks recorded yet — run the security pipeline.</p>
          )}
          <div className="space-y-2">
            {(detail.checks || []).filter((c: any) => !['integrity', 'malware'].includes(c.check_type)).map((c: any) => <CheckRow key={c.check_type} c={c} />)}
          </div>
          <details className="text-xs text-rx-gray-medium">
            <summary className="cursor-pointer hover:text-white">Full check history ({(detail.history || []).length})</summary>
            <div className="space-y-1.5 mt-2">
              {(detail.history || []).map((h: any, i: number) => (
                <div key={i} className="p-2 rounded-lg bg-rx-dark-tertiary/40 border border-white/5">
                  <span className="text-[10px] font-bold mr-2">{String(h.status).replace(/_/g, ' ')}</span>
                  <span className="font-medium">{String(h.check_type).replace(/_/g, ' ')}</span>
                  <span className="text-rx-gray-medium"> — {h.result}</span>
                </div>
              ))}
            </div>
          </details>
        </div>

        {/* The decision */}
        {pendingReview && !hashChanged ? (
          <div className="card p-5 space-y-4 border-blue-400/25">
            <div>
              <p className="text-sm font-bold text-white">Manual security review decision</p>
              <p className="text-xs text-rx-gray-medium mt-1">
                Reason automated verification could not conclude: <span className="text-white/85">{pendingReview.reason}</span>
              </p>
            </div>
            <div className="rounded-xl bg-amber-500/10 border border-amber-500/25 p-3">
              <p className="text-xs text-amber-200 leading-relaxed">
                <ShieldAlert className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />
                Approving authorizes publication <b>despite the automated scanner being unable to provide a definitive result</b> ({String(p.malwareStatus).replace(/_/g, ' ')}).
                The automated verdict stays on record — it is never converted to CLEAN. Confirm you have independently verified these exact bytes.
              </p>
            </div>
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000}
              className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white"
              placeholder="Admin notes (REQUIRED, min 10 characters) — what you checked and why this decision is safe…" />
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setConfirming('APPROVE')} disabled={busy || notes.trim().length < 10}
                className="text-sm flex items-center gap-2 px-4 py-2 rounded-xl bg-green-500/10 text-green-300 border border-green-500/25 hover:bg-green-500/20 disabled:opacity-40">
                <ShieldCheck className="w-4 h-4" /> Approve manually
              </button>
              <button onClick={() => setConfirming('REJECT')} disabled={busy || notes.trim().length < 10}
                className="text-sm flex items-center gap-2 px-4 py-2 rounded-xl bg-red-500/10 text-red-300 border border-red-500/25 hover:bg-red-500/20 disabled:opacity-40">
                <Ban className="w-4 h-4" /> Reject
              </button>
              <button onClick={async () => { try { await (api as any).developers.security.rescan(p.id); toast.success('Pipeline re-run'); await loadDetail(p.id, true); loadQueue(); } catch (e: any) { toast.error(e?.message || 'Rescan failed'); } }} disabled={busy}
                className="btn-secondary text-sm flex items-center gap-2 ml-auto"><RefreshCw className="w-4 h-4" /> Re-run automated pipeline</button>
            </div>

            {confirming && (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                <div className="bg-rx-dark-secondary border border-white/10 rounded-2xl w-full max-w-md p-6">
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    {confirming === 'APPROVE' ? <ShieldCheck className="w-5 h-5 text-green-400" /> : <Ban className="w-5 h-5 text-red-400" />}
                    {confirming === 'APPROVE' ? 'Approve this package manually?' : 'Reject this package?'}
                  </h3>
                  <p className="text-xs text-rx-gray-medium mt-2 leading-relaxed">
                    {confirming === 'APPROVE'
                      ? <>You are authorizing publication of <b className="text-white">{p.filename}</b> for exactly hash <code className="text-rx-yellow break-all">{String(p.sha256).slice(0, 24)}…</code>, despite the automated scanner reporting <b className="text-amber-300">{String(p.malwareStatus).replace(/_/g, ' ')}</b>. This decision is audited with your identity and notes.</>
                      : <>Publication of <b className="text-white">{p.filename}</b> stays blocked and the developer is notified. This decision is audited.</>}
                  </p>
                  <div className="flex gap-2 justify-end mt-5">
                    <button onClick={() => setConfirming(null)} className="px-4 py-2 rounded-xl bg-white/5 text-white border border-white/10 text-sm">Cancel</button>
                    <button onClick={() => decision(confirming)} disabled={busy}
                      className={`px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-1.5 disabled:opacity-50 ${confirming === 'APPROVE' ? 'bg-green-500 text-rx-dark' : 'bg-red-500 text-white'}`}>
                      {busy ? 'Recording…' : confirming === 'APPROVE' ? 'Confirm approval' : 'Confirm rejection'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : latestApproved ? (
          <div className="card p-5 space-y-3 border-green-400/25">
            <p className="text-sm font-bold text-white">Review outcome</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <StatusPill label="Automated security" value={p.overallSecurity} tone="auto" />
              <StatusPill label="Manual review" value="APPROVED" tone="manual" />
              <StatusPill label="Publication authorization" value="MANUAL REVIEW" tone="ok" />
            </div>
            <p className="text-[11px] text-rx-gray-medium">The automated malware result remains <b className="text-amber-300">{String(p.malwareStatus).replace(/_/g, ' ')}</b> — it was never converted to CLEAN.</p>
          </div>
        ) : null}

        {/* Audit history */}
        {(detail.manualReviews || []).length > 0 && (
          <div className="card p-4 space-y-2">
            <p className="text-sm font-semibold text-white">Review &amp; audit history</p>
            {(detail.manualReviews || []).map((m: any) => (
              <div key={m.id} className={`p-3 rounded-lg border text-xs ${m.status === 'APPROVED' ? 'bg-green-400/10 border-green-400/20' : m.status === 'REJECTED' ? 'bg-red-400/10 border-red-400/20' : m.invalidatedAt ? 'bg-white/5 border-white/10' : 'bg-amber-500/10 border-amber-500/20'}`}>
                <p className="font-semibold text-white">
                  {m.status}{m.invalidatedAt ? ' · INVALIDATED (package bytes changed)' : !m.bindsCurrentBytes ? ' · bound to older bytes' : ''}
                </p>
                <p className="text-rx-gray-medium mt-0.5">
                  {m.adminName || 'pending decision'} · {m.reviewedAt ? formatDate(m.reviewedAt) : `opened ${formatDate(m.openedAt)}`} · hash <code className="break-all">{String(m.sha256).slice(0, 20)}…</code>
                  {m.automatedSnapshot?.overall ? ` · prior automated: ${String(m.automatedSnapshot.overall).replace(/_/g, ' ')}` : ''}
                </p>
                <p className="text-rx-gray-medium mt-0.5">Reason: {m.reason}</p>
                {m.adminNotes && <p className="text-rx-gray-medium">Notes: {m.adminNotes}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (openId && detailLoading) return <div className="card p-8 animate-pulse" />;

  // ---- Queue view --------------------------------------------------------
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-bold text-white flex items-center gap-2"><UserCheckIcon /> Security Review</h3>
          <p className="text-xs text-rx-gray-medium mt-1">Manual review workspace for packages whose automated verification could not conclude (UNAVAILABLE / SCANNING / UNKNOWN / NEEDS_REVIEW). Approvals authorize exactly the reviewed hash.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={loadQueue} disabled={loading} className="btn-secondary text-sm flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
          <button onClick={onBack} className="btn-secondary text-sm">Back to security</button>
        </div>
      </div>

      <div className="flex gap-1 bg-rx-dark-secondary rounded-xl p-1 w-fit flex-wrap">
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={`px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all ${filter === f.id ? 'bg-rx-yellow text-rx-dark' : 'text-rx-gray-medium hover:text-white'}`}>
            {f.label}{counts[f.id] ? ` (${counts[f.id]})` : ''}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card p-8 animate-pulse" />
      ) : visible.length === 0 ? (
        <div className="card p-8 text-center text-sm text-rx-gray-medium">
          {filter === 'pending'
            ? 'Nothing awaiting manual review. Packages appear here when automated verification cannot conclude (scanner unavailable, analysis in progress, signature chain needs review…).'
            : `No ${filter} reviews yet.`}
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((q) => (
            <button key={q.packageId} onClick={() => openReview(q.packageId)} className="card p-4 w-full text-left hover:border-rx-yellow/30 transition-colors space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-white truncate flex-1 min-w-48">{q.app?.name} <span className="text-rx-yellow">v{q.release?.version}</span></span>
                <StatusPill label="Automated" value={q.automated?.overallSecurity || 'PENDING'} tone="auto" />
                <StatusPill label="Malware" value={q.automated?.malwareStatus || 'pending'} tone={(q.automated?.malwareStatus === 'CLEAN') ? 'ok' : 'warn'} />
                {q.manualReview?.status && <StatusPill label="Manual" value={q.manualReview.status} tone={q.manualReview.status === 'APPROVED' ? 'manual' : q.manualReview.status === 'REJECTED' ? 'bad' : 'warn'} />}
              </div>
              <p className="text-xs text-rx-gray-medium">
                {q.filename} · {q.platform}{q.architecture && q.architecture !== 'universal' ? `/${q.architecture}` : ''} · {formatBytes(q.sizeBytes)} · uploaded {formatDate(q.createdDate || '')}
              </p>
              <p className="text-xs font-mono text-rx-gray-medium/70 break-all">{q.sha256}</p>
              {q.manualReview?.reason && <p className="text-xs text-rx-gray-medium">Reason: {q.manualReview.reason}</p>}
              <div className="flex flex-wrap gap-1.5">
                <span className="text-[10px] px-2 py-0.5 rounded bg-white/5 text-rx-gray-medium">integrity {(q.automatedSnapshot?.integrity || '—').toString().replace(/_/g, ' ')}</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-white/5 text-rx-gray-medium">publication {q.publicationState}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserCheckIcon() {
  return <ShieldCheck className="w-5 h-5 text-rx-yellow" />;
}
