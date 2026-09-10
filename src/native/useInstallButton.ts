/**
 * RX Store — hook that combines the active transaction + current-device
 * detection into a single InstallButton for a component to render.
 *
 * This is the single place AppCard / AppDetail read the button state from, so
 * they never build conflicting states themselves.
 */
import { useCallback, useMemo } from 'react';
import type { App } from '../types';
import { useInstallTransaction } from './useInstallTransaction';
import { useInstalledState } from '../platform/nativeDetection';
import { installButtonFor, type InstallButton } from './installUi';
import { mapDetectionToInstall } from '../platform/detect';

export interface UseInstallButtonResult {
  /** The exact button state/label/action to render. */
  button: InstallButton;
  /** Current-device detected install state. */
  installState: ReturnType<typeof mapDetectionToInstall>;
  /** True when a pipeline (download/verify/install) is actively running. */
  isBusy: boolean;
  /** Reset the active transaction (e.g. after a retry or install). */
  reset: () => void;
  /** Re-run the pipeline for a resolved package (GET or UPDATE). */
  start: ReturnType<typeof useInstallTransaction>['start'];
  /** Re-run native detection for the current device. */
  refreshDetection: () => Promise<void>;
}

export function useInstallButton(app: App): UseInstallButtonResult {
  const { tx, busy: isBusy, start, reset } = useInstallTransaction();
  const {
    state: detectedState,
    installed: osInstalled,
    refresh: refreshDetection,
  } = useInstalledState(app);

  const isUpdateAvailable = detectedState === 'UPDATE_AVAILABLE';

  const button = useMemo(() => installButtonFor({
    txState: tx.state,
    percent: tx.progress?.percent,
    isUpdate: isUpdateAvailable,
    hasLocalInstall: osInstalled,
    isUpdateAvailable,
    failed: tx.state !== 'IDLE' && ['DOWNLOAD_FAILED', 'VERIFICATION_FAILED', 'INSTALL_FAILED', 'INSTALLATION_NOT_DETECTED', 'CANCELLED'].includes(tx.state),
  }), [tx.state, tx.progress?.percent, isUpdateAvailable, osInstalled]);

  const refresh = useCallback(async () => {
    await refreshDetection();
  }, [refreshDetection]);

  return {
    button,
    installState: mapDetectionToInstall(detectedState),
    isBusy,
    reset,
    start,
    refreshDetection: refresh,
  };
}
