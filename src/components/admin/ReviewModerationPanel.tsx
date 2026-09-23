/**
 * Admin → Reviews moderation (Phase 17).
 * The reported-review queue: view the report + the full review, then
 * Hide / Restore / Remove with a REQUIRED reason (recorded in the audit
 * history; review rows are never silently deleted).
 */
import React, { useEffect, useState } from 'react';
import { EyeOff, RotateCw, Trash2, Flag, Star } from 'lucide-react';
import { api } from '../../services/api';
import { formatDate } from '../../utils/helpers';
import toast from 'react-hot-toast';

const REASON_LABELS: Record<string, string> = {
  spam: 'Spam', harassment: 'Harassment', irrelevant: 'Irrelevant',
  fraudulent: 'Fraudulent', malicious_content: 'Malicious content', other: 'Other',
};

export default function ReviewModerationPanel() {
  const [reports, setReports] = useState<any[]>([]);
  const [hidden, setHidden] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<Record<string, string>>({});

  const load = () => {
    setLoading(true);
    Promise.all([
      api.adminReviews.reports('open').catch(() => ({ reports: [] })),
      api.adminReviews.reviews('hidden').catch(() => ({ reviews: [] })),
    ]).then(([r, h]: any[]) => {
      setReports(r.reports || []);
      setHidden(h.reviews || []);
    }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const moderate = async (reviewId: string, action: 'hide' | 'restore' | 'remove') => {
    const why = (reason[reviewId] || '').trim();
    if (why.length < 10) { toast.error('A moderation reason of at least 10 characters is required (it is recorded in the audit history).'); return; }
    setBusy(true);
    try {
      await api.adminReviews.moderate(reviewId, action, why);
      toast.success(`Review ${action === 'restore' ? 'restored' : action === 'hide' ? 'hidden' : 'removed'}`);
      setReason((r) => ({ ...r, [reviewId]: '' }));
      load();
    } catch (e: any) { toast.error(e?.message || 'Moderation failed'); }
    setBusy(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Reviews</h2>
        <p className="text-sm text-rx-gray-medium mt-1">Reported reviews awaiting moderation. Hiding or removing never deletes the review — the action and reason are recorded in the audit history.</p>
      </div>

      {loading ? (
        <div className="card p-8 animate-pulse space-y-3"><div className="h-5 bg-white/5 rounded w-1/3" /><div className="h-20 bg-white/5 rounded" /></div>
      ) : reports.length === 0 ? (
        <div className="card p-8 text-center text-sm text-rx-gray-medium">No open reports. 🎉</div>
      ) : (
        <div className="space-y-4">
          {reports.map((rep) => (
            <div key={rep.report_id} className="card p-5 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-xs font-bold uppercase tracking-wider text-rx-yellow flex items-center gap-1.5">
                  <Flag className="w-3.5 h-3.5" /> {REASON_LABELS[rep.reason] || rep.reason}
                </p>
                <p className="text-xs text-rx-gray-medium">
                  {rep.app_name} · reported by {rep.reporter_name || rep.reporter_user_id} · {formatDate(rep.reported_at)}
                </p>
              </div>

              {/* The reported review */}
              <div className="p-4 rounded-xl bg-rx-dark-tertiary/60 border border-white/5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-white">{rep.author_name || 'User'} {rep.title ? `— “${rep.title}”` : ''}</p>
                  <span className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((s) => <Star key={s} className={`w-3 h-3 ${s <= rep.rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-600'}`} />)}
                  </span>
                </div>
                <p className="text-sm text-rx-gray-medium mt-1.5 leading-relaxed">{rep.body}</p>
                <p className="text-[10px] text-rx-gray-medium/60 mt-1.5">
                  written {formatDate(rep.review_created_at)}{rep.app_version ? ` · v${rep.app_version}` : ''} · status: {rep.review_status}
                </p>
                {rep.details && <p className="text-xs text-rx-gray-medium mt-2">Reporter note: {rep.details}</p>}
              </div>

              <input
                className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2 text-sm text-white"
                placeholder="Moderation reason (required, min 10 characters — recorded in the audit history)…"
                value={reason[rep.review_id] || ''}
                onChange={(e) => setReason((r) => ({ ...r, [rep.review_id]: e.target.value }))}
              />
              <div className="flex flex-wrap gap-2">
                <button onClick={() => moderate(rep.review_id, 'hide')} disabled={busy}
                  className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-40"><EyeOff className="w-4 h-4" /> Hide review</button>
                <button onClick={() => moderate(rep.review_id, 'remove')} disabled={busy}
                  className="text-sm flex items-center gap-2 px-4 py-2 rounded-xl bg-red-400/10 text-red-400 border border-red-400/20 hover:bg-red-400/20 disabled:opacity-40"><Trash2 className="w-4 h-4" /> Remove review</button>
                <button onClick={() => moderate(rep.review_id, 'restore')} disabled={busy}
                  className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-40"><RotateCw className="w-4 h-4" /> Dismiss report & keep visible</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Currently hidden reviews (restorable) */}
      {hidden.length > 0 && (
        <div className="card p-5">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-3">Hidden reviews ({hidden.length})</h3>
          <div className="space-y-2">
            {hidden.map((r) => (
              <div key={r.id} className="flex items-center gap-3 p-3 rounded-xl bg-rx-dark-tertiary/60 border border-white/5 flex-wrap">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{r.user_name || 'User'} — “{(r.comment || '').slice(0, 80)}”</p>
                  <p className="text-xs text-rx-gray-medium">{r.app_name} · hidden {formatDate(r.moderated_at)} · reason: {r.moderation_reason}</p>
                </div>
                <button onClick={() => moderate(r.id, 'restore')} disabled={busy} className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-40"><RotateCw className="w-3.5 h-3.5" /> Restore</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
