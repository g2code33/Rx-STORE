/**
 * Admin → Community moderation (Phase 20 §7).
 * Reported discussions/replies: view, hide / restore / remove with a REQUIRED
 * reason (audited; rows never silently deleted), report handling.
 */
import React, { useEffect, useState } from 'react';
import { EyeOff, RotateCw, Trash2, Flag } from 'lucide-react';
import { api } from '../../services/api';
import { formatDate } from '../../utils/helpers';
import toast from 'react-hot-toast';

export default function CommunityModerationPanel() {
  const [reports, setReports] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<Record<string, string>>({});

  const load = () => {
    setLoading(true);
    api.adminCommunity.reports('open').then((d: any) => setReports(d.reports || [])).catch(() => setReports([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const moderate = async (targetType: 'discussion' | 'reply', targetId: string, action: 'hide' | 'restore' | 'remove') => {
    const why = (reason[`${targetType}:${targetId}`] || '').trim();
    if (why.length < 10) { toast.error('A moderation reason of at least 10 characters is required.'); return; }
    setBusy(true);
    try {
      await api.adminCommunity.moderate(targetType, targetId, action, why);
      toast.success(`${targetType} ${action === 'restore' ? 'restored' : action === 'hide' ? 'hidden' : 'removed'}`);
      setReason((r) => ({ ...r, [`${targetType}:${targetId}`]: '' }));
      load();
    } catch (e: any) { toast.error(e?.message || 'Moderation failed'); }
    setBusy(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Community</h2>
        <p className="text-sm text-rx-gray-medium mt-1">Reported public community content. Hiding or removing never deletes the row — the action and reason are recorded in the audit history.</p>
      </div>

      {loading ? (
        <div className="card p-8 animate-pulse space-y-3"><div className="h-5 bg-white/5 rounded w-1/3" /><div className="h-20 bg-white/5 rounded" /></div>
      ) : reports.length === 0 ? (
        <div className="card p-8 text-center text-sm text-rx-gray-medium">No open reports. 🎉</div>
      ) : (
        <div className="space-y-4">
          {reports.map((rep) => {
            const key = `${rep.target_type}:${rep.target_id}`;
            return (
              <div key={rep.report_id} className="card p-5 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-xs font-bold uppercase tracking-wider text-rx-yellow flex items-center gap-1.5">
                    <Flag className="w-3.5 h-3.5" /> {String(rep.reason).replace(/_/g, ' ')}
                  </p>
                  <p className="text-xs text-rx-gray-medium">
                    {rep.target_type} · reported by {rep.reporter_name || 'member'} · {formatDate(rep.reported_at)}
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-rx-dark-tertiary/60 border border-white/5">
                  <p className="text-[10px] text-rx-gray-medium/70 mb-1">by {rep.author_name || 'member'} · status: {rep.target_status}</p>
                  <p className="text-sm text-rx-gray-medium leading-relaxed">{rep.target_preview}</p>
                </div>
                <input
                  className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2 text-sm text-white"
                  placeholder="Moderation reason (required, min 10 characters — recorded in the audit history)…"
                  value={reason[key] || ''}
                  onChange={(e) => setReason((r) => ({ ...r, [key]: e.target.value }))}
                />
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => moderate(rep.target_type, rep.target_id, 'hide')} disabled={busy} className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-40"><EyeOff className="w-4 h-4" /> Hide</button>
                  <button onClick={() => moderate(rep.target_type, rep.target_id, 'remove')} disabled={busy} className="text-sm flex items-center gap-2 px-4 py-2 rounded-xl bg-red-400/10 text-red-400 border border-red-400/20 hover:bg-red-400/20 disabled:opacity-40"><Trash2 className="w-4 h-4" /> Remove</button>
                  <button onClick={() => moderate(rep.target_type, rep.target_id, 'restore')} disabled={busy} className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-40"><RotateCw className="w-4 h-4" /> Dismiss & keep visible</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
