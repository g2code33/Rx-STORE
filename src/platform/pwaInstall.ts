/**
 * Captures the browser's beforeinstallprompt so the /get-app page can offer a
 * one-tap "Install web app" on PWA-capable browsers (Chrome/Edge/Android).
 * iOS Safari never fires it — those users get the manual guide instead.
 */

let deferred: any = null;
let bound = false;
type Listener = (available: boolean) => void;
const listeners = new Set<Listener>();

export function capturePwaInstallPrompt(): void {
  if (bound || typeof window === 'undefined') return;
  bound = true;
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    deferred = e;
    listeners.forEach((l) => l(true));
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((l) => l(false));
  });
}

export function pwaInstallAvailable(): boolean {
  return !!deferred;
}

export function subscribePwaInstall(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Show the native install sheet. Resolves true when the user accepted. */
export async function promptPwaInstall(): Promise<boolean> {
  if (!deferred) return false;
  try {
    deferred.prompt();
    const choice = await deferred.userChoice;
    deferred = null;
    return choice?.outcome === 'accepted';
  } catch {
    deferred = null;
    return false;
  }
}
