import React, { createContext, useContext, useState, ReactNode } from 'react';
import { App, AppCategory } from '../types';
import { apps as initialApps } from '../data/apps';

interface AppContextType {
  apps: App[];
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
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [apps] = useState<App[]>(initialApps);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<AppCategory | null>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);
  const [installedApps, setInstalledApps] = useState<string[]>(() => {
    const saved = localStorage.getItem('rx-store-installed');
    return saved ? JSON.parse(saved) : ['clinical-rx', 'curelink'];
  });

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

  const installApp = (appId: string) => {
    setInstalledApps((prev) => {
      const updated = [...prev, appId];
      localStorage.setItem('rx-store-installed', JSON.stringify(updated));
      return updated;
    });
  };

  const uninstallApp = (appId: string) => {
    setInstalledApps((prev) => {
      const updated = prev.filter((id) => id !== appId);
      localStorage.setItem('rx-store-installed', JSON.stringify(updated));
      return updated;
    });
  };

  return (
    <AppContext.Provider
      value={{
        apps,
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
