/**
 * Developer Center — Connect GitHub Repository (FREE apps only).
 *
 * Workflow (all server-authorized):
 *   Connect → GitHub App install page (state-protected) → back to the
 *   Developer Center → pick one repository of the installation → bind.
 * The browser NEVER supplies credentials and NEVER decides access: the
 * repository list comes from the server-read installation, and binding
 * re-verifies ownership + free-tier eligibility server-side.
 *
 * If the deployment has no GitHub App configured, the panel says so plainly —
 * it never pretends a connection exists.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Github, Link2, Unlink, RefreshCw, ExternalLink, ShieldCheck, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../services/api';

type Props = { app: any; onChanged?: () => void };

export default function GithubConnectPanel({ app, onChanged }: Props) {
  const [state, setState] = useState<'loading' | 'ready'>('loading');
  const [status, setStatus] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<{ installationId: string; repos: any[] } | null>(null);

  const load = useCallback(() => {
    api.github.status(app.id)
      .then((s) => { setStatus(s); setState('ready'); })
      .catch(() => { setStatus(null); setState('ready'); });
  }, [app.id]);

  useEffect(load, [load]);

  // The GitHub App callback redirected back with ?gh_connect=<code> — finish
  // the flow by exchanging it for the server-resolved repository list.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('gh_connect');
    const ghError = params.get('gh_error');
    if (ghError) {
      toast.error(ghError === 'invalid_state' ? 'The connection request expired — start again.' : 'GitHub did not complete the installation.');
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (code) {
      api.github.complete(code)
        .then((r) => {
          setPicker({ installationId: r.installationId, repos: r.repos.filter((x) => !x.private) });
          window.history.replaceState({}, '', window.location.pathname);
        })
        .catch((e) => toast.error(e?.message || 'Could not complete the GitHub connection.'))
        .finally(() => window.history.replaceState({}, '', window.location.pathname));
    }
  }, []);

  const isPaid = ['paid', 'subscription'].includes(String(app?.priceType || app?.price_type || 'free')) && Number(app?.priceAmount ?? app?.price_amount ?? 0) > 0;
  const connection = status?.connection;

  const startConnect = async () => {
    setBusy(true);
    try {
      const { url } = await api.github.connect(app.id);
      window.location.href = url; // leave to GitHub's install page
    } catch (e: any) {
      toast.error(e?.message || 'Could not start the GitHub connection.');
    } finally { setBusy(false); }
  };

  const bind = async (repositoryId: string) => {
    if (!picker) return;
    setBusy(true);
    try {
      await api.github.bind(app.id, picker.installationId, repositoryId);
      toast.success('Repository connected — GitHub releases will now be detected automatically.');
      setPicker(null);
      load();
      onChanged?.();
    } catch (e: any) { toast.error(e?.message || 'Binding failed.'); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    if (!confirm(`Disconnect ${connection?.repository_full_name}? Already-published releases stay live; no NEW GitHub releases will be detected.`)) return;
    setBusy(true);
    try {
      await api.github.disconnect(app.id);
      toast.success('Repository disconnected.');
      load();
      onChanged?.();
    } catch (e: any) { toast.error(e?.message || 'Disconnect failed.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card p-5 md:p-6 mt-6">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-rx-dark-tertiary flex items-center justify-center"><Github className="w-5 h-5 text-white" /></div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">GitHub Releases</h3>
          <p className="text-xs text-rx-gray-medium mt-1 leading-relaxed">
            Connect a public repository: every GitHub Release you publish there is detected automatically, verified, and queued for
            RX Store admin approval. Approved releases roll out to users as updates — RX Store never stores your binaries; users download them straight from GitHub.
          </p>
        </div>
      </div>

      {state === 'loading' && <p className="text-xs text-rx-gray-medium mt-4">Loading connection status…</p>}

      {state === 'ready' && isPaid && (
        <div className="mt-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-amber-300 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-200">GitHub distribution is available for FREE applications only. Paid apps publish through the manual admin upload channel.</p>
        </div>
      )}

      {state === 'ready' && !isPaid && !status?.configured && (
        <div className="mt-4 p-3 rounded-xl bg-white/5 border border-white/10 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-rx-yellow mt-0.5 shrink-0" />
          <p className="text-xs text-rx-gray-medium">{status?.setupHint || 'The GitHub integration is not configured on this deployment yet. An administrator must complete the GitHub App setup first (docs/GITHUB_RELEASES.md).'}</p>
        </div>
      )}

      {state === 'ready' && !isPaid && status?.configured && !connection && !picker && (
        <button onClick={startConnect} disabled={busy} className="btn-primary text-sm mt-4 flex items-center gap-2 disabled:opacity-50">
          <Link2 className="w-4 h-4" /> {busy ? 'Opening GitHub…' : 'Connect GitHub repository'}
        </button>
      )}

      {picker && (
        <div className="mt-4 p-4 rounded-xl bg-rx-dark-tertiary/50 border border-white/10">
          <p className="text-xs font-semibold text-white mb-2">Pick the repository for <span className="text-rx-yellow">{app.name}</span></p>
          {picker.repos.length === 0 ? (
            <p className="text-xs text-rx-gray-medium">The installation has no public repositories. Install the App on a public repository and start again.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {picker.repos.map((r) => (
                <button key={r.id} onClick={() => bind(r.id)} disabled={busy}
                  className="w-full flex items-center gap-3 p-3 rounded-xl bg-rx-dark hover:bg-rx-dark-secondary border border-white/10 text-left transition-all disabled:opacity-50">
                  <Github className="w-4 h-4 text-rx-gray-medium shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{r.fullName}</p>
                    <p className="text-[11px] text-rx-gray-medium">{r.private ? 'private (not supported)' : 'public repository'}</p>
                  </div>
                  <ExternalLink className="w-3.5 h-3.5 text-rx-gray-medium" />
                </button>
              ))}
            </div>
          )}
          <button onClick={() => setPicker(null)} className="text-xs text-rx-gray-medium hover:text-white mt-3">Cancel</button>
        </div>
      )}

      {connection && (
        <div className="mt-4 p-4 rounded-xl bg-rx-dark-tertiary/50 border border-white/10">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className={`w-4 h-4 ${connection.status === 'active' ? 'text-green-400' : 'text-rx-gray-medium'}`} />
            <p className="text-sm font-semibold text-white">{connection.repository_full_name}</p>
            <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${connection.status === 'active' ? 'bg-green-500/20 text-green-300' : 'bg-white/10 text-rx-gray-medium'}`}>
              {connection.status === 'active' ? 'Connected' : connection.status}
            </span>
            {connection.status === 'active' ? (
              <button onClick={disconnect} disabled={busy} className="ml-auto text-xs text-red-400 hover:bg-red-400/10 px-3 py-1.5 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                <Unlink className="w-3.5 h-3.5" /> Disconnect
              </button>
            ) : (
              <button onClick={startConnect} disabled={busy} className="ml-auto btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-50">
                <RefreshCw className="w-3.5 h-3.5" /> Reconnect
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-[11px]">
            <div><p className="text-rx-gray-medium">Repository ID</p><p className="text-white/80 font-mono truncate">{connection.repository_id}</p></div>
            <div><p className="text-rx-gray-medium">Channel</p><p className="text-white/80 capitalize">{connection.channel || 'stable'}</p></div>
            <div><p className="text-rx-gray-medium">Last event</p><p className="text-white/80 truncate">{connection.last_event || '—'}</p></div>
            <div><p className="text-rx-gray-medium">Latest detected</p><p className="text-white/80">{connection.latest_detected_version || '—'}</p></div>
          </div>
          {connection.last_error && (
            <p className="text-[11px] text-amber-300 mt-2">⚠ {connection.last_error}</p>
          )}
          <p className="text-[11px] text-rx-gray-medium mt-2 leading-relaxed">
            Releases appear in Admin → GitHub Releases & Approvals after verification. Nothing reaches users until an admin approves and publishes it.
          </p>
        </div>
      )}
    </div>
  );
}
