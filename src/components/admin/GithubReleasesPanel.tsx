/**
 * Admin — GitHub Releases & Approvals (dedicated first-class center).
 *
 * Real backend data + real actions only: overview counters, the approval
 * queue with filters, full release review (identity, assets, verification,
 * scanner verdicts, blockers), explicit Approve & Publish (with confirmation,
 * and an auditable security override ONLY when a mandatory check is
 * UNAVAILABLE — never for a DETECTED verdict), Reject (reason required),
 * Retry Verification, Withdraw, repository connection health, reconciliation
 * sync and the audit trail. No placeholder counts, no mock releases.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Github, RefreshCw, CheckCircle2, XCircle, ShieldAlert, Clock, Link2, Unlink, History, ChevronDown, ExternalLink, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../services/api';

const STATUS_STYLES: Record<string, string> = {
  detected: 'bg-white/10 text-rx-gray-medium',
  verifying: 'bg-blue-500/15 text-blue-300',
  pending_approval: 'bg-rx-yellow/15 text-rx-yellow',
  verification_failed: 'bg-red-500/15 text-red-300',
  blocked: 'bg-red-500/15 text-red-300',
  rejected: 'bg-white/10 text-rx-gray-medium',
  withdrawn: 'bg-white/10 text-rx-gray-medium',
  published: 'bg-green-500/15 text-green-300',
};

function StatusBadge({ status }: { status: string }) {
  return <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${STATUS_STYLES[status] || 'bg-white/10 text-rx-gray-medium'}`}>{String(status || '').replace(/_/g, ' ')}</span>;
}

function StatCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number | string; tone?: string }) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${tone || 'bg-white/5'}`}>{icon}</div>
      <div><p className="text-xl font-black text-white leading-none">{value}</p><p className="text-[11px] text-rx-gray-medium mt-1">{label}</p></div>
    </div>
  );
}

export default function GithubReleasesPanel() {
  const [tab, setTab] = useState<'queue' | 'connections' | 'audit'>('queue');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [overview, setOverview] = useState<any>(null);
  const [releases, setReleases] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<any>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [publishFor, setPublishFor] = useState<any>(null);
  const [override, setOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [ov, rel] = await Promise.all([
        api.githubAdmin.overview(),
        api.githubAdmin.releases(filter ? { status: filter } : {}),
      ]);
      setOverview(ov);
      setReleases(rel.releases || []);
    } catch (e: any) {
      setError(e?.message || 'Could not load the GitHub approval center.');
    } finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab !== 'audit') return;
    api.githubAdmin.audit().then((a) => setAudit(a.entries || [])).catch(() => setAudit([]));
  }, [tab]);

  const runSync = async () => {
    setBusyId('__sync__');
    try {
      const r = await api.githubAdmin.sync();
      toast.success(`Synced ${r.checked} connection(s) — ${r.detected} new release(s) detected${r.failures ? `, ${r.failures} failed` : ''}.`);
      load();
    } catch (e: any) { toast.error(e?.message || 'Sync failed.'); }
    finally { setBusyId(null); }
  };

  const doPublish = async () => {
    if (!publishFor) return;
    setBusyId(publishFor.id);
    try {
      const r = await api.githubAdmin.publish(publishFor.id, override ? { overrideSecurity: true, reason: overrideReason } : {});
      toast.success(`Published v${r.version} — users can now update.`);
      setPublishFor(null); setOverride(false); setOverrideReason('');
      load();
    } catch (e: any) { toast.error(e?.message || 'Publication failed.', { duration: 8000 }); }
    finally { setBusyId(null); }
  };

  const doReject = async () => {
    if (!rejectFor) return;
    setBusyId(rejectFor.id);
    try {
      await api.githubAdmin.reject(rejectFor.id, rejectReason);
      toast.success('Release rejected — it will never be offered as an update.');
      setRejectFor(null); setRejectReason('');
      load();
    } catch (e: any) { toast.error(e?.message || 'Rejection failed.'); }
    finally { setBusyId(null); }
  };

  const doRetry = async (rel: any) => {
    setBusyId(rel.id);
    try {
      const r = await api.githubAdmin.retry(rel.id);
      if (r.status === 'pending_approval') toast.success('Verification passed — the release is ready for approval.');
      else toast(`Verification status: ${r.status}${r.message ? ` — ${r.message}` : ''}`, { icon: 'ℹ️', duration: 7000 });
      load();
    } catch (e: any) { toast.error(e?.message || 'Retry failed.'); }
    finally { setBusyId(null); }
  };

  const doWithdraw = async (rel: any) => {
    const reason = prompt(`Withdraw v${rel.version} from users? Update checks stop recommending it.\nReason (required):`);
    if (reason == null) return;
    if (reason.trim().length < 10) { toast.error('A withdrawal reason of at least 10 characters is required.'); return; }
    setBusyId(rel.id);
    try {
      await api.githubAdmin.withdraw(rel.id, reason);
      toast.success('Release withdrawn.');
      load();
    } catch (e: any) { toast.error(e?.message || 'Withdrawal failed.'); }
    finally { setBusyId(null); }
  };

  const scannerUnreachable = (rel: any) => (rel.assets || []).some((a: any) => a.scanner_status && a.scanner_status !== 'CLEAN' && a.scanner_status !== 'DETECTED');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-rx-dark-tertiary flex items-center justify-center"><Github className="w-5 h-5 text-white" /></div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold text-white">GitHub Releases & Approvals</h2>
          <p className="text-xs text-rx-gray-medium">Detected GitHub releases wait here — nothing reaches users until you approve and publish it.</p>
        </div>
        <button onClick={runSync} disabled={busyId === '__sync__'} className="btn-secondary text-xs flex items-center gap-2 disabled:opacity-50">
          {busyId === '__sync__' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Sync repositories now
        </button>
      </div>

      {!overview?.configured && overview && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 text-amber-300 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-200">The GitHub App is not configured on this deployment (secrets missing) — automatic detection is INACTIVE. See docs/GITHUB_RELEASES.md for the exact setup steps. Manual sync will also not work until the App credentials exist.</p>
        </div>
      )}

      {/* Overview */}
      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <StatCard icon={<Clock className="w-4 h-4 text-rx-yellow" />} label="Pending approvals" value={overview.pendingApprovals} />
          <StatCard icon={<Link2 className="w-4 h-4 text-blue-300" />} label="Connected repos" value={overview.connectedRepositories} />
          <StatCard icon={<ShieldAlert className="w-4 h-4 text-red-300" />} label="Blocked / failed" value={overview.blocked} />
          <StatCard icon={<XCircle className="w-4 h-4 text-red-300" />} label="Failed events" value={overview.failedEvents} />
          <StatCard icon={<CheckCircle2 className="w-4 h-4 text-green-400" />} label="Published (all time)" value={overview.publishedTotal} />
          <StatCard icon={<History className="w-4 h-4 text-rx-gray-medium" />} label="Decisions (7d)" value={overview.recentlyDecided} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-white/10">
        {([['queue', 'Approval Queue'], ['connections', 'Repository Connections'], ['audit', 'Audit Log']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === id ? 'text-rx-yellow border-rx-yellow' : 'text-rx-gray-medium border-transparent hover:text-white'}`}>
            {label}
          </button>
        ))}
      </div>

      {loading && <div className="card p-8 text-center text-sm text-rx-gray-medium">Loading…</div>}
      {error && <div className="card p-6 text-center text-sm text-red-300">{error}</div>}

      {/* ---- Queue ---- */}
      {!loading && !error && tab === 'queue' && (
        <>
          <div className="flex flex-wrap gap-2 items-center">
            {['', 'pending_approval', 'verifying', 'detected', 'blocked', 'verification_failed', 'published', 'rejected', 'withdrawn'].map((s) => (
              <button key={s || 'all'} onClick={() => setFilter(s)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${filter === s ? 'text-rx-yellow border-rx-yellow/40 bg-rx-yellow/10' : 'text-rx-gray-medium border-white/10 bg-white/5 hover:text-white'}`}>
                {s ? s.replace(/_/g, ' ') : 'all'}
              </button>
            ))}
          </div>
          {releases.length === 0 && <div className="card p-8 text-center text-sm text-rx-gray-medium">No releases match this filter. {overview?.configured ? 'New GitHub releases appear here automatically.' : ''}</div>}
          <div className="space-y-3">
            {releases.map((rel) => (
              <div key={rel.id} className="card overflow-hidden">
                <button onClick={() => setExpanded(expanded === rel.id ? null : rel.id)} className="w-full p-4 flex flex-wrap items-center gap-3 hover:bg-white/[0.03] text-left">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white">
                      {rel.app_name || rel.application_id} <span className="text-rx-yellow">v{rel.version}</span>
                      <span className="text-rx-gray-medium font-normal text-xs ml-2">{rel.repository_full_name} · tag {rel.tag_name}</span>
                    </p>
                    <p className="text-xs text-rx-gray-medium mt-0.5">
                      detected {rel.detected_at} · {(rel.assets || []).length} asset(s)
                      {rel.is_prerelease ? ' · prerelease' : ''}
                      {rel.app_current_version ? ` · live: v${rel.app_current_version}` : ' · no live version'}
                    </p>
                  </div>
                  <StatusBadge status={rel.status} />
                  <ChevronDown className={`w-4 h-4 text-rx-gray-medium transition-transform ${expanded === rel.id ? 'rotate-180' : ''}`} />
                </button>

                {expanded === rel.id && (
                  <div className="border-t border-white/5 p-4 md:p-5 space-y-4">
                    {rel.block_reason && (
                      <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-200">⚠ {rel.block_reason}</div>
                    )}
                    {rel.decision_reason && (
                      <div className="p-3 rounded-xl bg-white/5 border border-white/10 text-xs text-rx-gray-medium">Decision note: {rel.decision_reason}</div>
                    )}

                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                      <div><p className="text-rx-gray-medium">Repository</p><p className="text-white/85 font-mono truncate">{rel.repository_full_name}</p></div>
                      <div><p className="text-rx-gray-medium">GitHub release ID</p><p className="text-white/85 font-mono">{rel.github_release_id}</p></div>
                      <div><p className="text-rx-gray-medium">Target commitish</p><p className="text-white/85 font-mono truncate">{rel.target_commitish || '—'}</p></div>
                    </div>

                    {rel.release_notes && (
                      <div>
                        <p className="text-xs text-rx-gray-medium uppercase tracking-wide mb-1">Release notes (from GitHub)</p>
                        <pre className="text-xs text-rx-gray-medium whitespace-pre-wrap max-h-40 overflow-y-auto bg-rx-dark rounded-xl p-3 border border-white/5">{String(rel.release_notes).slice(0, 2000)}</pre>
                      </div>
                    )}

                    <div>
                      <p className="text-xs text-rx-gray-medium uppercase tracking-wide mb-2">Assets (verified from actual bytes)</p>
                      <div className="space-y-2">
                        {(rel.assets || []).map((a: any) => (
                          <div key={a.id} className="p-3 rounded-xl bg-rx-dark border border-white/5 grid sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1 text-xs">
                            <div className="sm:col-span-2">
                              <p className="text-white/90 font-medium truncate">{a.name}</p>
                              <p className="text-rx-gray-medium">{a.platform}/{a.architecture} · {a.state}{a.verified_at ? ` · ${a.verified_at}` : ''}</p>
                            </div>
                            <div>
                              <p className="text-rx-gray-medium">Size / SHA-256</p>
                              <p className="text-white/85">{a.size_bytes ? `${(a.size_bytes / 1048576).toFixed(1)}MB` : '—'}</p>
                              <p className="text-white/60 font-mono text-[10px] truncate" title={a.sha256 || ''}>{a.sha256 ? `${a.sha256.slice(0, 16)}…` : 'not verified'}</p>
                            </div>
                            <div>
                              <p className="text-rx-gray-medium">Scanner</p>
                              <p className={a.scanner_status === 'CLEAN' ? 'text-green-300' : a.scanner_status === 'DETECTED' ? 'text-red-300 font-bold' : 'text-amber-300'}>{a.scanner_status || '—'}</p>
                              {a.scanner_detail && <p className="text-white/50 text-[10px] mt-0.5 leading-tight">{a.scanner_detail}</p>}
                              {a.error && <p className="text-red-300 text-[10px] mt-0.5">{a.error}</p>}
                            </div>
                          </div>
                        ))}
                        {(rel.assets || []).length === 0 && <p className="text-xs text-rx-gray-medium">No mapped assets — the release could not be mapped to any platform.</p>}
                      </div>
                    </div>

                    {(rel.packages || []).length > 0 && (
                      <div>
                        <p className="text-xs text-rx-gray-medium uppercase tracking-wide mb-2">Security pipeline evidence (per package)</p>
                        <div className="space-y-3">
                          {(rel.packages || []).map((p: any) => (
                            <div key={p.id} className="p-3 rounded-xl bg-rx-dark border border-white/5">
                              <div className="flex flex-wrap items-center gap-2 mb-2">
                                <p className="text-xs text-white/90 font-medium truncate">{p.filename}</p>
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-rx-gray-medium">{p.platform}/{p.architecture}</span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${p.overall_security === 'PASSED' ? 'bg-green-500/20 text-green-300' : p.overall_security === 'FAILED' ? 'bg-red-500/20 text-red-300' : 'bg-amber-500/20 text-amber-300'}`}>{p.overall_security}</span>
                                {p.signature_status && p.signature_status !== 'pending' && (
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${p.signature_status === 'SIGNED' ? 'bg-green-500/20 text-green-300' : p.signature_status === 'UNSIGNED' ? 'bg-amber-500/20 text-amber-300' : 'bg-white/10 text-rx-gray-medium'}`} title="Signature status">signature: {p.signature_status}</span>
                                )}
                                {p.manualReview && (
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${p.manualReview.status === 'APPROVED' ? 'bg-green-500/20 text-green-300' : p.manualReview.invalidated_at ? 'bg-white/10 text-rx-gray-medium' : 'bg-rx-yellow/20 text-rx-yellow'}`} title={p.manualReview.reason}>
                                    manual review: {p.manualReview.invalidated_at ? `${p.manualReview.status} (invalidated)` : p.manualReview.status}
                                  </span>
                                )}
                              </div>
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                                {(p.checks || []).map((c: any) => (
                                  <div key={c.check_type} className="px-2 py-1 rounded-lg bg-white/[0.03] border border-white/5" title={`${c.result}${c.details ? ` — ${c.details}` : ''}`}>
                                    <p className="text-[10px] text-rx-gray-medium">{c.check_type}</p>
                                    <p className={`text-[11px] font-medium ${c.status === 'PASSED' || c.status === 'CLEAN' ? 'text-green-300' : c.status === 'FAILED' || c.status === 'DETECTED' ? 'text-red-300' : c.status === 'NOT_APPLICABLE' ? 'text-rx-gray-medium' : 'text-amber-300'}`}>{c.status}</p>
                                  </div>
                                ))}
                                {(p.checks || []).length === 0 && <p className="text-[11px] text-rx-gray-medium">No checks recorded yet — run verification.</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {((rel.ignoredAssets || []).length > 0 || (rel.unmappedAssets || []).length > 0) && (
                      <details className="rounded-xl border border-white/5 bg-rx-dark/60">
                        <summary className="cursor-pointer px-3 py-2 text-xs text-rx-gray-medium hover:text-white select-none">
                          Skipped assets — {((rel.ignoredAssets || []).length + (rel.unmappedAssets || []).length)} not published
                        </summary>
                        <div className="px-3 pb-3 space-y-1.5">
                          {(rel.ignoredAssets || []).map((a: any) => (
                            <div key={`ig-${a.name}`} className="text-[11px] flex flex-wrap gap-x-2">
                              <span className="text-white/70 font-mono">{a.name}</span>
                              <span className="text-rx-gray-medium">— {a.reason}</span>
                            </div>
                          ))}
                          {(rel.unmappedAssets || []).map((a: any) => (
                            <div key={`um-${a.name}`} className="text-[11px] flex flex-wrap gap-x-2">
                              <span className="text-white/70 font-mono">{a.name}</span>
                              <span className="text-rx-gray-medium">— not a recognised installer type (no platform/architecture mapping)</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    <div className="flex flex-wrap gap-2 border-t border-white/5 pt-4">
                      {rel.status === 'pending_approval' && (
                        <>
                          <button onClick={() => { setPublishFor(rel); setOverride(false); setOverrideReason(''); }} disabled={busyId === rel.id}
                            className="btn-primary text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Approve & Publish</button>
                          <button onClick={() => { setRejectFor(rel); setRejectReason(''); }} disabled={busyId === rel.id}
                            className="px-4 py-2 rounded-xl text-sm text-red-300 hover:bg-red-400/10 flex items-center gap-2"><XCircle className="w-4 h-4" /> Reject</button>
                        </>
                      )}
                      {['detected', 'verifying', 'verification_failed', 'blocked'].includes(rel.status) && (
                        <button onClick={() => doRetry(rel)} disabled={busyId === rel.id} className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-50">
                          {busyId === rel.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Retry verification
                        </button>
                      )}
                      {rel.status === 'published' && (
                        <button onClick={() => doWithdraw(rel)} disabled={busyId === rel.id} className="px-4 py-2 rounded-xl text-sm text-amber-300 hover:bg-amber-400/10 flex items-center gap-2">
                          <Unlink className="w-4 h-4" /> Withdraw from users
                        </button>
                      )}
                      <a href={`https://github.com/${rel.repository_full_name}/releases/tag/${encodeURIComponent(rel.tag_name)}`} target="_blank" rel="noreferrer"
                        className="px-4 py-2 rounded-xl text-sm text-rx-gray-medium hover:text-white bg-white/5 flex items-center gap-2">
                        <ExternalLink className="w-4 h-4" /> View on GitHub
                      </a>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ---- Connections ---- */}
      {!loading && !error && tab === 'connections' && (
        <div className="space-y-3">
          {(overview?.connections || []).length === 0 && <div className="card p-8 text-center text-sm text-rx-gray-medium">No repositories are connected yet. Developers connect them from Developer Center → their app → GitHub Releases.</div>}
          {(overview?.connections || []).map((c: any) => (
            <div key={c.id} className="card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Github className="w-4 h-4 text-white" />
                <p className="text-sm font-semibold text-white">{c.repository_full_name}</p>
                <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${c.status === 'active' ? 'bg-green-500/20 text-green-300' : 'bg-white/10 text-rx-gray-medium'}`}>{c.status}</span>
                <span className="text-xs text-rx-gray-medium ml-auto">{c.app ? `${c.app.name} (v${c.app.current_version || '—'})` : c.application_id}</span>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mt-3 text-[11px]">
                <div><p className="text-rx-gray-medium">Repository ID</p><p className="text-white/80 font-mono truncate">{c.repository_id}</p></div>
                <div><p className="text-rx-gray-medium">Installation</p><p className="text-white/80 font-mono truncate">{c.installation_id}</p></div>
                <div><p className="text-rx-gray-medium">Last event</p><p className="text-white/80 truncate">{c.last_event || '—'}</p></div>
                <div><p className="text-rx-gray-medium">Last sync</p><p className="text-white/80">{c.last_sync_at || '—'}</p></div>
                <div><p className="text-rx-gray-medium">Latest detected</p><p className="text-white/80">{c.latest_detected_version || '—'}</p></div>
              </div>
              {c.last_error && <p className="text-[11px] text-amber-300 mt-2">⚠ {c.last_error}</p>}
            </div>
          ))}
        </div>
      )}

      {/* ---- Audit ---- */}
      {!loading && !error && tab === 'audit' && (
        <div className="card overflow-x-auto">
          {audit.length === 0 ? <p className="p-8 text-center text-sm text-rx-gray-medium">No GitHub admin actions recorded yet.</p> : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-rx-gray-medium border-b border-white/5">
                <th className="p-3">When</th><th className="p-3">Action</th><th className="p-3">Actor</th><th className="p-3">Version / detail</th><th className="p-3">Reason</th>
              </tr></thead>
              <tbody>
                {audit.map((e) => (
                  <tr key={e.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="p-3 text-rx-gray-medium whitespace-nowrap">{e.created_at}</td>
                    <td className="p-3"><span className="px-2 py-0.5 rounded bg-white/10 text-white/85">{e.action}</span></td>
                    <td className="p-3 text-rx-gray-medium font-mono">{e.actor_label || e.actor_id}</td>
                    <td className="p-3 text-white/80 max-w-xs truncate">{(() => { try { const d = JSON.parse(e.details || '{}'); return d.version ? `v${d.version}` : (e.release_id || '—'); } catch { return e.release_id || '—'; } })()}</td>
                    <td className="p-3 text-rx-gray-medium max-w-xs truncate">{e.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---- Publish confirmation ---- */}
      {publishFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setPublishFor(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-rx-dark-secondary border border-white/10 rounded-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-base font-bold text-white">Approve & publish v{publishFor.version}</h3>
            <p className="text-xs text-rx-gray-medium leading-relaxed">
              This makes v{publishFor.version} of <b className="text-white">{publishFor.app_name}</b> the live version: users' update checks will
              recommend it, notifications go out, and downloads serve the verified GitHub asset URLs. The exact verified asset set is pinned — any
              later change on GitHub re-blocks the release.
            </p>
            {(publishFor.assets || []).map((a: any) => (
              <div key={a.id} className="text-xs flex items-center justify-between gap-2 bg-rx-dark rounded-xl px-3 py-2 border border-white/5">
                <span className="truncate text-white/85">{a.platform}/{a.architecture} · {a.name}</span>
                <span className={a.scanner_status === 'CLEAN' ? 'text-green-300' : 'text-amber-300'}>{a.scanner_status}</span>
              </div>
            ))}
            {scannerUnreachable(publishFor) && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 space-y-2">
                <p className="text-xs text-amber-200">One or more assets could not be conclusively scanned. You may publish with an explicit security override — it is audited with your reason, and it is NEVER allowed for a scanner DETECTED verdict.</p>
                <label className="flex items-center gap-2 text-xs text-white/85">
                  <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="accent-rx-yellow" />
                  Publish with a security override
                </label>
                {override && (
                  <input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Override reason (min 10 characters, audited)"
                    className="w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-xs text-white" />
                )}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setPublishFor(null)} className="btn-secondary text-sm">Cancel</button>
              <button onClick={doPublish} disabled={busyId === publishFor.id || (override && overrideReason.trim().length < 10)}
                className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50">
                {busyId === publishFor.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Confirm & publish
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Reject ---- */}
      {rejectFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setRejectFor(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-rx-dark-secondary border border-white/10 rounded-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-base font-bold text-white">Reject v{rejectFor.version}</h3>
            <p className="text-xs text-rx-gray-medium">The release is never offered to users and the decision is audited. A redelivery of the same GitHub release does not resurrect it.</p>
            <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} placeholder="Rejection reason (required, min 10 characters)"
              className="w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white" />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setRejectFor(null)} className="btn-secondary text-sm">Cancel</button>
              <button onClick={doReject} disabled={busyId === rejectFor.id || rejectReason.trim().length < 10}
                className="px-4 py-2 rounded-xl text-sm text-red-300 bg-red-400/10 hover:bg-red-400/20 disabled:opacity-50 flex items-center gap-2">
                <XCircle className="w-4 h-4" /> Reject release
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
