/**
 * RX Store — the ONE install/download transaction store.
 *
 * WHY THIS EXISTS (production bug): `useInstallTransaction()` used to keep its
 * state in `useState` *per component*. `AppDetail` had one instance and
 * `useInstallButton` had another, so a download started from one surface was
 * invisible to the other. The app page's live download panel therefore stayed
 * hidden while a transfer was genuinely running — the download "worked" but
 * nothing on the page showed it.
 *
 * The transaction is a single app-wide fact, so it lives here: one snapshot,
 * many subscribers. Every surface (app page, card, button, modal) renders the
 * same live state, and the panel appears no matter which button started the
 * download.
 *
 * Pure and framework-free: `useInstallTransaction` adapts it to React.
 */
import { createTransaction, type TransactionResult } from './installTransaction.ts';

type Listener = (tx: TransactionResult) => void;

let current: TransactionResult = createTransaction();
const listeners = new Set<Listener>();

/** The live transaction (a snapshot; never mutated in place). */
export function getTransaction(): TransactionResult {
  return current;
}

/** Replace the transaction and notify every subscriber. */
export function setTransaction(next: TransactionResult): TransactionResult {
  current = next;
  for (const l of [...listeners]) {
    try { l(current); } catch { /* a broken subscriber must not stop the others */ }
  }
  return current;
}

/** Apply a patch on top of the current transaction. */
export function patchTransaction(patch: Partial<TransactionResult>): TransactionResult {
  return setTransaction({ ...current, ...patch, updatedAt: Date.now() });
}

/** Subscribe to changes. Returns the unsubscribe function. */
export function subscribeToTransaction(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Start a brand-new transaction (new attempt id). */
export function resetTransaction(next?: Parameters<typeof createTransaction>[0]): TransactionResult {
  return setTransaction(createTransaction(next));
}

/** True when a transfer is actively running (download/verify/install). */
export function isTransactionRunning(tx: TransactionResult = current): boolean {
  return tx.state !== 'IDLE' &&
    !['INSTALLED', 'DOWNLOAD_FAILED', 'VERIFICATION_FAILED', 'INSTALL_FAILED', 'INSTALLATION_NOT_DETECTED', 'CANCELLED'].includes(tx.state);
}

/** True when the transaction ended in a state the user can retry from. */
export function isTransactionFailed(tx: TransactionResult = current): boolean {
  return ['DOWNLOAD_FAILED', 'VERIFICATION_FAILED', 'INSTALL_FAILED', 'INSTALLATION_NOT_DETECTED', 'CANCELLED'].includes(tx.state);
}

/** Tests only: drop the state and listeners. */
export function __resetTransactionStore(): void {
  current = createTransaction();
  listeners.clear();
}
