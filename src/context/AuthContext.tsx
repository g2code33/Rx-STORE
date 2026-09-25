import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { User, Notification } from '../types';
import { api, isApiConfigured, clearToken, attemptRefresh, API_URL } from '../services/api';
import { syncDeviceOnAuth, heartbeatDevice } from '../native/accountSync';
import { clearAccountData } from '../native/cache';
import { hydrateCredentialStorage, getRefreshTokenSync } from '../native/credentialStore';
import { restoreSession } from '../native/sessionRestore';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  register: (name: string, email: string, password: string, phone?: string) => Promise<boolean>;
  forgotPassword: (email: string) => Promise<{ message: string; delivery?: string; resetToken?: string }>;
  completeOAuth: (code: string) => Promise<{ status?: string; redirect?: string }>;
  oauthLinkConfirm: (token: string, password: string) => Promise<{ status?: string; redirect?: string }>;
  resetPassword: (token: string, password: string) => Promise<void>;
  logout: (opts?: { allDevices?: boolean }) => void;
  updateProfile: (updates: Partial<User>) => Promise<void>;
  notifications: Notification[];
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Single honest onboarding notification — real events (installs, updates) are
// appended as they happen; nothing here is fabricated.
const seedNotifications = (): Notification[] => [
  {
    id: 'welcome',
    type: 'system',
    title: 'Welcome to RX Store',
    message: 'Explore the marketplace — installs, updates and account alerts will appear here.',
    date: new Date().toISOString().slice(0, 10),
    read: false,
  },
];

