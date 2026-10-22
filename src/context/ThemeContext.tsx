/**
 * RX Store — theme context.
 *
 * Owns the user's appearance preference and paints it. The preference lives in
 * two places on purpose:
 *
 *   1. localStorage (`rx-theme`) — applies instantly, before sign-in, and is
 *      what the pre-paint script in index.html reads (no flash of the wrong
 *      theme on load).
 *   2. the account (`user.preferences.theme`) — so the choice follows the user
 *      to their other devices when they sign in.
 *
 * When the account has an opinion it wins on sign-in; when it does not (all
 * existing accounts) the device preference is kept and never overwritten.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext.tsx';
import {
  DEFAULT_THEME,
  applyTheme,
  normalizeThemePreference,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  systemPrefersDark,
  type ResolvedTheme,
  type ThemePreference,
} from '../platform/theme.ts';

interface ThemeContextValue {
  /** What the user chose: light | dark | system. */
  preference: ThemePreference;
  /** What is actually painted right now (system resolved). */
  resolved: ResolvedTheme;
  /** True when the device's OS asks for dark and the preference is 'system'. */
  systemDark: boolean;
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/** The account preference (if the user ever set one on any device). */
function accountTheme(user: any): ThemePreference | null {
  const raw = user?.preferences?.theme;
  if (raw == null || raw === '') return null;
  return normalizeThemePreference(raw);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { user, updateProfile } = useAuth();
  const isAuthenticated = !!user;

  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    const stored = readStoredTheme(typeof localStorage !== 'undefined' ? localStorage : null);
    return stored ?? DEFAULT_THEME;
  });
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    systemPrefersDark(typeof window !== 'undefined' ? window : null),
  );

  const resolved = useMemo(() => resolveTheme(preference, systemDark), [preference, systemDark]);

  // Paint on every change (cheap: two attributes on <html>).
  useEffect(() => {
    applyTheme(resolved);
    // Desktop shell: keep the native window background / menus / dialogs in
    // step (no dark flash before first paint, matching native selects).
    try {
      (window as any).rxDesktop?.setTheme?.(preference);
    } catch { /* an older shell without the bridge simply ignores it */ }
  }, [resolved, preference]);

  // Follow the OS live while the preference is 'system'. The listener is always
  // attached (it also keeps the "System" label honest), and resolving is pure.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(!!mq.matches);
    onChange();
    // Safari < 14 only supports addListener.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener?.(onChange);
    return () => mq.removeListener?.(onChange);
  }, []);

  // Adopt the account preference once it is known (sign-in / refresh), and only
  // when the account actually stored one — never clobber a device choice.
  const adoptedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!isAuthenticated || !user?.id) return;
    if (adoptedFor.current === user.id) return;
    adoptedFor.current = user.id;
    const fromAccount = accountTheme(user);
    if (!fromAccount) return;
    if (fromAccount === preference) return;
    setPreferenceState(fromAccount);
    storeTheme(fromAccount, typeof localStorage !== 'undefined' ? localStorage : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user?.id, user?.preferences?.theme]);

  const setPreference = useCallback((pref: ThemePreference) => {
    const next = normalizeThemePreference(pref);
    setPreferenceState(next);
    storeTheme(next, typeof localStorage !== 'undefined' ? localStorage : null);
    applyTheme(resolveTheme(next, systemPrefersDark(typeof window !== 'undefined' ? window : null)));
    // Mirror to the account so the choice follows the user across devices.
    // A failed sync must never block the local toggle.
    if (isAuthenticated) {
      // Keep every other saved preference; only the theme changes.
      const merged = { ...(user?.preferences || {}), theme: next } as any;
      Promise.resolve(updateProfile?.({ preferences: merged })).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user?.preferences, updateProfile]);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, systemDark, setPreference }),
    [preference, resolved, systemDark, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Access the appearance preference. Safe outside the provider (dark default). */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx) return ctx;
  return {
    preference: DEFAULT_THEME,
    resolved: 'dark',
    systemDark: true,
    setPreference: () => {},
  };
}
