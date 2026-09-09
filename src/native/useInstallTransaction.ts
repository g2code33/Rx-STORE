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
} from './installTransaction';

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
}

let coordinator: InstallCoordinator | null = null;
function getCoordinator(): InstallCoordinator {
  if (!coordinator) coordinator = new InstallCoordinator();
  return coordinator;
}

export function useInstallTransaction(initial?: { previousVersion?: string; targetVersion?: string; platform?: string }): InstallTransactionApi {
  const [tx, setTx] = useState<TransactionResult>(() => createTransaction(initial));
  const running = useRef(false);

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
    busy: tx.state !== 'IDLE' && !['INSTALLED', 'DOWNLOAD_FAILED', 'VERIFICATION_FAILED', 'INSTALL_FAILED', 'INSTALLATION_NOT_DETECTED', 'CANCELLED'].includes(tx.state),
    failed: isFailed(tx.state),
    label: describeTransaction(tx.state),
    start,
    reset,
  };
}

export type { TransactionState, TransactionProgress };
