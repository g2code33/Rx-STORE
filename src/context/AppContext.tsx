import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { App, AppCategory } from '../types';
import { api, isApiConfigured } from '../services/api';

interface AppContextType {
  apps: App[];
  isLoading: boolean;
  error: string | null;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  selectedCategory: AppCategory | null;
  setSelectedCategory: (category: AppCategory | null) => void;
  selectedPlatform: string | null;
  setSelectedPlatform: (platform: string | null) => void;
  getFilteredApps: () => App[];
  getAppById: (id: string) => App | undefined;
  getAppBySlug: (slug: string) => App | undefined;
  getAppsByCategory: (category: AppCategory) => App[];
  installedApps: string[];
  installApp: (appId: string) => void;
  uninstallApp: (appId: string) => void;
  refresh: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  // Real data only — never seed from the mock dataset.
  const [apps, setApps] = useState<App[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<AppCategory | null>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);
  const [installedApps, setInstalledApps] = useState<string[]>(() => {
    // Brand new site: start empty. Per-user key to avoid new accounts seeing old installs.
    const userStr = localStorage.getItem('rx-store-user');
    let userId = '';
    try { userId = userStr ? JSON.parse(userStr).id : ''; } catch {}
    const key = userId ? `rx-store-installed-${userId}` : 'rx-store-installed';
    const saved = localStorage.getItem(key) || localStorage.getItem('rx-store-installed');
    if (saved) { try { const arr = JSON.parse(saved); return Array.isArray(arr) ? arr : []; } catch {} }
    return [];
  });

  const refresh = async () => {
    if (!isApiConfigured()) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.apps.list({ limit: 100 });
      if (data.apps && Array.isArray(data.apps)) {
        const normalized = (data.apps as any[]).map((a) => normalizeApp(a));
        setApps(normalized);
      }
    } catch (e: any) {
      setError(e.message || 'Failed to load apps');
    } finally {
      setIsLoading(false);
    }
  };

  // Tolerates both JSON strings (raw D1 rows) and already-parsed arrays
  const asArray = (v: any): string[] | null => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); if (Array.isArray(p)) return p; } catch {} }
    return null;
  };

  // Normalize platform ids: fixes the stored "andriod" typo and dedupes
  const normPlatforms = (v: any): string[] => {
    const arr = (asArray(v) || []).map((p: any) => String(p).toLowerCase().trim());
    const fixed = arr.map((p) => (p === 'andriod' ? 'android' : p));
    return [...new Set(fixed)];
  };

  const normalizeApp = (a: any): App => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    description: a.description || '',
    longDescription: a.longDescription || a.long_description || a.description || '',
    category: a.category,
    tags: asArray(a.tags) || [],
    icon: a.icon || '📦',
    color: a.color || '#FFD600',
    gradient: a.gradient || 'from-rx-dark to-rx-dark-secondary',
    screenshots: asArray(a.screenshots) || [],
    version: a.version || a.current_version || '1.0.0',
    size: a.size || (a.size_mb ? `${a.size_mb} MB` : '—'),
    developer: a.developer || 'Calcitonin Technologies',
    rating: a.rating ?? 0,
    reviewCount: a.reviewCount ?? a.review_count ?? 0,
    downloadCount: a.downloadCount ?? a.download_count ?? 0,
    price: (a.price as any) || a.price_type || 'free',
    priceAmount: a.priceAmount ?? a.price_amount,
    platforms: normPlatforms(a.platforms) as any,
    releaseDate: a.releaseDate || a.release_date || a.created_at || '',
    lastUpdated: a.lastUpdated || a.last_updated || a.updated_at || '',
    releaseNotes: asArray(a.releaseNotes) || asArray(a.release_notes) || ['Latest stable release'],
    features: asArray(a.features)?.length ? asArray(a.features)! : ['Secure & Verified', 'Cross-platform', 'Auto-updates'],
    status: a.status || 'active',
    // D1 stores these as 0/1 integers — coerce to booleans or `{0 && <span>}` leaks a "0" into the UI
    isFeatured: !!(a.isFeatured ?? a.is_featured),
    isNew: !!(a.isNew ?? a.is_new),
    isTrending: !!(a.isTrending ?? a.is_trending),
  });

  useEffect(() => {
    if (isApiConfigured()) refresh();
    const onRefresh = () => refresh();
    window.addEventListener('rx-refresh', onRefresh);
    (window as any).rxRefreshApps = refresh;
    return () => window.removeEventListener('rx-refresh', onRefresh);
  }, []);

  const getFilteredApps = () => {
    let filtered = apps;

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (app) =>
          app.name.toLowerCase().includes(query) ||
          app.description.toLowerCase().includes(query) ||
          app.tags.some((tag) => tag.toLowerCase().includes(query)) ||
          app.category.toLowerCase().includes(query)
      );
    }

    if (selectedCategory) {
      filtered = filtered.filter((app) => app.category === selectedCategory);
    }

    if (selectedPlatform) {
      filtered = filtered.filter((app) =>
        app.platforms.includes(selectedPlatform as any)
      );
    }

    return filtered;
  };

  const getAppById = (id: string) => apps.find((app) => app.id === id);
  const getAppBySlug = (slug: string) => apps.find((app) => app.slug === slug);
  const getAppsByCategory = (category: AppCategory) =>
    apps.filter((app) => app.category === category);

  const getInstalledKey = () => {
    try {
      const u = localStorage.getItem('rx-store-user');
      const uid = u ? JSON.parse(u).id : '';
      return uid ? `rx-store-installed-${uid}` : 'rx-store-installed';
    } catch { return 'rx-store-installed'; }
  };

  const installApp = (appId: string) => {
    setInstalledApps((prev) => {
      if (prev.includes(appId)) return prev;
      const updated = [...prev, appId];
      localStorage.setItem(getInstalledKey(), JSON.stringify(updated));
      localStorage.setItem('rx-store-installed', JSON.stringify(updated)); // keep legacy for fallback
      return updated;
    });
  };

  const uninstallApp = (appId: string) => {
    setInstalledApps((prev) => {
      const updated = prev.filter((id) => id !== appId);
      localStorage.setItem(getInstalledKey(), JSON.stringify(updated));
      localStorage.setItem('rx-store-installed', JSON.stringify(updated));
      return updated;
    });
  };

  // Reload per-user installs when user changes (login/logout)
  useEffect(() => {
    const h = () => {
      const key = getInstalledKey();
      const saved = localStorage.getItem(key) || localStorage.getItem('rx-store-installed');
      if (saved) { try { const arr = JSON.parse(saved); setInstalledApps(Array.isArray(arr)?arr:[]); return; } catch {} }
      setInstalledApps([]);
    };
    window.addEventListener('storage', h);
    // also listen for auth changes via custom event
    window.addEventListener('rx-auth-change', h as any);
    return () => { window.removeEventListener('storage', h); window.removeEventListener('rx-auth-change', h as any); };
  }, []);

  return (
    <AppContext.Provider
      value={{
        apps,
        isLoading,
        error,
        searchQuery,
        setSearchQuery,
        selectedCategory,
        setSelectedCategory,
        selectedPlatform,
        setSelectedPlatform,
        getFilteredApps,
        getAppById,
        getAppBySlug,
        getAppsByCategory,
        installedApps,
        installApp,
        uninstallApp,
        refresh,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApps() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApps must be used within an AppProvider');
  }
  return context;
}
