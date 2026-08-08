import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User, Notification } from '../types';
import { api, isApiConfigured, clearToken } from '../services/api';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  register: (name: string, email: string, password: string, phone?: string) => Promise<boolean>;
  forgotPassword: (email: string) => Promise<string>;
  resetPassword: (token: string, password: string) => Promise<void>;
  logout: () => void;
  updateProfile: (updates: Partial<User>) => void;
  notifications: Notification[];
  markNotificationRead: (id: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const mockNotifications: Notification[] = [
  {
    id: 'n1',
    type: 'update',
    title: 'Clinical Rx Update Available',
    message: 'Version 3.2.1 is now available with AI-powered drug interaction predictions.',
    date: '2024-12-20',
    read: false,
  },
  {
    id: 'n2',
    type: 'system',
    title: 'Welcome to RX Store',
    message: 'Explore our marketplace and discover amazing applications for healthcare, education, and more.',
    date: '2024-12-19',
    read: false,
  },
  {
    id: 'n3',
    type: 'download',
    title: 'Download Complete',
    message: 'CureLink has been successfully downloaded and is ready to use.',
    date: '2024-12-18',
    read: true,
  },
];

const mockUser: User = {
  id: 'user-1',
  name: 'Dr. Alex Morgan',
  email: 'alex.morgan@healthcare.com',
  phone: '+233000000000',
  avatar: '👨‍⚕️',
  role: 'user',
  joinDate: '2024-01-15',
  downloadedApps: [],
  subscriptions: [],
  notifications: mockNotifications,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const dispatchAuth = (u: any) => { try { window.dispatchEvent(new CustomEvent('rx-auth-change')); } catch {} };
  const [isLoading, setIsLoading] = useState(true);
  const [notifications, setNotifications] = useState<Notification[]>(mockNotifications);

  useEffect(() => {
    (async () => {
      const savedUser = localStorage.getItem('rx-store-user');
      if (savedUser) {
        try { setUser(JSON.parse(savedUser)); } catch { /* ignore */ }
      }
      // If API configured and token exists, validate session
      if (isApiConfigured() && localStorage.getItem('rx-store-token')) {
        try {
          const res: any = await api.auth.me();
          const me = res.user || res;
          if (me && me.id) {
            // Merge with existing to keep subscriptions etc. if backend returns minimal
            const merged: any = {
              id: me.id,
              name: me.name,
              email: me.email,
              phone: me.phone,
              avatar: me.avatar || me.avatar_url || '👤',
              role: me.role || 'user',
              joinDate: me.joinDate || (me.created_at || '').slice(0,10) || new Date().toISOString().slice(0,10),
              downloadedApps: me.downloadedApps || [],
              subscriptions: me.subscriptions || [],
              notifications: me.notifications || mockNotifications,
            };
            setUser(merged);
            localStorage.setItem('rx-store-user', JSON.stringify(merged));
          }
        } catch {
          // token invalid — keep local user
        }
      }
      setIsLoading(false);
    })();
  }, []);

  const login = async (email: string, password: string): Promise<boolean> => {
    setIsLoading(true);
    if (isApiConfigured()) {
      try {
        const { user: apiUser } = await api.auth.login(email, password);
        setUser(apiUser);
        localStorage.setItem('rx-store-user', JSON.stringify(apiUser));
        dispatchAuth(apiUser);
        setIsLoading(false);
        return true;
      } catch (e: any) {
        setIsLoading(false);
        // Don't fallback to mock when API is live — show real error (wrong password etc.)
        const msg = e.message || 'Login failed';
        // Only fallback to mock if it's a network/config error, not auth error
        if (msg.includes('Invalid credentials') || msg.includes('not found') || msg.includes('401') || msg.includes('403')) {
          throw e;
        }
        // Network error — allow mock fallback for offline demo
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('API not configured')) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          const demoUser = { ...mockUser, email, downloadedApps: [], subscriptions: [] };
          setUser(demoUser);
          localStorage.setItem('rx-store-user', JSON.stringify(demoUser));
          dispatchAuth(demoUser);
          return true;
        }
        throw e;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    const demoUser = { ...mockUser, email };
    setUser(demoUser);
    localStorage.setItem('rx-store-user', JSON.stringify(demoUser));
    setIsLoading(false);
    return true;
  };

  const register = async (name: string, email: string, password: string, phone?: string): Promise<boolean> => {
    setIsLoading(true);
    if (isApiConfigured()) {
      try {
        const { user: apiUser } = await api.auth.register(name, email, password, phone);
        setUser(apiUser);
        localStorage.setItem('rx-store-user', JSON.stringify(apiUser));
        dispatchAuth(apiUser);
        setIsLoading(false);
        return true;
      } catch (e: any) {
        setIsLoading(false);
        const msg = e.message || '';
        if (msg.includes('already registered') || msg.includes('Invalid email') || msg.includes('Password') || msg.includes('phone')) throw e;
        if (msg.includes('Failed to fetch') || msg.includes('API not configured')) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          const newUser = { ...mockUser, name, email, phone, downloadedApps: [], subscriptions: [] };
          setUser(newUser);
          localStorage.setItem('rx-store-user', JSON.stringify(newUser));
          dispatchAuth(newUser);
          return true;
        }
        throw e;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    const newUser = { ...mockUser, name, email, phone, downloadedApps: [], subscriptions: [] };
    setUser(newUser);
    localStorage.setItem('rx-store-user', JSON.stringify(newUser));
    dispatchAuth(newUser);
    setIsLoading(false);
    return true;
  };

  const forgotPassword = async (email: string): Promise<string> => {
    const res: any = await api.auth.forgotPassword(email);
    return res.message || 'Reset email sent';
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

  const updateProfile = (updates: Partial<User>) => {
    if (user) {
      const updatedUser = { ...user, ...updates };
      setUser(updatedUser);
      localStorage.setItem('rx-store-user', JSON.stringify(updatedUser));
      dispatchAuth(updatedUser);
    }
  };

  const markNotificationRead = (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
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
