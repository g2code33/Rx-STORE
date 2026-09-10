/**
 * RX Store — frontend installation-state → UI mapping (single source of truth).
 *
 * The installation transaction state machine (installTransaction.ts) is the only
 * place the lifecycle lives. This module maps a given transaction state (+ the
 * current device's detected install state) into the exact button copy the UI
 * should render, so AppCard / AppDetail / Profile / DownloadModal never infer
 * their own conflicting states.
 *
 * The current-device rule is authoritative: native detection decides
 * GET / OPEN / UPDATE; the transaction state overrides with transient progress;
 * backend "other device" info is only ever a secondary hint.
 */
import type { TransactionState } from './installTransaction';
import type { InstallState } from '../platform/detect';

/** The normalized action/button states the UI renders. */
export type InstallButtonState =
  | 'GET'
  | 'DOWNLOADING'
  | 'VERIFYING'
  | 'INSTALLING'
  | 'CHECKING'
  | 'OPEN'
  | 'UPDATE'
  | 'UPDATING'
  | 'RETRY';

/** The exact button label, including progress where relevant. */
export interface InstallButton {
  state: InstallButtonState;
  /** Machine-readable action the UI should perform. */
  action: 'get' | 'open' | 'update' | 'retry';
  /** Human label (may show % / ellipsis). */
  label: string;
  /** Percentage for progress states (0-100), else undefined. */
  percent?: number;
  /** Short aria/status descriptor for screen readers. */
  status?: string;
}

/**
 * Map the transaction state to a button. `isUpdate` chooses UPDATE vs GET
 * wording when idle. `hasLocalInstall` and `isUpdateAvailable` come from the
 * current device's native detection.
 */
export function installButtonFor(input: {
  txState: TransactionState;
  percent?: number;
  isUpdate?: boolean;
  hasLocalInstall?: boolean;
  isUpdateAvailable?: boolean;
  failed?: boolean;
}): InstallButton {
  const { txState, percent, isUpdate, hasLocalInstall, isUpdateAvailable, failed } = input;

  switch (txState) {
    case 'IDLE':
      // Idle: fall through to the detected base state.
      if (failed) return retryButton();
      if (isUpdateAvailable) return { state: 'UPDATE', action: 'update', label: 'Update', status: 'A newer version is available (Update)' };
      if (hasLocalInstall) return { state: 'OPEN', action: 'open', label: 'Open', status: 'Installed (Open)' };
      return { state: 'GET', action: 'get', label: isUpdate ? 'Update' : 'Get', status: isUpdate ? 'Newer version available (Update)' : 'Not installed (Get)' };

    case 'DOWNLOADING':
    case 'DOWNLOAD_STARTED': {
      // An update uses UPDATE wording even during the download/verify/install flow.
      if (isUpdate) {
        return {
          state: 'UPDATING',
          action: 'update',
          label: percent !== undefined && percent > 0 ? `Updating ${percent}%` : 'Updating…',
          percent,
          status: `Updating application ${percent ?? 0}%`,
        };
      }
      return {
        state: 'DOWNLOADING',
        action: 'get',
        label: percent !== undefined && percent > 0 ? `Downloading ${percent}%` : 'Downloading…',
        percent,
        status: `Downloading ${percent ?? 0}%`,
      };
    }
    case 'DOWNLOAD_COMPLETED':
      return { state: isUpdate ? 'UPDATING' : 'VERIFYING', action: isUpdate ? 'update' : 'get', label: isUpdate ? 'Updating…' : 'Verifying…', status: isUpdate ? 'Updating' : 'Download complete, verifying checksum' };
    case 'VERIFYING':
      return { state: isUpdate ? 'UPDATING' : 'VERIFYING', action: isUpdate ? 'update' : 'get', label: isUpdate ? 'Updating…' : 'Verifying…', status: isUpdate ? 'Updating' : 'Verifying checksum' };
    case 'VERIFIED':
      return { state: isUpdate ? 'UPDATING' : 'INSTALLING', action: isUpdate ? 'update' : 'get', label: isUpdate ? 'Updating…' : 'Installing…', status: isUpdate ? 'Updating' : 'Verified, installing' };
    case 'INSTALLER_STARTED':
    case 'INSTALLATION_PENDING':
      return { state: isUpdate ? 'UPDATING' : 'INSTALLING', action: isUpdate ? 'update' : 'get', label: isUpdate ? 'Updating…' : 'Installing…', status: isUpdate ? 'Updating' : 'Installer launched, waiting for installation' };
    case 'VERIFYING_INSTALLATION':
      return { state: 'CHECKING', action: isUpdate ? 'update' : 'get', label: 'Checking installation…', status: 'Checking installation' };
    case 'INSTALLED':
      return { state: 'OPEN', action: 'open', label: 'Open', status: 'Installed (Open)' };

    case 'DOWNLOAD_FAILED':
      return retryButton('Download failed. Try again.');
    case 'VERIFICATION_FAILED':
      return retryButton('Package verification failed. The file was not installed.');
    case 'INSTALL_FAILED':
      return retryButton('Install failed. Try again.');
    case 'INSTALLATION_NOT_DETECTED':
      return retryButton('Installation could not be confirmed.');
    case 'CANCELLED':
      return retryButton('Cancelled — Retry');
    default:
      return retryButton();
  }
}

function retryButton(label = 'Retry'): InstallButton {
  return { state: 'RETRY', action: 'retry', label, status: label };
}

/** Map a detected InstallState to a stable status descriptor (accessibility). */
export function installStateStatus(state: InstallState | 'DETECTION_UNAVAILABLE'): string {
  switch (state) {
    case 'INSTALLED': return 'Installed on this device';
    case 'UPDATE_AVAILABLE': return 'Update available';
    case 'NOT_INSTALLED': return 'Not installed on this device';
    case 'INSTALLING': return 'Installing on this device';
    case 'UPDATING': return 'Updating on this device';
    case 'UNINSTALLING': return 'Uninstalling from this device';
    case 'INSTALL_FAILED': return 'Install failed';
    case 'UPDATE_FAILED': return 'Update failed — your existing version is still installed';
    case 'UNINSTALL_FAILED': return 'Uninstall failed';
    case 'DETECTION_UNAVAILABLE':
    default: return 'Installation status unavailable';
  }
}

/** A short, friendly "installed elsewhere" descriptor. */
export function deviceCountLabel(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? 'Installed on another device' : `Installed on ${count} devices`;
}
