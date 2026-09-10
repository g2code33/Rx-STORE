/**
 * RX Store — crash recovery for in-flight install/update transactions.
 *
 * PROBLEM THIS SOLVES
 * The install transaction lived only in React state. If RX Store closed (or
 * crashed) mid-download / mid-verify / mid-install, the next launch showed
 * nothing about it — or worse, a stuck "Installing…" for an attempt that no
 * longer exists.
 *
 * DESIGN
 *   - The active attempt is persisted (per account) before the download starts
 *     and cleared on any terminal state.
 *   - On startup `recoverTransaction()` inspects the persisted attempt, runs
 *     NATIVE DETECTION for the real answer, and decides one of:
 *
 *       recovered_installed   — detection now sees the target version → INSTALLED
 *       recovered_previous    — an interrupted UPDATE left the OLD version → keep it
 *       not_installed         — detection says it is not installed at all
 *       stale_cleared         — the attempt is too old / undetectable → drop it
 *
 *   - It NEVER assumes the target version was installed. Only native detection
 *     decides (this is the "do not assume 1.3.0 is installed" rule).
 *
 * Pure decision function + a tiny persistence wrapper (both unit-testable).
 */
import { cacheGet, cacheSet, cacheRemove, CACHE_TTL } from './cache.ts';
import { compareVersions, type InstalledApp } from '../platform/detect.ts';

export type PersistedPhase =
  | 'DOWNLOAD_STARTED'
  | 'DOWNLOADING'
  | 'DOWNLOAD_COMPLETED'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'INSTALLER_STARTED'
  | 'INSTALLATION_PENDING'
  | 'VERIFYING_INSTALLATION';

export interface PendingAttempt {
  attemptId: string;
  appSlug: string;
  appName?: string;
  /** The version we were trying to reach. */
  targetVersion?: string;
  /** The version that was installed BEFORE the attempt (interrupted updates). */
  previousVersion?: string;
  phase: PersistedPhase;
  isUpdate: boolean;
  startedAt: number;
  updatedAt: number;
  /** Local artifact path, when the download had completed. */
  artifactPath?: string;
}

const NAME = 'pending-attempt';

export function saveAttempt(a: Omit<PendingAttempt, 'updatedAt'> & { updatedAt?: number }): void {
  cacheSet('transaction', NAME, { ...a, updatedAt: Date.now() });
}

export function loadAttempt(): PendingAttempt | null {
  const a = cacheGet<PendingAttempt>('transaction', NAME);
  if (!a || !a.appSlug || !a.attemptId) return null;
  return a;
}

export function clearAttempt(): void {
  cacheRemove('transaction', NAME);
}

/** An attempt older than the transaction TTL is considered abandoned. */
export function isAttemptStale(a: PendingAttempt, now: number = Date.now(), maxAgeMs = CACHE_TTL.transaction): boolean {
  const started = Number(a?.startedAt) || 0;
  if (!started) return true;
  return now - started > maxAgeMs;
}

export type RecoveryOutcome =
  | 'recovered_installed'
  | 'recovered_previous'
  | 'not_installed'
  | 'stale_cleared'
  | 'still_installing';

export interface RecoveryDecision {
  outcome: RecoveryOutcome;
  /** The version native detection actually reports (never assumed). */
  detectedVersion?: string;
  /** The version the account/UI should reflect. */
  effectiveVersion?: string;
  installed: boolean;
  /** Message shown to the user (empty when nothing notable happened). */
  message: string;
  /** True when the caller should re-report this state to the backend. */
  shouldSync: boolean;
}

/**
 * Decide what actually happened to a persisted attempt.
 *
 * `detected` is the CURRENT native detection result (null when detection is
 * unavailable — in that case we never claim success or failure).
 */
export function decideRecovery(
  attempt: PendingAttempt,
  detected: InstalledApp | null,
  now: number = Date.now(),
): RecoveryDecision {
  // Detection unavailable (web/PWA or a transient error): keep the attempt but
  // do NOT claim it succeeded or failed. The UI must not show a stuck state.
  if (!detected) {
    return {
      outcome: 'still_installing',
      installed: false,
      message: 'Installation could not be verified yet. Check again shortly.',
      shouldSync: false,
    };
  }

  // Abandoned attempt → clear without asserting anything about installation.
  if (isAttemptStale(attempt, now)) {
    return {
      outcome: 'stale_cleared',
      installed: !!detected.installed,
      detectedVersion: detected.version,
      effectiveVersion: detected.version,
      message: 'A previous installation attempt was abandoned and has been cleared.',
      shouldSync: true,
    };
  }

  // Not installed at all: the attempt failed (or was uninstalled outside RX Store).
  if (!detected.installed) {
    return {
      outcome: 'not_installed',
      installed: false,
      message: 'The previous installation did not complete. You can try again.',
      shouldSync: true,
    };
  }

  const detectedVersion = detected.version;
  const target = attempt.targetVersion;

  // Detection sees the TARGET version (or newer) → the attempt succeeded.
  if (target && detectedVersion && compareVersions(detectedVersion, target) >= 0) {
    return {
      outcome: 'recovered_installed',
      installed: true,
      detectedVersion,
      effectiveVersion: detectedVersion,
      message: attempt.isUpdate ? 'The update completed successfully.' : 'Installation completed successfully.',
      shouldSync: true,
    };
  }

  // Detection reports a version but NOT the target → the attempt did not take.
  // For an update this means the OLD version survived: never mark it uninstalled.
  if (attempt.isUpdate) {
    return {
      outcome: 'recovered_previous',
      installed: true,
      detectedVersion,
      effectiveVersion: detectedVersion || attempt.previousVersion,
      message: 'The update was interrupted. Your existing version is still installed.',
      shouldSync: true,
    };
  }

  return {
    outcome: 'recovered_previous',
    installed: true,
    detectedVersion,
    effectiveVersion: detectedVersion,
    message: 'The installation was interrupted. An existing version is still present.',
    shouldSync: true,
  };
}

/** Terminal phases after which no recovery is needed. */
const TERMINAL: PersistedPhase[] = [];

/**
 * Whether a phase indicates the app could be mid-install (i.e. recovery must run
 * detection before the UI shows anything).
 */
export function phaseNeedsRecovery(phase: PersistedPhase): boolean {
  if (TERMINAL.includes(phase)) return false;
  return [
    'DOWNLOAD_STARTED', 'DOWNLOADING', 'DOWNLOAD_COMPLETED', 'VERIFYING', 'VERIFIED',
    'INSTALLER_STARTED', 'INSTALLATION_PENDING', 'VERIFYING_INSTALLATION',
  ].includes(phase);
}

/**
 * Whether a persisted phase implies a local artifact may remain on disk that
 * should be cleaned up (download completed but install never confirmed).
 * We never delete an artifact an installer may still need.
 */
export function artifactCleanupCandidate(attempt: PendingAttempt, outcome: RecoveryOutcome): string | null {
  if (!attempt.artifactPath) return null;
  // Keep the artifact while an install may still be in progress.
  if (outcome === 'still_installing') return null;
  if (outcome === 'stale_cleared' || outcome === 'not_installed') return attempt.artifactPath;
  return null;
}
