/**
 * RX Store — connectivity signal.
 *
 * Uses the platform's existing mechanisms only:
 *   - `navigator.onLine` + the `online`/`offline` window events (no polling)
 *   - Capacitor's native network status when available (Android), detected from
 *     the global the native shell exposes (kept dependency-free so this module
 *     stays testable outside a WebView).
 *
 * Deliberately does NOT poll: events fire when the OS reports a change, and the
 * sync queue's backoff handles the rest.
 */

type Listener = (online: boolean) => void;

let online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
let bound = false;
const listeners = new Set<Listener>();

/** True when the device currently appears to have connectivity. */
export function isOnline(): boolean {
  return online;
}

function setOnline(next: boolean): void {
  if (next === online) return;
  online = next;
  listeners.forEach((l) => { try { l(online); } catch { /* ignore */ } });
}

/** Attach the browser listeners once (idempotent). */
export function bind(): void {
  if (bound || typeof window === 'undefined') return;
  bound = true;
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));
}

/** Subscribe to connectivity changes. Returns an unsubscribe function. */
export function subscribeConnectivity(l: Listener): () => void {
  bind();
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** True when running inside the Android Capacitor shell. */
function isAndroidShell(): boolean {
  try {
    const cap = (window as any).Capacitor;
    return !!(cap && cap.isNativePlatform?.() && cap.getPlatform?.() === 'android');
  } catch {
    return false;
  }
}

/**
 * Refresh the signal from the native shell (Android) when available. Cheap and
 * safe to call on focus; it does not poll.
 */
export async function refreshConnectivity(): Promise<boolean> {
  bind();
  if (isAndroidShell()) {
    try {
      const cap = (window as any).Capacitor;
      // The AppInstaller plugin is reachable through the Capacitor bridge.
      const res = await cap?.Plugins?.AppInstaller?.getNetworkStatus?.();
      if (res && typeof res.connected === 'boolean') {
        setOnline(!!res.connected);
        return online;
      }
    } catch { /* fall back to the browser signal */ }
  }
  if (typeof navigator !== 'undefined') setOnline(navigator.onLine !== false);
  return online;
}

/** Test hook — force the signal (never used in production paths). */
export function __setOnlineForTests(next: boolean): void {
  setOnline(next);
}
