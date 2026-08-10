import { useSyncExternalStore } from 'react';
import toast from 'react-hot-toast';

/**
 * Desktop auto-update bridge.
 *
 * The Electron main process (electron/main.ts) already does the heavy lifting:
 * it checks on boot + hourly, downloads updates silently, and streams status
 * events over `update:status`. The preload (electron/preload.ts) exposes a
 * tiny safe surface as `window.rxDesktop`. This module turns that into a
 * reactive, typed store the React UI (banner + Profile settings) can consume —
 * on the web build everything here degrades to no-ops so the site is
 * unaffected.
 */

export type UpdatePhase =
  | 'idle' // nothing heard yet (listeners attach after the boot check may have fired)
  | 'dev' // running unpacked — electron-updater is disabled
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  /** Version the current event relates to (e.g. the incoming release). */
  version?: string;
  /** Version of the app actually running right now. */
  currentVersion?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  message?: string;
  /** Whether the attention banner should surface for this state change. */
  banner?: boolean;
  /** Timestamp of the last state change — lets a dismissed banner re-appear on the next event. */
  at: number;
}

declare global {
  interface Window {
    rxDesktop?: {
      isDesktop: boolean;
      appVersion: () => Promise<string>;
      checkForUpdates: () => Promise<{ state?: string; message?: string } | void>;
      installUpdate: () => Promise<void>;
      onUpdateStatus: (cb: (s: any) => void) => () => void;
      downloadApp: (input: { url: string; fileName?: string; id?: string }) => Promise<{ path: string; fileName: string; size: number }>;
      installApp: (filePath: string) => Promise<{ launched: boolean }>;
      openApp: (target: string) => Promise<boolean>;
      uninstallApp: () => Promise<boolean>;
      showNotification: (input: { title: string; body?: string }) => Promise<boolean>;
      onDownloadProgress: (cb: (s: any) => void) => () => void;
    };
  }
}

export const isDesktopApp = () => typeof window !== 'undefined' && !!window.rxDesktop?.isDesktop;

let status: UpdateStatus = { phase: 'idle', at: 0 };
const listeners = new Set<() => void>();
let started = false;
// Brief window after a manual check during which results deserve a toast/banner
// even though the same event from the silent hourly check stays quiet.
let manualUntil = 0;

function setStatus(patch: Partial<UpdateStatus>) {
  status = { ...status, ...patch, at: Date.now() };
  listeners.forEach((l) => l());
}

function init() {
  if (started || !isDesktopApp()) return;
  started = true;

  window.rxDesktop!.onUpdateStatus((s) => {
    const manual = Date.now() < manualUntil;
    switch (s?.state) {
      case 'checking':
        setStatus({ phase: 'checking', banner: false });
        break;
      case 'available':
        setStatus({ phase: 'available', version: s.version, banner: true });
        break;
      case 'downloading':
        setStatus({
          phase: 'downloading',
          percent: typeof s.percent === 'number' ? s.percent : status.percent,
          transferred: s.transferred,
          total: s.total,
          banner: true,
        });
        break;
      case 'downloaded':
        setStatus({ phase: 'downloaded', version: s.version, percent: 100, banner: true });
        if (status.currentVersion && s.version && s.version !== status.currentVersion) {
          toast.success(`Update v${s.version} downloaded — restart to install.`);
        }
        break;
      case 'up-to-date': {
        const v = s.version || status.currentVersion;
        setStatus({ phase: 'up-to-date', version: v, banner: false });
        if (manual) toast.success(`You're up to date${v ? ` — v${v}` : ''}.`);
        manualUntil = 0;
        break;
      }
      case 'error':
        setStatus({ phase: 'error', message: s.message, banner: manual });
        if (manual) toast.error(s.message ? `Update check failed: ${s.message}` : 'Update check failed.');
        manualUntil = 0;
        break;
    }
  });

  window
    .rxDesktop!.appVersion()
    .then((v) => setStatus({ currentVersion: v }))
    .catch(() => {});
}

/** Manual "Check for updates" — shows feedback even for silent states. */
export async function checkNow() {
  init();
  if (!isDesktopApp()) {
    toast('Updates are managed in the desktop app — the website is always current.', { icon: 'ℹ️' });
    return;
  }
  manualUntil = Date.now() + 45_000;
  setStatus({ phase: 'checking', banner: false });
  try {
    const r = await window.rxDesktop!.checkForUpdates();
    if (r && r.state === 'dev') {
      manualUntil = 0;
      setStatus({ phase: 'dev', banner: false });
      toast('Development build — updates are disabled.', { icon: 'ℹ️' });
    } else if (r && r.state === 'error') {
      manualUntil = 0;
      setStatus({ phase: 'error', message: r.message, banner: true });
    }
    // any other result arrives asynchronously on the status channel
  } catch (e: any) {
    manualUntil = 0;
    setStatus({ phase: 'error', message: e?.message, banner: true });
    toast.error('Update check failed.');
  }
}

/** Restart the app and swap in the downloaded update. */
export async function installNow() {
  if (isDesktopApp()) await window.rxDesktop!.installUpdate();
}

export function subscribeUpdates(l: () => void) {
  init();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const getUpdateStatus = (): UpdateStatus => status;

export function useUpdateStatus(): UpdateStatus {
  return useSyncExternalStore(subscribeUpdates, getUpdateStatus, getUpdateStatus);
}

export interface StatusDescription {
  text: string;
  tone: 'gray' | 'yellow' | 'green' | 'red';
  busy: boolean;
}

/** Human-readable one-liner for the current state (Profile card + future surfaces). */
export function describeStatus(s: UpdateStatus): StatusDescription {
  const v = s.version ? ` v${s.version}` : '';
  switch (s.phase) {
    case 'checking':
      return { text: 'Checking for updates…', tone: 'gray', busy: true };
    case 'available':
      return { text: `Update${v} found — downloading in the background…`, tone: 'yellow', busy: true };
    case 'downloading':
      return { text: `Downloading update${v}… ${s.percent ?? 0}%`, tone: 'yellow', busy: true };
    case 'downloaded':
      return { text: `Update${v} is ready — restart to install.`, tone: 'green', busy: false };
    case 'up-to-date': {
      const cv = s.version || s.currentVersion;
      return { text: `You're on the latest version${cv ? ` (v${cv})` : ''}.`, tone: 'green', busy: false };
    }
    case 'error':
      return { text: s.message ? `Update check failed: ${s.message}` : 'Update check failed.', tone: 'red', busy: false };
    case 'dev':
      return { text: 'Development build — updates disabled.', tone: 'gray', busy: false };
    default:
      return { text: 'Updates check automatically in the background.', tone: 'gray', busy: false };
  }
}
