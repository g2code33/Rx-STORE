import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User, Notification } from '../types';
import { api, isApiConfigured, clearToken } from '../services/api';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  register: (name: string, email: string, password: string) => Promise<boolean>;
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
  avatar: '👨‍⚕️',
  role: 'user',
  joinDate: '2024-01-15',
  downloadedApps: ['clinical-rx', 'curelink', 'pharma-game'],
  subscriptions: [
    {
      id: 'sub-1',
      appId: 'clinical-rx',
      plan: 'Professional',
      status: 'active',
      startDate: '2024-01-15',
      endDate: '2025-01-15',
      amount: 29.99,
    },
    {
      id: 'sub-2',
      appId: 'curelink',
      plan: 'Standard',
      status: 'active',
      startDate: '2024-06-01',
      endDate: '2025-06-01',
      amount: 19.99,
    },
  ],
  notifications: mockNotifications,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
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
          const { user: me } = await api.auth.me();
          if (me) {
            setUser(me);
            localStorage.setItem('rx-store-user', JSON.stringify(me));
          }
        } catch {
          // token invalid — keep mock/local user
        }
      }
      setIsLoading(false);
    })();
  }, []);

  const login = async (email: string, password: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      if (isApiConfigured()) {
        const { user: apiUser } = await api.auth.login(email, password);
        setUser(apiUser);
        localStorage.setItem('rx-store-user', JSON.stringify(apiUser));
        return true;
      }
    } catch {
      // fall through to mock
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    // demo: accept any credentials when offline
    const demoUser = { ...mockUser, email };
    setUser(demoUser);
    localStorage.setItem('rx-store-user', JSON.stringify(demoUser));
    setIsLoading(false);
    return true;
  };

  const register = async (name: string, email: string, password: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      if (isApiConfigured()) {
        const { user: apiUser } = await api.auth.register(name, email, password);
        setUser(apiUser);
        localStorage.setItem('rx-store-user', JSON.stringify(apiUser));
        setIsLoading(false);
        return true;
      }
    } catch {
      // fall through
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    const newUser = { ...mockUser, name, email };
    setUser(newUser);
    localStorage.setItem('rx-store-user', JSON.stringify(newUser));
    setIsLoading(false);
    return true;
  };

  const logout = () => {
    if (isApiConfigured()) api.auth.logout().catch(() => {});
    clearToken();
    setUser(null);
    localStorage.removeItem('rx-store-user');
  };

  const updateProfile = (updates: Partial<User>) => {
    if (user) {
      const updatedUser = { ...user, ...updates };
      setUser(updatedUser);
      localStorage.setItem('rx-store-user', JSON.stringify(updatedUser));
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