const notifKey = (u: any) => `rx-store-notifs-${u?.id || 'guest'}`;
const loadNotifications = (u: any): Notification[] => {
  try {
    const s = localStorage.getItem(notifKey(u));
    if (s) { const arr = JSON.parse(s); if (Array.isArray(arr)) return arr; }
  } catch { /* fall through */ }
  return seedNotifications();
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  // Mirrors `user` for the offline-retry path (no re-render needed) so a
  // restored session stops retrying on every foreground/online event.
  const userRef = useRef<User | null>(null);
  const dispatchAuth = (u: any) => { try { window.dispatchEvent(new CustomEvent('rx-auth-change')); } catch {} };
  const [isLoading, setIsLoading] = useState(true);
  const [notifications, setNotifications] = useState<Notification[]>(() => {
    try { return loadNotifications(JSON.parse(localStorage.getItem('rx-store-user') || 'null')); } catch { return seedNotifications(); }
  });

  useEffect(() => {
    let cancelled = false;
    let restoring = false;
    // A cached profile is display data, not proof of authentication. Only the
    // server (via /users/me or a refresh) can restore a signed-in user; this
    // prevents stale demo/guest identities from signing in.

    const toUser = (me: any): User => ({
      id: me.id,
      name: me.name,
      email: me.email,
      phone: me.phone,
      avatar: me.avatar || me.avatar_url || '👤',
      role: me.role || 'user',
      joinDate: me.joinDate || (me.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
      downloadedApps: me.downloadedApps || [],
      subscriptions: me.subscriptions || [],
      notifications: me.notifications || [],
      preferences: me.preferences,
    });

    const run = async () => {
      if (restoring) return;
      restoring = true;
      try {
        if (!isApiConfigured()) {
          localStorage.removeItem('rx-store-user');
          if (!cancelled) { setUser(null); dispatchAuth(null); }
          return;
        }
        // Reconcile the durable credential copies FIRST (Android native
        // Keystore storage ↔ localStorage, incl. the v1→v2 auth-storage
        // migration). No-op on web/desktop.
        await hydrateCredentialStorage();

        const result = await restoreSession({
          hasAccessToken: () => !!localStorage.getItem('rx-store-token'),
          hasRefreshToken: () => !!getRefreshTokenSync(),
          fetchMe: () => api.auth.me(),
          attemptRefresh,
          clearCredentials: () => clearToken(),
          // request() attaches .status to HTTP errors; raw fetch failures
          // (offline/DNS) do not have one.
          isNetworkError: (e: any) => !e?.status,
        });
        if (cancelled) return;
        if (result.status === 'authenticated') {
          const merged = toUser(result.user);
          userRef.current = merged;
          setUser(merged);
          localStorage.setItem('rx-store-user', JSON.stringify(merged));
          dispatchAuth(merged);
        } else if (result.status === 'signed-out') {
          userRef.current = null;
          clearToken();
          localStorage.removeItem('rx-store-user');
          setUser(null);
          dispatchAuth(null);
        }
        // 'offline': keep every stored credential — the session is still valid
        // server-side; the retry below restores the user once we reconnect.
        // (The cached profile is never shown as proof of authentication.)
      } finally {
        restoring = false;
        if (!cancelled) setIsLoading(false);
      }
    };

    void run();

    // Offline launch / transient server failure must not permanently strand a
    // signed-in user on the Sign In page: retry restoration when connectivity
    // returns or the app becomes visible again, while a credential remains.
    const retryIfPending = () => {
      if (cancelled || restoring || userRef.current) return;
      if (!localStorage.getItem('rx-store-token') && !getRefreshTokenSync()) return;
      void run();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') retryIfPending(); };
    window.addEventListener('online', retryIfPending);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('online', retryIfPending);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const login = async (email: string, password: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      if (!isApiConfigured()) throw new Error('RX Store cannot reach the account service. Please try again shortly.');
      const { user: apiUser } = await api.auth.login(email, password);
      setUser(apiUser);
      localStorage.setItem('rx-store-user', JSON.stringify(apiUser));
      dispatchAuth(apiUser);
      return true;
    } catch (e: any) {
      // A failed sign-in attempt establishes nothing: do NOT clear stored
      // credentials or the current user — a network hiccup while signing into
      // a second account must not sign this device out of the first one.
      const msg = String(e?.message || 'Sign in failed');
      if (/invalid|credential|not found|401|403/i.test(msg)) {
        throw new Error('Incorrect email/phone or password. If you do not have an account, choose Sign Up first.');
      }
      if (/fetch|network|account service|api not configured/i.test(msg)) {
        throw new Error('RX Store cannot reach the account service. Check your connection and try again.');
      }
      throw e;
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (name: string, email: string, password: string, phone?: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      if (!isApiConfigured()) throw new Error('RX Store cannot reach the account service. Please try again shortly.');
      const { user: apiUser } = await api.auth.register(name, email, password, phone);
      setUser(apiUser);
      localStorage.setItem('rx-store-user', JSON.stringify(apiUser));
      dispatchAuth(apiUser);
      return true;
    } catch (e: any) {
      const msg = String(e?.message || 'Registration failed');
      if (/fetch|network|account service|api not configured/i.test(msg)) {
        throw new Error('RX Store cannot reach the account service. Check your connection and try again.');
      }
      throw e;
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Confirm SAFE provider linking: attach a provider identity to the existing
   * account after proving its password (Phase 5). Issues a normal session.
   */
  const oauthLinkConfirm = async (token: string, password: string): Promise<{ status?: string; redirect?: string }> => {
    setIsLoading(true);
    try {
      if (!isApiConfigured()) throw new Error('RX Store cannot reach the account service. Please try again shortly.');
      const { user: apiUser, status, redirect } = await api.auth.oauthLinkConfirm(token, password);
      setUser(apiUser);
      userRef.current = apiUser;
      localStorage.setItem('rx-store-user', JSON.stringify(apiUser));
      dispatchAuth(apiUser);
      return { status, redirect };
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Complete an OAuth sign-in with the one-time completion code (from the
   * /oauth/callback page or a pairing code typed on another device). Issues a
   * NORMAL session — identical to password login from here on.
   */
  const completeOAuth = async (code: string): Promise<{ status?: string; redirect?: string }> => {
    setIsLoading(true);
    try {
      if (!isApiConfigured()) throw new Error('RX Store cannot reach the account service. Please try again shortly.');
      const { user: apiUser, status, redirect } = await api.auth.oauthComplete(code);
      setUser(apiUser);
      userRef.current = apiUser;
      localStorage.setItem('rx-store-user', JSON.stringify(apiUser));
      dispatchAuth(apiUser);
      return { status, redirect };
    } finally {
      setIsLoading(false);
    }
  };

  const forgotPassword = async (email: string): Promise<{ message: string; delivery?: string; resetToken?: string }> => {
    const res: any = await api.auth.forgotPassword(email);
    // `delivery` ('sent' | 'unconfigured' | 'failed' | 'debug') keeps the UI
    // truthful — the server never claims an email was sent when it wasn't.
    return { message: res.message || 'Reset email sent', delivery: res.delivery, resetToken: res.resetToken };
  };
  const resetPassword = async (token: string, password: string): Promise<void> => {
    await api.auth.resetPassword(token, password);
  };

  const logout = (opts?: { allDevices?: boolean }) => {
    // Revoke the session server-side (current session, or all devices). This
    // NEVER uninstalls applications — sessions and installations are separate.
    if (isApiConfigured()) api.auth.logout({ allDevices: opts?.allDevices }).catch(() => {});
    clearToken();
    userRef.current = null;
    setUser(null);
    localStorage.removeItem('rx-store-user');
    dispatchAuth(null);
    // Remove ALL account-scoped cached state (installs, pending sync work,
    // in-flight transactions) so a different account can never inherit it.
    // The device identity and the public catalog deliberately survive.
    try { clearAccountData(); } catch { /* never block sign-out */ }
  };

  const updateProfile = async (updates: Partial<User>) => {
    if (!user) throw new Error('Sign in required');
    if (!isApiConfigured()) throw new Error('Account service unavailable');
    const res: any = await api.auth.updateProfile({
      name: updates.name,
      email: updates.email,
      preferences: updates.preferences,
    });
    const serverUser = res.user || res;
    const updatedUser = { ...user, ...updates, ...serverUser };
    setUser(updatedUser);
    localStorage.setItem('rx-store-user', JSON.stringify(updatedUser));
    dispatchAuth(updatedUser);
  };

  // Load this user's notifications whenever the signed-in user changes
  useEffect(() => {
    setNotifications(loadNotifications(user));
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Register the current device with the account and keep it "seen". Device
  // identity is stable per install (survives restart + login/logout) and never
  // leaks IP/hardware IDs. Best-effort — never blocks auth. Heartbeat ~15 min
  // plus on foreground return; RX Store stays usable offline.
  useEffect(() => {
    if (!user?.id || !isApiConfigured()) return;
    void syncDeviceOnAuth();
    const t = setInterval(() => void heartbeatDevice(), 15 * 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void heartbeatDevice(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Logged-in users: live server feed (admin broadcasts, release alerts, update notices), polled
  useEffect(() => {
    if (!user?.id || !isApiConfigured()) return;
    let stop = false;
    const pull = async () => {
      try {
        const res = await fetch(`${API_URL}/notifications`, {
          headers: { Authorization: `Bearer ${localStorage.getItem('rx-store-token') || ''}` },
        });
        const j = await res.json();
        if (!stop && res.ok && Array.isArray(j?.data?.notifications)) setNotifications(j.data.notifications);
      } catch { /* keep last known list */ }
    };
    pull();
    const t = setInterval(pull, 60_000);
    return () => { stop = true; clearInterval(t); };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist read-state per user so the badge survives reloads
  useEffect(() => {
    try { localStorage.setItem(notifKey(user), JSON.stringify(notifications)); } catch { /* quota */ }
  }, [notifications]); // eslint-disable-line react-hooks/exhaustive-deps

  const markNotificationRead = (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
    if (user?.id && isApiConfigured()) {
      fetch(`${API_URL}/notifications/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('rx-store-token') || ''}` },
        body: JSON.stringify({ ids: [id] }),
      }).catch(() => {});
    }
  };

  const markAllNotificationsRead = () => {
    setNotifications((prev) => {
      if (user?.id && isApiConfigured()) {
        const ids = prev.filter((n) => !n.read).map((n) => n.id);
        if (ids.length) {
          fetch(`${API_URL}/notifications/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('rx-store-token') || ''}` },
            body: JSON.stringify({ ids }),
          }).catch(() => {});
        }
      }
      return prev.map((n) => ({ ...n, read: true }));
    });
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        login,
        register,
        completeOAuth,
        oauthLinkConfirm,
        forgotPassword,
        resetPassword,
        logout,
        updateProfile,
        notifications,
        markNotificationRead,
        markAllNotificationsRead,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
