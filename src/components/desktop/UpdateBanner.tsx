import { useState } from 'react';
import { RefreshCw, Rocket, X, AlertTriangle, ExternalLink, Pause, Play } from 'lucide-react';
import { useUpdateStatus, installNow, checkNow, isDesktopApp, pauseUpdate, resumeUpdate } from '../../desktop/updater';

const mb = (b?: number) => (typeof b === 'number' && b > 0 ? `${(b / 1048576).toFixed(1)} MB` : '');

/**
 * Global update banner for the desktop shell. Stays silent on the website
 * (`window.rxDesktop` only exists inside Electron) and during the hourly
 * background checks — it only appears when there's something worth acting on:
 * a download in flight, an update ready to install, or a failed manual check.
 */
export default function UpdateBanner() {
  const s = useUpdateStatus();
  const [dismissedAt, setDismissedAt] = useState(0);

  if (!isDesktopApp()) return null;
  if (!s.banner || s.at <= dismissedAt) return null;

  const downloading = s.phase === 'downloading';
  const paused = s.phase === 'paused';
  const busy = s.phase === 'available' || downloading;
  const ready = s.phase === 'downloaded';
  const failed = s.phase === 'error';
  if (!busy && !paused && !ready && !failed) return null;

  const v = s.version ? ` v${s.version}` : '';
  const title = failed ? 'Update check failed' : paused ? `Update${v} paused` : ready ? `Update${v} ready` : `Updating to${v}…`;
  const sub = failed
    ? s.message || 'Something went wrong while checking.'
    : paused
      ? 'Download is paused. Resume when your connection is ready.'
    : ready
      ? 'Restart RX Store to finish installing. Your apps and data carry over.'
      : downloading
        ? `${s.percent ?? 0}%${s.total ? ` · ${mb(s.transferred)} of ${mb(s.total)}` : ''}`
        : 'Downloading in the background…';

  return (
    <div className="fixed right-3 sm:right-6 z-[60] w-[calc(100%-1.5rem)] max-w-sm animate-fade-in" style={{ top: 'calc(var(--rx-header-h, 5rem) + 0.75rem)' }}>
      <div className="card p-4 shadow-2xl shadow-black/60 border-rx-yellow/25">
        <div className="flex items-start gap-3">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
              failed ? 'bg-red-500/15 text-red-400' : ready ? 'bg-green-500/15 text-green-400' : 'bg-rx-yellow/15 text-rx-yellow'
            }`}
          >
            {failed ? (
              <AlertTriangle className="w-4 h-4" />
            ) : ready ? (
              <Rocket className="w-4 h-4" />
            ) : (
              <RefreshCw className="w-4 h-4 animate-spin" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{title}</p>
            <p className="text-xs text-rx-gray-medium mt-0.5">{sub}</p>
          </div>
          {(ready || failed) && (
            <button
              onClick={() => setDismissedAt(Date.now())}
              className="text-rx-gray-medium hover:text-white transition-colors p-1 -m-1"
              aria-label="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {downloading && (
          <div className="mt-3 h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div className="h-full bg-rx-yellow rounded-full transition-all duration-500" style={{ width: `${s.percent ?? 0}%` }} />
          </div>
        )}

        {(downloading || paused) && (
          <div className="mt-3">
            {paused ? (
              <button onClick={() => resumeUpdate()} className="btn-primary !py-2 !px-4 text-xs flex items-center gap-1.5"><Play className="w-3.5 h-3.5"/> Resume</button>
            ) : (
              <button onClick={() => pauseUpdate()} className="px-4 py-2 rounded-xl bg-white/10 text-white text-xs flex items-center gap-1.5 hover:bg-white/15"><Pause className="w-3.5 h-3.5"/> Pause</button>
            )}
          </div>
        )}

        {ready && (
          <div className="mt-3 flex items-center gap-2">
            <button onClick={() => installNow()} className="btn-primary !py-2 !px-4 text-xs font-semibold">
              Restart & update
            </button>
            <button
              onClick={() => setDismissedAt(Date.now())}
              className="px-3 py-2 text-xs font-medium text-rx-gray-medium hover:text-white rounded-xl hover:bg-white/5 transition-all"
            >
              On next launch
            </button>
            <a
              href="https://github.com/g2code33/Rx-STORE/releases/latest"
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-xs text-rx-yellow hover:underline"
            >
              What's new <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}

        {failed && (
          <div className="mt-3 flex items-center gap-2">
            <button onClick={() => checkNow()} className="btn-primary !py-2 !px-4 text-xs font-semibold">
              Try again
            </button>
            <button
              onClick={() => setDismissedAt(Date.now())}
              className="px-3 py-2 text-xs font-medium text-rx-gray-medium hover:text-white rounded-xl hover:bg-white/5 transition-all"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
