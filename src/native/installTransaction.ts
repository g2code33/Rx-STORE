/**
 * RX Store — installation/update transaction pipeline.
 *
 * A single, central state machine that models the full lifecycle:
 *
 *   IDLE → DOWNLOAD_STARTED → DOWNLOADING → DOWNLOAD_COMPLETED → VERIFYING
 *         → VERIFIED → INSTALLER_STARTED → INSTALLATION_PENDING
 *         → VERIFYING_INSTALLATION → INSTALLED
 *
 * Failure states:
 *   DOWNLOAD_FAILED, VERIFICATION_FAILED, INSTALL_FAILED,
 *   INSTALLATION_NOT_DETECTED, CANCELLED
 *
 * CRITICAL RULE: DOWNLOAD ≠ INSTALL. A download completing never becomes
 * INSTALLED — the transition to INSTALLED only happens after native detection
 * actually confirms the application (and, for updates, the new version).
 *
 * The UI consumes this state via a lightweight subscription; components never
 * infer the lifecycle on their own.
 */
import type { VerificationResult } from './verify.ts';

/** The full set of transaction states. */
export type TransactionState =
  | 'IDLE'
  | 'DOWNLOAD_STARTED'
  | 'DOWNLOADING'
  | 'DOWNLOAD_COMPLETED'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'INSTALLER_STARTED'
  | 'INSTALLATION_PENDING'
  | 'VERIFYING_INSTALLATION'
  | 'INSTALLED'
  | 'DOWNLOAD_FAILED'
  | 'VERIFICATION_FAILED'
  | 'INSTALL_FAILED'
  | 'INSTALLATION_NOT_DETECTED'
  | 'CANCELLED';

/** A transient progress snapshot (bytes + percent) for DOWNLOADING / VERIFYING. */
export interface TransactionProgress {
  received: number;
  total: number;
  percent: number;
}

/** Result surface for the transaction. */
export interface TransactionResult {
  attemptId: string;
  state: TransactionState;
  progress: TransactionProgress;
  /** Previous installed version (preserved on failed update). */
  previousVersion?: string;
  /** Target version being installed. */
  targetVersion?: string;
  platform?: string;
  message?: string;
  verification?: VerificationResult;
  /** Where the artifact was saved (native path / blob url). */
  artifactPath?: string;
  startedAt: number;
  updatedAt: number;
}

export type TransactionEvent = (tx: TransactionResult) => void;

let attemptCounter = 0;
function nextAttemptId(): string {
  attemptCounter += 1;
  return `inst_${Date.now().toString(36)}_${attemptCounter.toString(36)}`;
}

/**
 * Create a new transaction (clean state). Each attempt is unique; it is NOT the
 * application installation identity.
 */
export function createTransaction(opts?: {
  previousVersion?: string;
  targetVersion?: string;
  platform?: string;
}): TransactionResult {
  const now = Date.now();
  return {
    attemptId: nextAttemptId(),
    state: 'IDLE',
    progress: { received: 0, total: 0, percent: 0 },
    previousVersion: opts?.previousVersion,
    targetVersion: opts?.targetVersion,
    platform: opts?.platform,
    startedAt: now,
    updatedAt: now,
  };
}

/** Apply a transition (mutating a copy) and return it. */
export function transition(tx: TransactionResult, patch: Partial<TransactionResult>): TransactionResult {
  return { ...tx, ...patch, updatedAt: Date.now() };
}

/** True when a transaction is in a terminal (non-transient) successful state. */
export function isTerminalSuccess(state: TransactionState): boolean {
  return state === 'INSTALLED' || state === 'VERIFIED';
}

/** True when a transaction is in a failure state. */
export function isFailed(state: TransactionState): boolean {
  return [
    'DOWNLOAD_FAILED', 'VERIFICATION_FAILED', 'INSTALL_FAILED', 'INSTALLATION_NOT_DETECTED', 'CANCELLED',
  ].includes(state);
}

/** A user-facing one-line label for a state (for the UI + tests). */
export function describeTransaction(state: TransactionState): string {
  switch (state) {
    case 'IDLE': return 'Get';
    case 'DOWNLOAD_STARTED': return 'Starting download…';
    case 'DOWNLOADING': return 'Downloading';
    case 'DOWNLOAD_COMPLETED': return 'Download complete';
    case 'VERIFYING': return 'Verifying checksum…';
    case 'VERIFIED': return 'Verified';
    case 'INSTALLER_STARTED': return 'Opening installer…';
    case 'INSTALLATION_PENDING': return 'Waiting for installation…';
    case 'VERIFYING_INSTALLATION': return 'Checking installation…';
    case 'INSTALLED': return 'Installed';
    case 'DOWNLOAD_FAILED': return 'Download failed';
    case 'VERIFICATION_FAILED': return 'Verification failed';
    case 'INSTALL_FAILED': return 'Install failed';
    case 'INSTALLATION_NOT_DETECTED': return 'Installation not detected';
    case 'CANCELLED': return 'Cancelled';
    default: return 'Get';
  }
}

// ---------------------------------------------------------------------------
// Minimal subscription store so the UI re-renders on transaction changes
// without embedding the lifecycle in AppCard/AppDetail.
// ---------------------------------------------------------------------------

type Listener = (tx: TransactionResult) => void;

/** A tiny reactive holder for the active transaction. */
export interface TransactionStore {
  get(): TransactionResult;
  set(tx: TransactionResult): void;
  subscribe(fn: Listener): () => void;
}

export function createTransactionStore(): TransactionStore {
  let current: TransactionResult = createTransaction();
  const listeners = new Set<Listener>();
  return {
    get: () => current,
    set: (tx) => { current = tx; listeners.forEach((l) => l(current)); },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
