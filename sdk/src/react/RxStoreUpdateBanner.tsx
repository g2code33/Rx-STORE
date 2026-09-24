/**
 * <RxStoreUpdateBanner /> — OPTIONAL React integration for @rx-store/sdk.
 *
 * The SDK core has NO React dependency; this subpath exists only for hosts
 * that want a ready-made, accessible, responsive update banner. The component
 * never downloads or installs anything — the single action hands the user to
 * RX Store (deep link, HTTPS fallback) where the existing install/update
 * pipeline takes over.
 *
 * Usage:
 *   const sdk = createRxStoreSDK({ appId: 'pharmatrack', currentVersion: APP_VERSION });
 *   <RxStoreUpdateBanner sdk={sdk} />
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { deriveBannerState, type DismissedState } from '../core/banner.ts';
import type { RxStoreSDK, UpdateCheckResult } from '../core/types.ts';

export interface RxStoreUpdateBannerProps {
  /** A configured (and ideally initialize()d) SDK instance. */
  sdk: RxStoreSDK;
  /** Called after the user taps the update action (analytics etc.). */
  onUpdateOpen?: () => void;
  /** Override the container class (default: a fixed bottom banner). */
  className?: string;
  /** Re-check now (the banner's retry action). */
  onRetry?: () => void;
}

const baseStyle: React.CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 9999,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '10px 16px',
  padding: '12px 16px',
  paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
  background: 'rgba(17, 24, 39, 0.97)',
  color: '#f9fafb',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontSize: 14,
  lineHeight: 1.45,
  boxShadow: '0 -4px 24px rgba(0,0,0,0.35)',
  borderTop: '1px solid rgba(255,255,255,0.12)',
};

const buttonStyle: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 10,
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
  border: 'none',
};

export function RxStoreUpdateBanner({ sdk, onUpdateOpen, className, onRetry }: RxStoreUpdateBannerProps) {
  const [check, setCheck] = useState<UpdateCheckResult | null>(null);
  const [dismissed, setDismissed] = useState<DismissedState>({ version: null });
  const [busy, setBusy] = useState(false);

  const runCheck = useCallback(
    () => { void sdk.checkForUpdate({ force: true }).then(setCheck).catch(() => setCheck({ status: 'NETWORK_ERROR', error: 'check failed' })); },
    [sdk],
  );

  useEffect(() => {
    // Initial state: cached/last result, then a fresh check.
    let alive = true;
    void sdk.checkForUpdate().then((r) => { if (alive) setCheck(r); }).catch(() => undefined);
    const t = setInterval(() => {
      void sdk.checkForUpdate().then((r) => { if (alive) setCheck(r); }).catch(() => undefined);
    }, 60_000); // gentle re-eval of the (cached) SDK state
    return () => { alive = false; clearInterval(t); };
  }, [sdk]);

  const state = useMemo(() => deriveBannerState(check, dismissed), [check, dismissed]);

  const handleUpdate = useCallback(() => {
    onUpdateOpen?.();
    sdk.openUpdateInRxStore();
  }, [sdk, onUpdateOpen]);

  const handleDismiss = useCallback(() => {
    if (check?.update) setDismissed({ version: check.update.latestVersion });
  }, [check]);

  const handleRetry = useCallback(() => {
    if (onRetry) return onRetry();
    setBusy(true);
    runCheck();
    setTimeout(() => setBusy(false), 800);
  }, [onRetry, runCheck]);

  if (state.kind === 'hidden' || state.kind === 'loading') return null;

  if (state.kind === 'error') {
    if (!state.retryable) return null;
    return (
      <div className={className} style={baseStyle} role="status" aria-live="polite">
        <span>Couldn’t check for RX Store updates.</span>
        <button type="button" style={{ ...buttonStyle, background: '#ffffff22', color: 'inherit' }} onClick={handleRetry} disabled={busy}>
          {busy ? 'Checking…' : 'Try again'}
        </button>
      </div>
    );
  }

  const { update } = state;
  const mandatory = state.kind === 'mandatory';
  const notes = update.releaseNotes.slice(0, 3);

  return (
    <div
      className={className}
      style={{ ...baseStyle, ...(mandatory ? { background: 'rgba(120, 53, 15, 0.97)', borderTop: '1px solid rgba(251, 191, 36, 0.5)' } : {}) }}
      role={mandatory ? 'alertdialog' : 'status'}
      aria-live="polite"
      aria-label="RX Store update available"
    >
      <div style={{ minWidth: 0, flex: '1 1 260px', textAlign: 'center' }}>
        <strong style={{ display: 'block' }}>
          {mandatory ? 'Required update' : 'RX Store update'}
        </strong>
        <span>
          {update.appName || 'This app'} v{update.latestVersion} is available.
          {mandatory
            ? ' Updating through RX Store is required to keep using this app.'
            : ' Open RX Store to update securely.'}
        </span>
        {notes.length > 0 && (
          <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none', opacity: 0.85, fontSize: 13 }}>
            {notes.map((n, i) => <li key={i} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>• {n}</li>)}
          </ul>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          style={{ ...buttonStyle, background: '#fbbf24', color: '#111827' }}
          onClick={handleUpdate}
          autoFocus
        >
          Update via RX Store
        </button>
        {!mandatory && (
          <button
            type="button"
            style={{ ...buttonStyle, background: 'transparent', color: 'inherit', border: '1px solid rgba(255,255,255,0.3)' }}
            onClick={handleDismiss}
          >
            Later
          </button>
        )}
      </div>
    </div>
  );
}

export default RxStoreUpdateBanner;
