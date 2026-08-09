import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User, Notification } from '../types';
import { api, isApiConfigured, clearToken, API_URL } from '../services/api';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  register: (name: string, email: string, password: string, phone?: string) => Promise<boolean>;
  forgotPassword: (email: string) => Promise<{ message: string; resetToken?: string }>;
  resetPassword: (token: string, password: string) => Promise<void>;
  logout: () => void;
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
  const dispatchAuth = (u: any) => { try { window.dispatchEvent(new CustomEvent('rx-auth-change')); } catch {} };
  const [isLoading, setIsLoading] = useState(true);
  const [notifications, setNotifications] = useState<Notification[]>(() => {
    try { return loadNotifications(JSON.parse(localStorage.getItem('rx-store-user') || 'null')); } catch { return seedNotifications(); }
  });

  useEffect(() => {
    (async () => {
      const token = localStorage.getItem('rx-store-token');
      // A cached profile is display data, not proof of authentication. Only
      // restore it after the server validates the token; this prevents stale
      // demo/guest identities (such as the old Alex account) from signing in.
      if (isApiConfigured() && token) {
        try {
          const res: any = await api.auth.me();
          const me = res.user || res;
          if (!me?.id) throw new Error('Invalid session');
          const merged: User = {
            id: me.id,
            name: me.name,
            email: me.email,
            phone: me.phone,
            avatar: me.avatar || me.avatar_url || '👤',
            role: me.role || 'user',
            joinDate: me.joinDate || (me.created_at || '').slice(0,10) || new Date().toISOString().slice(0,10),
            downloadedApps: me.downloadedApps || [],
            subscriptions: me.subscriptions || [],
            notifications: me.notifications || [],
            preferences: me.preferences,
          };
          setUser(merged);
          localStorage.setItem('rx-store-user', JSON.stringify(merged));
        } catch {
          clearToken();
          localStorage.removeItem('rx-store-user');
          setUser(null);
          dispatchAuth(null);
        }
      } else {
        localStorage.removeItem('rx-store-user');
        setUser(null);
        dispatchAuth(null);
      }
      setIsLoading(false);
    })();
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
      clearToken();
      localStorage.removeItem('rx-store-user');
      setUser(null);
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
      clearToken();
      localStorage.removeItem('rx-store-user');
      setUser(null);
      const msg = String(e?.message || 'Registration failed');
      if (/fetch|network|account service|api not configured/i.test(msg)) {
        throw new Error('RX Store cannot reach the account service. Check your connection and try again.');
      }
      throw e;
    } finally {
      setIsLoading(false);
    }
  };

  const forgotPassword = async (email: string): Promise<{ message: string; resetToken?: string }> => {
    const res: any = await api.auth.forgotPassword(email);
    return { message: res.message || 'Reset email sent', resetToken: res.resetToken };
  };
  const resetPassword = async (token: string, password: string): Promise<void> => {
    await api.auth.resetPassword(token, password);
  };

  const logout = () => {
    if (isApiConfigured()) api.auth.logout().catch(() => {});
    clearToken();
    setUser(null);
    localStorage.removeItem('rx-store-user');
    dispatchAuth(null);
    try { localStorage.removeItem('rx-store-installed'); } catch {}
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
