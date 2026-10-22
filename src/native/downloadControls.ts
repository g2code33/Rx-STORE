/**
 * RX Store — live download controls (pause / resume / cancel).
 *
 * WHY THIS EXISTS: the download used to be fire-and-forget. The only feedback
 * was a transient toast ("Downloading the package…") repeated on every state
 * transition, with no percentage and no way to stop it — so a second click
 * started another attempt and the user was left with a stack of identical
 * toasts and a silent 130MB transfer.
 *
 * The platform downloader registers a control object per attempt; the UI calls
 * through this registry. Capabilities are reported honestly per platform —
 * an unsupported control is hidden, never faked:
 *
 *   Electron (DownloadItem)  pause ✓  resume ✓  cancel ✓
 *   Web/PWA (fetch stream)   pause ✓  resume ✓  cancel ✓   (reader backpressure)
 *   Android (DownloadManager) pause ✗ resume ✗ cancel ✗     (no public API)
 */
export interface DownloadCapabilities {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
}

export interface DownloadControl {
  capabilities: DownloadCapabilities;
  pause: () => void | Promise<void>;
  resume: () => void | Promise<void>;
  cancel: () => void | Promise<void>;
}

/** Nothing is controllable (e.g. Android's DownloadManager). */
export const NO_DOWNLOAD_CONTROLS: DownloadCapabilities = { pause: false, resume: false, cancel: false };

const controls = new Map<string, DownloadControl>();

export function registerDownloadControl(attemptId: string, control: DownloadControl): void {
  if (!attemptId) return;
  controls.set(attemptId, control);
}

export function unregisterDownloadControl(attemptId: string): void {
  controls.delete(attemptId);
}

export function downloadControl(attemptId: string | undefined | null): DownloadControl | null {
  if (!attemptId) return null;
  return controls.get(attemptId) || null;
}

/** Capabilities for an attempt (all false when there is no live download). */
export function downloadCapabilities(attemptId: string | undefined | null): DownloadCapabilities {
  return downloadControl(attemptId)?.capabilities || NO_DOWNLOAD_CONTROLS;
}

export async function pauseDownload(attemptId: string): Promise<boolean> {
  const c = downloadControl(attemptId);
  if (!c?.capabilities.pause) return false;
  await c.pause();
  return true;
}

export async function resumeDownload(attemptId: string): Promise<boolean> {
  const c = downloadControl(attemptId);
  if (!c?.capabilities.resume) return false;
  await c.resume();
  return true;
}

export async function cancelDownload(attemptId: string): Promise<boolean> {
  const c = downloadControl(attemptId);
  if (!c?.capabilities.cancel) return false;
  await c.cancel();
  return true;
}

/** Clear every registration (tests / full reset). */
export function resetDownloadControls(): void {
  controls.clear();
}

/**
 * A resumable byte pump for the web downloader.
 *
 * `fetch` cannot be paused, but a `ReadableStream` reader can simply stop being
 * pulled — the browser's backpressure stops the transfer. This wraps that in an
 * explicit state machine so pause/resume/cancel are testable without a browser.
 */
export type PumpState = 'running' | 'paused' | 'cancelled' | 'done';

export interface BytePump {
  state: () => PumpState;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  /** Wait until the pump is allowed to continue (resolves immediately when running). */
  waitWhilePaused: () => Promise<void>;
}

export function createBytePump(): BytePump {
  let state: PumpState = 'running';
  let waiters: Array<() => void> = [];
  const release = () => {
    const pending = waiters;
    waiters = [];
    for (const w of pending) w();
  };
  return {
    state: () => state,
    pause: () => {
      if (state === 'running') state = 'paused';
    },
    resume: () => {
      if (state === 'paused') state = 'running';
      release();
    },
    cancel: () => {
      if (state === 'done' || state === 'cancelled') return;
      state = 'cancelled';
      release();
    },
    waitWhilePaused: async () => {
      if (state === 'running') return;
      if (state === 'cancelled' || state === 'done') return;
      await new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}
