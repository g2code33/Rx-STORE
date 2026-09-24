/**
 * Banner state derivation — pure logic shared by the optional React
 * <RxStoreUpdateBanner /> and any custom host UI.
 *
 * Rules:
 *   - MANDATORY updates can never be permanently dismissed. A dismissal only
 *     lasts until the check runs again with a NEW latestVersion (or the host
 *     resets it); the banner returns on the next visibility/startup check.
 *   - Non-mandatory updates are dismissible per version (dismiss v1.1.5 once,
 *     v1.1.6 shows the banner again).
 *   - Error/network states are surfaced separately so hosts can render a
 *     subtle "couldn't check for updates" instead of a modal wall.
 */

import type { UpdateCheckResult, UpdateInfo } from './types.ts';

export type BannerState =
  | { kind: 'hidden' }                                        // nothing to show
  | { kind: 'loading' }
  | { kind: 'available'; update: UpdateInfo; mandatory: false }
  | { kind: 'mandatory'; update: UpdateInfo }
  | { kind: 'error'; status: string; retryable: boolean };

/** Records which (latestVersion) the user dismissed the banner for. */
export interface DismissedState {
  /** The latestVersion the user dismissed (non-mandatory only). */
  version: string | null;
}

const RETRYABLE_STATUSES = new Set(['NETWORK_ERROR', 'RATE_LIMITED', 'SERVER_ERROR']);

export function deriveBannerState(
  check: UpdateCheckResult | null,
  dismissed: DismissedState,
): BannerState {
  if (!check) return { kind: 'loading' };

  if (check.status === 'UPDATE_AVAILABLE' && check.update) {
    const sameVersionDismissed = dismissed.version === check.update.latestVersion;
    return sameVersionDismissed
      ? { kind: 'hidden' }
      : { kind: 'available', update: check.update, mandatory: false };
  }
  if (check.status === 'MANDATORY_UPDATE' && check.update) {
    // Mandatory: dismissal is never honoured.
    return { kind: 'mandatory', update: check.update };
  }
  if (check.status === 'NO_UPDATE') return { kind: 'hidden' };
  if (check.status === 'INVALID_RESPONSE' || check.status === 'APP_NOT_FOUND' || check.status === 'UNSUPPORTED_PLATFORM') {
    // Fail closed for bad metadata: hide rather than show something untrusted.
    return { kind: 'hidden' };
  }
  // NETWORK_ERROR / RATE_LIMITED / SERVER_ERROR
  return { kind: 'error', status: check.status, retryable: RETRYABLE_STATUSES.has(check.status) };
}
