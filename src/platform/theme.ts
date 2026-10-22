/**
 * RX Store — appearance (theme) preference.
 *
 * Three choices, ONE source of truth:
 *   'light'  — always the light storefront
 *   'dark'   — always the dark storefront (the original look)
 *   'system' — follow the operating system's appearance, live
 *
 * The resolved theme is written as `<html data-theme="light|dark">` and every
 * colour in the app is driven from there:
 *   - the surface ramp (`--rx-dark`, `--rx-dark-secondary`, `--rx-dark-tertiary`)
 *   - the ink/overlay base (`--rx-ink`, which backs every `text-white` /
 *     `bg-white/5` / `border-white/10` utility)
 *   - the muted text colour (`--rx-muted`, which backs `text-rx-gray-medium`)
 * plus a handful of literal-colour corrections in `index.css`.
 *
 * Nothing here touches React, the DOM or storage at import time, so the exact
 * rules can be unit-tested (see theme.test.ts) and the same functions run in
 * the browser, the Electron renderer and the Android WebView.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/** localStorage key shared with the pre-paint script in index.html. */
export const THEME_STORAGE_KEY = 'rx-theme';

/**
 * Default = 'dark'.
 *
 * The storefront shipped dark-only; switching every existing visitor to a new
 * palette on deploy would be a silent redesign. Light and System are explicit
 * choices the user makes in Settings, and the choice is remembered.
 */
export const DEFAULT_THEME: ThemePreference = 'dark';

/** The choices rendered in Settings, in display order. */
export const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  description: string;
}> = [
  { value: 'light', label: 'Light', description: 'Bright surfaces, dark text' },
  { value: 'dark', label: 'Dark', description: 'The original RX Store look' },
  { value: 'system', label: 'System', description: 'Match this device’s appearance setting' },
];

/** Anything unknown (old values, corrupted storage, an API field) → 'system'. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'light' || v === 'dark' || v === 'system') return v as ThemePreference;
  return 'system';
}

/** True when the operating system currently asks for a dark UI. */
export function systemPrefersDark(win?: {
  matchMedia?: (q: string) => { matches?: boolean } | null;
} | null): boolean {
  try {
    const mq = win?.matchMedia?.('(prefers-color-scheme: dark)');
    return !!mq?.matches;
  } catch {
    return false; // a broken matchMedia must never break the app
  }
}

/** Resolve a preference (+ the current system answer) to the theme to paint. */
export function resolveTheme(pref: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

/** Read the stored preference. Never throws (private mode, disabled storage). */
export function readStoredTheme(storage?: { getItem: (k: string) => string | null } | null): ThemePreference {
  try {
    const raw = storage?.getItem(THEME_STORAGE_KEY);
    if (raw == null) return DEFAULT_THEME;
    // A stored value is always one of the three; normalize defensively anyway.
    return normalizeThemePreference(raw);
  } catch {
    return DEFAULT_THEME;
  }
}

/** Persist the preference. Failing to persist must never break the toggle. */
export function storeTheme(
  pref: ThemePreference,
  storage?: { setItem: (k: string, v: string) => void } | null,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, normalizeThemePreference(pref));
  } catch {
    /* storage disabled — the in-memory preference still applies */
  }
}

/**
 * Paint the theme: `data-theme` on <html> (CSS) + `color-scheme` (native
 * scrollbars, form controls, `prefers-color-scheme` inside the page) + the
 * document background so an overscroll/blank area never flashes the wrong
 * colour.
 */
export function applyTheme(resolved: ResolvedTheme, doc?: any): void {
  const d = doc ?? (typeof document !== 'undefined' ? document : null);
  if (!d?.documentElement) return;
  const el = d.documentElement;
  el.setAttribute('data-theme', resolved);
  // Non-React consumers (e.g. the Live Website Builder's design tokens) need to
  // know the surface ramp changed, so they can re-apply their own variables.
  try {
    d?.dispatchEvent?.(new CustomEvent('rx-theme-applied', { detail: { theme: resolved } }));
  } catch { /* no CustomEvent in this runtime — consumers read currentTheme() instead */ }
  try {
    // `colorScheme` is the standard property; the style attribute keeps older
    // WebViews (Android 8/9) in sync too.
    el.style.colorScheme = resolved;
    el.style.setProperty('color-scheme', resolved);
  } catch {
    /* non-fatal */
  }
}

/** The theme currently painted on the document (used by non-React code). */
export function currentTheme(doc?: any): ResolvedTheme {
  const d = doc ?? (typeof document !== 'undefined' ? document : null);
  const attr = d?.documentElement?.getAttribute?.('data-theme');
  return attr === 'light' ? 'light' : 'dark';
}

/** Apply the stored preference immediately (called before React renders). */
export function applyStoredTheme(
  opts: { storage?: any; win?: any; doc?: any } = {},
): ThemePreference {
  const storage = opts.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  const win = opts.win ?? (typeof window !== 'undefined' ? window : null);
  const pref = readStoredTheme(storage);
  applyTheme(resolveTheme(pref, systemPrefersDark(win)), opts.doc);
  return pref;
}
