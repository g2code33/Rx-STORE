/**
 * Admin — awareness feed.
 *
 * Every meaningful event in RX Store raises an `admin_events` row tagged with
 * the Admin sidebar section it belongs to. This panel lists them with unread
 * highlighting, filters, deep links to the right tab and "mark all read" —
 * the same rows that drive the numbered badges on the sidebar.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Bell, CheckCheck, ExternalLink, Loader2, RefreshCw, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../services/api';

type Props = {
  counts: { total: number; bySection: Record<string, number> };
  onChanged?: () => void;
};

const SECTIONS = [
  '', 'applications', 'releases', 'users', 'inbox', 'payments', 'community',
  'reviews', 'developers', 'github', 'security', 'storefront',
];

const TYPE_STYLE: Record<string, { cls: string; icon: React.ReactNode }> = {
  action_required: { cls: 'text-rx-yellow', icon: <Bell className="w-4 h-4" /> },
  warning: { cls: 'text-amber-300', icon: <AlertTriangle className="w-4 h-4" /> },
  error: { cls: 'text-red-300', icon: <AlertTriangle className="w-4 h-4" /> },
  success: { cls: 'text-green-300', icon: <CheckCircle2 className="w-4 h-4" /> },
  info: { cls: 'text-rx-gray-medium', icon: <Info className="w-4 h-4" /> },
};

export default function AdminNotificationsPanel({ counts, onChanged }: Props) {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [section, setSection] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await api.adminNotifications.list({ section: section || undefined, unread: unreadOnly });
      setEvents(r.events || []);
    } catch (e: any) {
      setError(e?.message || 'Could not load notifications.');
    } finally { setLoading(false); }
  }, [section, unreadOnly]);

  useEffect(() => { load(); }, [load]);

  const markAll = async () => {
    setBusy(true);
    try {
      const r = await api.adminNotifications.seen('all');
      toast.success(r.changed ? `${r.changed} notification${r.changed === 1 ? '' : 's'} marked read.` : 'Nothing unread.');
      load(); onChanged?.();
    } catch (e: any) { toast.error(e?.message || 'Could not mark notifications read.'); }
    finally { setBusy(false); }
  };

  const markOneSection = async (sec: string) => {
    setBusy(true);
    try {
      const r = await api.adminNotifications.seen(sec);
      toast.success(r.changed ? `${sec}: ${r.changed} marked read.` : `${sec}: nothing unread.`);
      load(); onChanged?.();
    } finally { setBusy(false); }
  };

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-rx-dark-tertiary flex items-center justify-center"><Bell className="w-4 h-4 text-rx-yellow" /></div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-bold text-white">Notifications</h2>
          <p className="text-xs text-rx-gray-medium">Everything that needs your attention, grouped by the tab it belongs to.</p>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${counts.total ? 'bg-rx-yellow text-rx-dark' : 'bg-white/10 text-rx-gray-medium'}`}>
          {counts.total} unread
        </span>
        <button onClick={load} className="btn-secondary text-xs flex items-center gap-1.5" disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
        </button>
        <button onClick={markAll} disabled={busy || counts.total === 0} className="btn-primary text-xs flex items-center gap-1.5 disabled:opacity-40">
          <CheckCheck className="w-3.5 h-3.5" /> Mark all read
        </button>
      </div>

      {/* Section chips (their numbers = unread in that tab) */}
      <div className="flex flex-wrap gap-1.5 mt-4">
        {SECTIONS.map((sec) => {
          const n = sec ? (counts.bySection[sec] || 0) : counts.total;
          return (
            <button
              key={sec || 'all'}
              onClick={() => { setSection(sec); setUnreadOnly(false); }}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${section === sec ? 'text-rx-yellow border-rx-yellow/40 bg-rx-yellow/10' : 'text-rx-gray-medium border-white/10 bg-white/5 hover:text-white'}`}
            >
              {sec || 'all'}{n ? <span className="ml-1.5 px-1.5 py-0.5 rounded bg-rx-yellow text-rx-dark text-[10px] font-bold">{n > 99 ? '99+' : n}</span> : null}
            </button>
          );
        })}
        <label className="flex items-center gap-2 text-xs text-rx-gray-medium ml-1">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} className="accent-rx-yellow" /> unread only
        </label>
        {section && (
          <button onClick={() => markOneSection(section)} disabled={busy} className="text-xs text-rx-yellow hover:underline ml-auto">
            Mark “{section}” read
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-300 mt-4">{error}</p>}
      {!error && !loading && events.length === 0 && (
        <p className="text-sm text-rx-gray-medium mt-6 text-center">Nothing here yet — new activity (signups, submissions, payments, reviews, GitHub releases…) appears automatically.</p>
      )}

      <div className="mt-4 divide-y divide-white/5">
        {events.map((e) => {
          const style = TYPE_STYLE[e.type] || TYPE_STYLE.info;
          const unread = !e.read_at;
          return (
            <div key={e.id} className={`py-3 flex items-start gap-3 ${unread ? '' : 'opacity-60'}`}>
              <span className={`mt-0.5 ${style.cls}`}>{style.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white font-medium">
                  {e.title}
                  {unread && <span className="ml-2 inline-block w-1.5 h-1.5 rounded-full bg-rx-yellow align-middle" />}
                </p>
                {e.message && <p className="text-xs text-rx-gray-medium mt-0.5 break-words">{e.message}</p>}
                <p className="text-[10px] text-rx-gray-medium/70 mt-1">
                  <span className="uppercase tracking-wide">{e.section}</span> · {e.created_at}
                </p>
              </div>
              {e.link && (
                <a href={e.link} className="text-xs text-rx-yellow hover:underline flex items-center gap-1 shrink-0">
                  Open <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
