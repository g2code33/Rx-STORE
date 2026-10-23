/**
 * RX Store — live download card (progress + pause / resume / cancel).
 *
 * Replaces the old behaviour where clicking Update fired a transient "Downloading
 * the package…" toast per state transition: on a 130MB installer that meant a
 * stack of identical toasts, no percentage, and no way to stop it.
 *
 * It renders what the transaction actually reports — bytes, percent, a smoothed
 * transfer rate and the elapsed time — and only the controls the current
 * platform really supports (see src/native/downloadControls.ts).
 */
import React from 'react';
import { Download, Pause, Play, X, Loader2, Check, AlertTriangle } from 'lucide-react';
import { etaSeconds, formatBytes, formatDuration, transferRate } from '../../native/downloadProgress.ts';

export interface DownloadCardProps {
  state: string;
  /** received bytes */
  received: number;
  /** total bytes (0 when unknown) */
  total: number;
  percent: number;
  paused?: boolean;
  /** App name + version, for the heading. */
  appName?: string;
  version?: string;
  fileName?: string;
  /** Platform-appropriate file label (Linux (DEB), Windows…). */
  platformLabel?: string;
  controls: { pause: boolean; resume: boolean; cancel: boolean };
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  /** Retry after a failure/cancel. */
  onRetry?: () => void;
  error?: string;
  /**
   * 'panel'  — the prominent in-page surface (full width, big buttons).
   * 'compact' — the small indicator beside the Get/Update button.
   */
  variant?: 'panel' | 'compact';
}

const FAILED = ['DOWNLOAD_FAILED', 'VERIFICATION_FAILED', 'INSTALL_FAILED', 'INSTALLATION_NOT_DETECTED', 'CANCELLED'];

