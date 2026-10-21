/**
 * Admin — Connect to GitHub.
 *
 * ONE place to see the GitHub channel across the whole store: every
 * application, whether a developer connected it, and what state that
 * connection is in. Admins can suspend (stop detection + publication),
 * reinstate, or disconnect; and can start a connection on behalf of an app
 * that has none (the developer still owns it — the install/authorize flow runs
 * against the admin's own GitHub account, then binds the chosen repo).
 *
 * Every row is real backend data; every action is a real audited endpoint.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Github, RefreshCw, Loader2, ShieldOff, ShieldCheck, Unlink, Link2, AlertTriangle, Search, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../services/api';

type Row = {
  appId: string; slug: string; name: string; status: string; isPaid: boolean; currentVersion: string;
  connection: null | {
    id: string; repository: string; repositoryId: string; status: string; channel: string;
    lastEvent: string | null; lastEventAt: string | null; lastSyncAt: string | null;
    latestDetectedVersion: string | null; lastError: string | null;
  };
  latestRelease: null | { version: string; status: string; detected_at: string };
};

function stateOf(row: Row): { label: string; cls: string } {
  if (row.isPaid) return { label: 'paid — manual channel', cls: 'bg-white/10 text-rx-gray-medium' };
  if (!row.connection) return { label: 'not connected', cls: 'bg-white/10 text-rx-gray-medium' };
  if (row.connection.status === 'active') return { label: 'connected', cls: 'bg-green-500/20 text-green-300' };
  if (row.connection.status === 'revoked') return { label: 'suspended', cls: 'bg-amber-500/20 text-amber-300' };
  if (row.connection.status === 'disconnected') return { label: 'disconnected', cls: 'bg-white/10 text-rx-gray-medium' };
  return { label: row.connection.status, cls: 'bg-red-500/20 text-red-300' };
}

export default function GithubConnectionsPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState<{ configured: boolean; totals: any; apps: Row[] } | null>(null);
  const [filter, setFilter] = useState<'all' | 'connected' | 'not' | 'suspended'>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true); setError('');
    api.githubAdmin.connections()
      .then(setData)
      .catch((e: any) => setError(e?.message || 'Could not load GitHub connections.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const rows = useMemo(() => {
    const list = data?.apps || [];
    const byFilter = list.filter((r) => {
      if (filter === 'connected') return r.connection?.status === 'active';
      if (filter === 'not') return !r.connection;
      if (filter === 'suspended') return r.connection?.status === 'revoked';
      return true;
    });
    const q = query.trim().toLowerCase();
    return q ? byFilter.filter((r) => r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q)) : byFilter;
  }, [data, filter, query]);

  const act = async (row: Row, action: 'suspend' | 'reinstate' | 'disconnect') => {
    let reason = '';
    if (action !== 'reinstate') {
      const input = window.prompt(
        action === 'suspend'
          ? `Suspend GitHub detection for ${row.name}? Queued releases are blocked and nothing new is published until reinstated.\n\nReason (required, 10+ chars):`
          : `Disconnect ${row.connection?.repository} from ${row.name}? Published releases stay live; no new GitHub releases are detected.\n\nReason (required, 10+ chars):`,
      );
      if (input == null) return;
      if (input.trim().length < 10) { toast.error('A reason of at least 10 characters is required.'); return; }
      reason = input.trim();
    }
    setBusy(row.appId);
    try {
      await api.githubAdmin.connectionAction(row.appId, action, reason);
      toast.success(
        action === 'suspend' ? `${row.name}: GitHub connection suspended.`
          : action === 'reinstate' ? `${row.name}: GitHub connection reinstated.`
            : `${row.name}: repository disconnected.`,
      );
      load();
    } catch (e: any) { toast.error(e?.message || 'Action failed.'); }
    finally { setBusy(null); }
  };

  const totals = data?.totals || {};

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-rx-dark-tertiary flex items-center justify-center"><Github className="w-5 h-5 text-white" /></div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold text-white">Connect to GitHub</h2>
          <p className="text-xs text-rx-gray-medium">
            Every app's GitHub channel in one place. Developers connect their own free apps; admins can suspend, reinstate or disconnect.
          </p>
        </div>
        <button onClick={load} className="btn-secondary text-xs flex items-center gap-2" disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
        </button>
      </div>

      {data && !data.configured && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-300 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-200">The GitHub App is not configured on this deployment — connections cannot be created until the required Worker secrets are set (docs/GITHUB_RELEASES.md).</p>
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            ['Applications', totals.applications],
            ['Connected', totals.connected],
            ['Not connected', totals.notConnected],
            ['Disconnected', totals.disconnected],
            ['Paid (manual)', totals.paid],
          ].map(([label, value]) => (
            <div key={String(label)} className="card p-4">
              <p className="text-xl font-black text-white leading-none">{value ?? 0}</p>
              <p className="text-[11px] text-rx-gray-medium mt-1">{label}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {([['all', 'All'], ['connected', 'Connected'], ['not', 'Not connected'], ['suspended', 'Suspended']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${filter === id ? 'text-rx-yellow border-rx-yellow/40 bg-rx-yellow/10' : 'text-rx-gray-medium border-white/10 bg-white/5 hover:text-white'}`}>
            {label}
          </button>
        ))}
        <div className="relative ml-auto">
          <Search className="w-3.5 h-3.5 text-rx-gray-medium absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an app…"
            className="bg-rx-dark-tertiary border border-white/10 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white w-52" />
        </div>
      </div>

      {error && <div className="card p-6 text-center text-sm text-red-300">{error}</div>}
      {loading && !data && <div className="card p-8 text-center text-sm text-rx-gray-medium">Loading connections…</div>}

      {data && (
        <div className="space-y-2">
          {rows.length === 0 && <div className="card p-8 text-center text-sm text-rx-gray-medium">No applications match this filter.</div>}
          {rows.map((row) => {
            const state = stateOf(row);
            const c = row.connection;
            return (
              <div key={row.appId} className="card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-white">{row.name}</p>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-rx-gray-medium">{row.slug}</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${state.cls}`}>{state.label}</span>
                  {c && <span className="text-xs text-rx-gray-medium font-mono truncate max-w-[260px]">{c.repository}</span>}
                  <div className="ml-auto flex items-center gap-1.5">
                    {c && c.status === 'active' && (
                      <>
                        <button onClick={() => act(row, 'suspend')} disabled={busy === row.appId}
                          className="text-xs px-2.5 py-1.5 rounded-lg text-amber-300 hover:bg-amber-400/10 flex items-center gap-1.5 disabled:opacity-50">
                          {busy === row.appId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldOff className="w-3.5 h-3.5" />} Suspend
                        </button>
                        <button onClick={() => act(row, 'disconnect')} disabled={busy === row.appId}
                          className="text-xs px-2.5 py-1.5 rounded-lg text-red-300 hover:bg-red-400/10 flex items-center gap-1.5 disabled:opacity-50">
                          <Unlink className="w-3.5 h-3.5" /> Disconnect
                        </button>
                      </>
                    )}
                    {c && c.status !== 'active' && !row.isPaid && (
                      <button onClick={() => act(row, 'reinstate')} disabled={busy === row.appId}
                        className="text-xs px-2.5 py-1.5 rounded-lg text-green-300 hover:bg-green-400/10 flex items-center gap-1.5 disabled:opacity-50">
                        {busy === row.appId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />} Reinstate
                      </button>
                    )}
                    {!c && !row.isPaid && (
                      <a href={`/developers/apps/${encodeURIComponent(row.appId)}`}
                        className="text-xs px-2.5 py-1.5 rounded-lg text-rx-yellow hover:bg-rx-yellow/10 flex items-center gap-1.5">
                        <Link2 className="w-3.5 h-3.5" /> Connect
                      </a>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mt-3 text-[11px]">
                  <div><p className="text-rx-gray-medium">Live version</p><p className="text-white/80">v{row.currentVersion || '—'}</p></div>
                  <div><p className="text-rx-gray-medium">Last event</p><p className="text-white/80 truncate">{c?.lastEvent || '—'}</p></div>
                  <div><p className="text-rx-gray-medium">Last sync</p><p className="text-white/80">{c?.lastSyncAt || '—'}</p></div>
                  <div><p className="text-rx-gray-medium">Latest detected</p><p className="text-white/80">{c?.latestDetectedVersion || row.latestRelease?.version || '—'}</p></div>
                  <div><p className="text-rx-gray-medium">Repository ID</p><p className="text-white/80 font-mono truncate">{c?.repositoryId || '—'}</p></div>
                </div>
                {c?.lastError && <p className="text-[11px] text-amber-300 mt-2">⚠ {c.lastError}</p>}
                {row.isPaid && (
                  <p className="text-[11px] text-rx-gray-medium mt-2">Paid applications publish through the manual admin upload channel only.</p>
                )}
                {c && (
                  <a href={`https://github.com/${c.repository}/releases`} target="_blank" rel="noreferrer"
                    className="text-[11px] text-rx-gray-medium hover:text-rx-yellow mt-2 inline-flex items-center gap-1">
                    Open releases on GitHub <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
