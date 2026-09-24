/**
 * RX Store renderer-side deep-link intake.
 *
 * Sources (all validated through the ONE canonical parser in
 * ./deepLinkProtocol before anything navigates):
 *   - Electron desktop: main-process 'deep-link' events (validated there
 *     first) + the cold-start pending link via window.rxDesktop.
 *   - Android: the RxDeepLink Capacitor plugin (launch link + 'deepLink'
 *     events). The Java side hands over the raw URI string only.
 *   - Web/PWA: the HTTPS fallback URL IS the destination (/app/{slug}), so
 *     plain links need no special intake; the ?pending= parameter carries a
 *     short-lived destination for the install-then-continue flow.
 *
 * Nothing from a link is ever executed; the only possible outcome is an
 * in-app navigation to /app/{slug}.
 */
import { useEffect } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  parseDeepLink,
  validatePendingDestination,
  PENDING_DEST_KEY,
  PENDING_DEST_TTL_MS,
} from './deepLinkProtocol';

interface RxDeepLinkPlugin {
  getLaunchLink(): Promise<{ url?: string }>;
  addListener(eventName: 'deepLink', listener: (data: { url: string }) => void): Promise<{ remove: () => void }>;
}
const RxDeepLink = registerPlugin<RxDeepLinkPlugin>('RxDeepLink');

/** Navigate to the destination a deep link addresses (validated). */
export function navigateFromDeepLink(url: unknown, navigate: (path: string) => void): boolean {
  const parsed = parseDeepLink(url);
  if (!parsed) return false;
  navigate(`/app/${parsed.slug}`);
  return true;
}

// ---- pending destination (install-then-continue flow, Phase 11) -----------

interface StoredPending {
  dest: string;
  at: number;
}

/** Persist a short-lived pending destination (?pending=/app/{slug}). */
export function savePendingDestination(dest: unknown): boolean {
  const valid = validatePendingDestination(dest);
  if (!valid) return false;
  try {
    const payload: StoredPending = { dest: valid, at: Date.now() };
    sessionStorage.setItem(PENDING_DEST_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** Consume the pending destination if it exists and is still fresh. */
export function consumePendingDestination(): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_DEST_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_DEST_KEY);
    const parsed: StoredPending = JSON.parse(raw);
    if (!parsed || typeof parsed.dest !== 'string') return null;
    if (Date.now() - Number(parsed.at || 0) > PENDING_DEST_TTL_MS) return null; // expired
    return validatePendingDestination(parsed.dest);
  } catch {
    return null;
  }
}

/** Peek at the pending destination WITHOUT consuming it (for display). */
export function peekPendingDestination(): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_DEST_KEY);
    if (!raw) return null;
    const parsed: StoredPending = JSON.parse(raw);
    if (!parsed || typeof parsed.dest !== 'string') return null;
    if (Date.now() - Number(parsed.at || 0) > PENDING_DEST_TTL_MS) return null;
    return validatePendingDestination(parsed.dest);
  } catch {
    return null;
  }
}

/**
 * Wire every deep-link source to the router. Call ONCE from App.
 * Handles: Electron events + cold-start pending link, Android launch link +
 * warm events, web ?pending= capture (from the SDK HTTPS fallback when RX
 * Store is not installed), and the install-then-continue restore.
 */
export function useDeepLinkNavigation(navigate: (path: string) => void): void {
  useEffect(() => {
    const cleanups: Array<() => void> = [];

    // 1. Web: capture a pending destination from the URL (?pending=/app/x).
    //    Short-lived, validated, stored in sessionStorage only (credentials
    //    never travel in links).
    try {
      const q = new URLSearchParams(window.location.search);
      const pending = q.get('pending');
      if (pending) {
        if (savePendingDestination(pending)) {
          // Remove the parameter from the address bar; the destination is
          // restored after install/launch via consumePendingDestination().
          q.delete('pending');
          const rest = q.toString();
          window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
        }
      }
    } catch { /* no window (SSR/tests) */ }

    // 2. Electron desktop: warm deep links + the cold-start pending link.
    try {
      if (window.rxDesktop?.isDesktop) {
        if (window.rxDesktop.onDeepLink) {
          const off = window.rxDesktop.onDeepLink((p) => { navigateFromDeepLink(p?.url, navigate); });
          if (typeof off === 'function') cleanups.push(off);
        }
        if (window.rxDesktop.getPendingDeepLink) {
          void window.rxDesktop.getPendingDeepLink().then((url) => {
            if (url) navigateFromDeepLink(url, navigate);
          }).catch(() => undefined);
        }
      }
    } catch { /* desktop bridge unavailable */ }

    // 3. Android: cold-start launch link + warm 'deepLink' events.
    try {
      if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
        void RxDeepLink.getLaunchLink().then((r) => {
          if (r?.url) navigateFromDeepLink(r.url, navigate);
        }).catch(() => undefined);
        void RxDeepLink.addListener('deepLink', (data) => {
          navigateFromDeepLink(data?.url, navigate);
        }).then((h) => {
          if (h && typeof h.remove === 'function') cleanups.push(() => { try { h.remove(); } catch { /* ignore */ } });
        }).catch(() => undefined);
      }
    } catch { /* android bridge unavailable */ }

    return () => {
      for (const off of cleanups) { try { off(); } catch { /* ignore */ } }
    };
  }, [navigate]);
}

/**
 * Restore a pending destination after RX Store is installed/launched.
 * Returns true when a destination was pending and has been navigated to.
 * Used by the Get-the-App flow ("Open RX Store to continue").
 */
export function restorePendingDestination(navigate: (path: string) => void): boolean {
  const dest = consumePendingDestination();
  if (!dest) return false;
  navigate(dest);
  return true;
}