export default function DownloadCard(props: DownloadCardProps) {
  const {
    state, received, total, percent, paused, appName, version, fileName, platformLabel,
    controls, busy, onPause, onResume, onCancel, onRetry, error,
    variant = 'compact',
  } = props;

  // Rate sampling (one sample per 500ms is plenty and keeps re-renders cheap).
  const [rate, setRate] = React.useState(0);
  const sampleRef = React.useRef<{ at: number; received: number } | null>(null);
  React.useEffect(() => {
    if (!busy || state !== 'DOWNLOADING' || paused) return;
    const id = setInterval(() => {
      const now = { at: Date.now(), received };
      const r = transferRate(sampleRef.current, now);
      if (r > 0) setRate(r);
      sampleRef.current = now;
    }, 500);
    return () => clearInterval(id);
  }, [busy, state, paused, received]);
  React.useEffect(() => {
    if (!busy) { setRate(0); sampleRef.current = null; }
  }, [busy]);

  const failed = FAILED.includes(state);
  const downloading = state === 'DOWNLOAD_STARTED' || state === 'DOWNLOADING';
  const installing = ['DOWNLOAD_COMPLETED', 'VERIFYING', 'VERIFIED', 'INSTALLER_STARTED', 'INSTALLATION_PENDING', 'VERIFYING_INSTALLATION'].includes(state);

  const panel = variant === 'panel';

  if (!busy && !failed) {
    // The PANEL is a permanent part of the app page (that is where Get/Update/
    // Open live); it states what it will do instead of silently disappearing.
    if (!panel) return null;
    return (
      <div className="card p-4 w-full" aria-label="Downloads">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0">
            <Download className="w-4 h-4 text-rx-gray-medium" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">Downloads &amp; updates</p>
            <p className="text-[11px] text-rx-gray-medium">
              Nothing in progress. Press Update (or Get) to start — progress, pause, resume and cancel appear here.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const eta = etaSeconds(received, total, rate);

  return (
    <div
      className={`card ${panel ? 'p-5 w-full' : 'p-4'} ${failed ? 'border-red-500/20' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={panel ? 'Download' : undefined}
    >
      <div className="flex items-start gap-3">
        <div className={`${panel ? 'w-11 h-11' : 'w-9 h-9'} rounded-xl flex items-center justify-center flex-shrink-0 ${failed ? 'bg-red-500/10 text-red-400' : 'bg-rx-yellow/10 text-rx-yellow'}`}>
          {failed ? <AlertTriangle className={panel ? 'w-5 h-5' : 'w-4 h-4'} />
            : installing ? <Loader2 className={`${panel ? 'w-5 h-5' : 'w-4 h-4'} animate-spin`} />
              : <Download className={panel ? 'w-5 h-5' : 'w-4 h-4'} />}
        </div>

        <div className="flex-1 min-w-0">
          <p className={`${panel ? 'text-base' : 'text-sm'} font-semibold text-white truncate`}>
            {failed
              ? (state === 'CANCELLED' ? 'Download cancelled' : 'Download failed')
              : paused
                ? `Download paused — ${appName || 'update'}`
                : installing
                  ? `Finishing ${appName || ''} v${version || ''}`
                  : `Downloading ${appName || ''} v${version || ''}`}
          </p>
          <p className={`${panel ? 'text-xs' : 'text-[11px]'} text-rx-gray-medium truncate`}>
            {failed
              ? (error || 'You can retry any time — nothing was installed.')
              : installing
                ? 'Download complete — verifying and opening the installer.'
                : <>{fileName || 'package'}{platformLabel ? ` · ${platformLabel}` : ''}</>}
          </p>

          {!failed && (
            <>
              <div className={`mt-2 ${panel ? 'h-2.5' : 'h-1.5'} rounded-full bg-white/10 overflow-hidden`}>
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ease-out ${paused ? 'bg-rx-gray-medium' : 'bg-rx-yellow'}`}
                  style={{ width: `${installing ? 100 : pct}%` }}
                />
              </div>
              <div className={`mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 ${panel ? 'text-xs' : 'text-[11px]'} text-rx-gray-medium tabular-nums`}>
                <span className="text-white/80 font-medium">{installing ? '100%' : `${pct}%`}</span>
                <span>
                  {formatBytes(received)}{total > 0 ? ` of ${formatBytes(total)}` : ''}
                </span>
                {downloading && !paused && rate > 0 && <span>{formatBytes(rate)}/s</span>}
                {downloading && !paused && eta != null && <span>{formatDuration(eta)} left</span>}
                {paused && <span className="text-amber-300">Paused</span>}
              </div>
            </>
          )}
        </div>

        {/* Controls — ONLY the ones this platform actually supports. */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {downloading && !failed && (
            <>
              {paused
                ? controls.resume && (
                  <button onClick={onResume} title="Resume download"
                    className={`rounded-lg bg-rx-yellow text-[#0f1419] font-bold flex items-center gap-1 hover:bg-rx-yellow-light ${panel ? 'px-4 py-2 text-sm' : 'px-2.5 py-1.5 text-[11px]'}`}>
                    <Play className={panel ? 'w-4 h-4' : 'w-3 h-3'} /> Resume
                  </button>
                )
                : controls.pause && (
                  <button onClick={onPause} title="Pause download"
                    className={`rounded-lg bg-white/10 text-white font-semibold flex items-center gap-1 hover:bg-white/20 ${panel ? 'px-4 py-2 text-sm' : 'px-2.5 py-1.5 text-[11px]'}`}>
                    <Pause className={panel ? 'w-4 h-4' : 'w-3 h-3'} /> Pause
                  </button>
                )}
              {controls.cancel && (
                <button onClick={onCancel} title="Cancel download"
                  className={`rounded-lg bg-white/5 text-red-400 hover:bg-red-400/10 flex items-center gap-1 ${panel ? 'px-3 py-2 text-sm' : 'p-1.5'}`} aria-label="Cancel download">
                  <X className={panel ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
                  {panel && 'Cancel'}
                </button>
              )}
            </>
          )}
          {failed && onRetry && (
            <button onClick={onRetry} className={`rounded-lg bg-rx-yellow text-[#0f1419] font-bold hover:bg-rx-yellow-light ${panel ? 'px-4 py-2 text-sm' : 'px-3 py-1.5 text-[11px]'}`}>
              Retry
            </button>
          )}
          {installing && (
            <span className="text-green-400 flex items-center gap-1 text-[11px]"><Check className="w-3.5 h-3.5" /> 100%</span>
          )}
        </div>
      </div>

      {/* Honest note where the OS owns the transfer. */}
      {downloading && !paused && !controls.pause && !controls.cancel && (
        <p className={`text-rx-gray-medium mt-2 ${panel ? 'text-[11px] pl-14' : 'text-[10px] pl-12'}`}>
          Your device's download manager is handling this transfer — use its notification to manage it.
        </p>
      )}
    </div>
  );
}
