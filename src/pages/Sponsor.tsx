import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { BarChart3, Eye, MousePointerClick, Percent, ArrowLeft } from 'lucide-react';
import { fetchSponsorStats, SponsorStats } from '../components/home/introAds';

/**
 * Sponsor self-serve dashboard — opened from a link the admin mints
 * (Builder → Ads → Sponsor link). Token-gated, read-only, no login needed.
 */
export default function Sponsor() {
  const { token = '' } = useParams();
  const [state, setState] = React.useState<'loading' | 'error' | 'ready'>('loading');
  const [stats, setStats] = React.useState<SponsorStats | null>(null);

  React.useEffect(() => {
    let stop = false;
    (async () => {
      const s = await fetchSponsorStats(token);
      if (stop) return;
      if (!s) setState('error');
      else { setStats(s); setState('ready'); }
    })();
    return () => { stop = true; };
  }, [token]);

  const maxViews = Math.max(1, ...(stats?.daily || []).map((d) => d.views));
  const maxClicks = Math.max(1, ...(stats?.daily || []).map((d) => d.clicks));

  return (
    <div className="section-container py-10 lg:py-14 max-w-3xl">
      <div className="flex items-center gap-3 mb-8">
        <img src="/v1.png" alt="RX Store" className="w-12 h-12 rounded-2xl object-cover" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-rx-yellow">Sponsor dashboard</p>
          <h1 className="text-xl sm:text-2xl font-bold text-white truncate">{stats?.label || 'Your campaign'}</h1>
        </div>
      </div>

      {state === 'loading' && (
        <div className="card p-10 text-center text-rx-gray-medium text-sm animate-pulse">Loading your live stats…</div>
      )}

      {state === 'error' && (
        <div className="card p-10 text-center">
          <div className="text-4xl mb-3">🔗</div>
          <h2 className="text-lg font-bold text-white mb-2">This sponsor link is not active</h2>
          <p className="text-sm text-rx-gray-medium mb-6">It may have been revoked or mistyped. Ask the RX Store team for a fresh link.</p>
          <Link to="/" className="btn-primary inline-flex items-center gap-2"><ArrowLeft className="w-4 h-4" /> Back to RX Store</Link>
        </div>
      )}

      {state === 'ready' && stats && (
        <>
          <div className="grid grid-cols-3 gap-3 sm:gap-4 mb-6">
            <div className="card p-4 sm:p-5 text-center">
              <Eye className="w-5 h-5 text-rx-yellow mx-auto mb-2" />
              <p className="text-2xl sm:text-3xl font-bold text-white">{stats.views.toLocaleString()}</p>
              <p className="text-[11px] uppercase tracking-wider text-rx-gray-medium mt-1">Views</p>
            </div>
            <div className="card p-4 sm:p-5 text-center">
              <MousePointerClick className="w-5 h-5 text-rx-yellow mx-auto mb-2" />
              <p className="text-2xl sm:text-3xl font-bold text-white">{stats.clicks.toLocaleString()}</p>
              <p className="text-[11px] uppercase tracking-wider text-rx-gray-medium mt-1">Clicks</p>
            </div>
            <div className="card p-4 sm:p-5 text-center">
              <Percent className="w-5 h-5 text-rx-yellow mx-auto mb-2" />
              <p className="text-2xl sm:text-3xl font-bold text-white">{stats.ctr}%</p>
              <p className="text-[11px] uppercase tracking-wider text-rx-gray-medium mt-1">Click-through</p>
            </div>
          </div>

          <div className="card p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 className="w-4 h-4 text-rx-yellow" />
              <h2 className="text-sm font-bold text-white">Last {stats.daily.length || 30} days</h2>
              <span className="ml-auto text-[10px] text-rx-gray-medium">views (yellow) · clicks (white)</span>
            </div>
            {stats.daily.length === 0 ? (
              <p className="text-sm text-rx-gray-medium text-center py-8">No traffic recorded yet — stats appear the moment your first ad shows.</p>
            ) : (
              <div className="flex items-end gap-[3px] h-32">
                {stats.daily.map((d) => (
                  <div key={d.day} className="flex-1 flex items-end justify-center gap-[2px] min-w-0" title={`${d.day}: ${d.views} views · ${d.clicks} clicks`}>
                    <div className="w-2.5 rounded-t-sm bg-rx-yellow/90" style={{ height: `${Math.max(2, (d.views / maxViews) * 100)}%` }} />
                    <div className="w-1.5 rounded-t-sm bg-white/70" style={{ height: `${Math.max(1, (d.clicks / maxClicks) * 100)}%` }} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="text-center text-xs text-rx-gray-medium mt-8">
            Live analytics for your RX Store sponsorship · updates automatically
            {stats.createdAt ? ` · tracking since ${String(stats.createdAt).slice(0, 10)}` : ''}
          </p>
        </>
      )}
    </div>
  );
}
