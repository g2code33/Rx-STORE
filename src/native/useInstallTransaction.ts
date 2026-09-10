/**
 * RX Store — React hook that surfaces the install/update transaction.
 *
 * The UI reads a single, central transaction state (from installTransaction.ts)
 * rather than inferring the lifecycle locally. This keeps AppDetail / AppCard /
 * Profile / DownloadModal presentational: they just render what the transaction
 * reports.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { App } from '../types';
import { InstallCoordinator, type PackageResolution } from './installCoordinator';
import {
  TransactionResult,
  TransactionState,
  TransactionProgress,
  createTransaction,
  describeTransaction,
  isFailed,
} from './installTransaction.ts';
import { loadAttempt, decideRecovery, clearAttempt, phaseNeedsRecovery } from './transactionRecovery.ts';
import { detectInstalledApp } from '../platform/nativeDetection';
import { reportCurrentInstallation } from './accountSync';

export interface InstallTransactionApi {
  tx: TransactionResult;
  /** True while a pipeline is in a non-terminal, non-idle state. */
  busy: boolean;
  failed: boolean;
  /** Human label for the current state. */
  label: string;
  /** Run a full GET/UPDATE pipeline for the app. */
  start: (app: App, pkg: PackageResolution, opts?: { isUpdate?: boolean; previousVersion?: string }) => Promise<TransactionResult>;
  /** Reset to IDLE. */
  reset: () => void;
  /** Message describing how an interrupted attempt was recovered (empty when none). */
  recoveryMessage: string;
  /** True while startup crash-recovery is running. */
  recovering: boolean;
}

/**
 * Reconcile an interrupted attempt left behind by a crash/close.
 *
 * Runs native detection to learn the REAL state (never assumes the target version
 * landed), synchronizes the correction, and clears the stale record so the UI can
 * never show a permanently stuck "Installing…".
 */
export async function recoverInterruptedAttempt(app?: App): Promise<string> {
  const attempt = loadAttempt();
  if (!attempt) return '';
  if (!phaseNeedsRecovery(attempt.phase)) { clearAttempt(); return ''; }

  let detected: Awaited<ReturnType<typeof detectInstalledApp>> = null;
  try {
    // Prefer the real app record so identity fields are available; fall back to
    // a slug-only shape when the catalog has not loaded yet.
    detected = await detectInstalledApp((app && app.slug === attempt.appSlug ? app : ({ slug: attempt.appSlug } as App)));
  } catch {
    detected = null;
  }

  const decision = decideRecovery(attempt, detected);
  clearAttempt();

  if (decision.shouldSync) {
    await reportCurrentInstallation({
      appSlug: attempt.appSlug,
      installed: decision.installed,
      installedVersion: decision.effectiveVersion,
      status: decision.installed
        ? (decision.outcome === 'recovered_installed' ? 'INSTALLED' : 'INSTALLED')
        : 'NOT_INSTALLED',
      detectionSource: detected?.source,
    }).catch(() => {});
  }
  return decision.message;
}

let coordinator: InstallCoordinator | null = null;
function getCoordinator(): InstallCoordinator {
  if (!coordinator) coordinator = new InstallCoordinator();
  return coordinator;
}

export function useInstallTransaction(initial?: { previousVersion?: string; targetVersion?: string; platform?: string }): InstallTransactionApi {
  const [tx, setTx] = useState<TransactionResult>(() => createTransaction(initial));
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [recovering, setRecovering] = useState(false);
  const running = useRef(false);
  const recovered = useRef(false);

  // Crash recovery: reconcile an interrupted attempt exactly once per mount.
  useEffect(() => {
    if (recovered.current) return;
    recovered.current = true;
    let alive = true;
    setRecovering(true);
    void recoverInterruptedAttempt()
      .then((msg) => { if (alive && msg) setRecoveryMessage(msg); })
      .catch(() => { /* recovery must never break the page */ })
      .finally(() => { if (alive) setRecovering(false); });
    return () => { alive = false; };
  }, []);

  const start = useCallback(async (app: App, pkg: PackageResolution, opts?: { isUpdate?: boolean; previousVersion?: string }) => {
    if (running.current) return tx;
    running.current = true;
    const result = await getCoordinator().run({
      app,
      packageMeta: pkg,
      previousVersion: opts?.previousVersion || initial?.previousVersion,
      isUpdate: opts?.isUpdate,
      onState: (next) => setTx(next),
    });
    running.current = false;
    return result;
  }, [initial?.previousVersion, tx]);

  const reset = useCallback(() => {
    setTx(createTransaction(initial));
  }, [initial]);

  return {
    tx,
    recoveryMessage,
    recovering,
    busy: tx.state !== 'IDLE' && !['INSTALLED', 'DOWNLOAD_FAILED', 'VERIFICATION_FAILED', 'INSTALL_FAILED', 'INSTALLATION_NOT_DETECTED', 'CANCELLED'].includes(tx.state),
    failed: isFailed(tx.state),
    label: describeTransaction(tx.state),
    start,
    reset,
  };
}

export type { TransactionState, TransactionProgress };
