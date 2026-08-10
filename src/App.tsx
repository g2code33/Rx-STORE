import React, { Suspense, lazy, useSyncExternalStore } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Header from './components/layout/Header';
import Footer from './components/layout/Footer';
import MobileTabBar from './components/layout/MobileTabBar';
import { AIFloatingButton } from './components/ai/AIChat';
import UpdateBanner from './components/desktop/UpdateBanner';
import PromoOptIn from './components/promo/PromoOptIn';
import GetAppBanner from './components/platform/GetAppBanner';
import PwaInstallBanner from './components/platform/PwaInstallBanner';
import { FaviconSync } from './icons/PlatformIcon';
import { startPromoWatcher } from './promo';
import { API_URL, getPublicSettings } from './services/api';
import { useAuth } from './context/AuthContext';
import { applyUpdatePolicy } from './desktop/updater';
import { androidDownloadAndInstall, androidHostVersion, androidNetworkStatus, isAndroidShell } from './platform/nativeInstaller';
import { EditModeContext, getBuilderCtx, subscribeBuilder } from './components/edit/EditMode';

/**
 * Provides the Live Website Builder ctx to the whole app. Null for everyone
 * except an admin actively inside the builder — visitors never see edit chrome.
 */
function BuilderScope({ children }: { children: React.ReactNode }) {
  const ctx = useSyncExternalStore(subscribeBuilder, getBuilderCtx);
  return <EditModeContext.Provider value={ctx}>{children}</EditModeContext.Provider>;
}

/** Full-screen block for visitors while Admin → Settings → Maintenance mode is on. */
function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [maint, setMaint] = React.useState<string | null>(null);
  React.useEffect(() => {
    let stop = false;
    const load = () => getPublicSettings(true).then((s) => {
      if (!stop) setMaint(s.maintenance_mode === '1' ? (s.announcement || '') : null);
    });
    load();
    const t = setInterval(load, 60_000); // auto-recover when admin turns it off
    return () => { stop = true; clearInterval(t); };
  }, []);
  const isAdminRoute = window.location.pathname.startsWith('/admin');
  if (maint !== null && user?.role !== 'admin' && !isAdminRoute) {
    return (
      <div className="min-h-screen bg-rx-dark flex items-center justify-center text-center px-6">
        <div>
          <img src="/v1.png" alt="RX Store" className="w-20 h-20 rounded-2xl object-cover mx-auto mb-6" />
          <h1 className="text-2xl font-bold text-white">We'll be right back</h1>
          <p className="text-rx-gray-medium mt-2 max-w-sm mx-auto">
            {maint || 'RX Store is undergoing scheduled maintenance. Everything returns shortly.'}
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

const Home = lazy(() => import('./pages/Home'));
const Browse = lazy(() => import('./pages/Browse'));
const AppDetail = lazy(() => import('./pages/AppDetail'));
const Categories = lazy(() => import('./pages/Categories'));
const CategoryPage = lazy(() => import('./pages/CategoryPage'));
const Login = lazy(() => import('./pages/Login'));
const Profile = lazy(() => import('./pages/Profile'));
const About = lazy(() => import('./pages/About'));
const Admin = lazy(() => import('./pages/Admin'));
const Privacy = lazy(() => import('./pages/Privacy'));
const Terms = lazy(() => import('./pages/Terms'));
const Advertise = lazy(() => import('./pages/Advertise'));
const Sponsor = lazy(() => import('./pages/Sponsor'));
const GetApp = lazy(() => import('./pages/GetApp'));

function LoadingFallback() {
  return (
    <div className="min-h-screen bg-rx-dark flex items-center justify-center">
      <div className="text-center">
        <img src="/v1.png" alt="RX Store" className="w-20 h-20 rounded-2xl object-cover mx-auto mb-4 animate-pulse" />
        <p className="text-rx-gray-medium text-sm">Loading RX Store...</p>
      </div>
    </div>
  );
}

function ScrollToTop() {
  const { pathname, hash } = useLocation();
  React.useEffect(() => {
    if (!hash) {
      window.scrollTo(0, 0);
      return;
    }
    // Hash link (e.g. /#apps-section from an editable button): smooth-scroll to
    // the target. The page chunk may still be lazy-loading, so retry briefly.
    const id = hash.slice(1);
    let tries = 0;
    const timer = setInterval(() => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        clearInterval(timer);
      } else if (++tries >= 25) {
        clearInterval(timer);
      }
    }, 120);
    return () => clearInterval(timer);
  }, [pathname, hash]);
  return null;
}

function UpdatePolicySync() {
  const { user } = useAuth();
  React.useEffect(() => {
    const p = user?.preferences;
    void applyUpdatePolicy(p?.autoUpdate !== false, p?.mobileDataUpdates !== false && !p?.wifiOnly);
  }, [user?.id, user?.preferences?.autoUpdate, user?.preferences?.wifiOnly, user?.preferences?.mobileDataUpdates]);
  return null;
}

function AndroidAutoUpdateSync() {
  const { user } = useAuth();
  React.useEffect(() => {
    if (!isAndroidShell() || !API_URL || user?.preferences?.autoUpdate === false) return;
    const allowMobile = user?.preferences?.mobileDataUpdates !== false && !user?.preferences?.wifiOnly;
    (async () => {
      try {
        const network = await androidNetworkStatus();
        if (!network.connected || (network.metered && !allowMobile)) return;
        const { version } = await androidHostVersion();
        if (!version) return;
        const r = await fetch(`${API_URL}/updates/check?app=rx-store&currentVersion=${encodeURIComponent(version)}&platform=android`);
        const j = await r.json(); const d = j?.data;
        if (!r.ok || !d?.updateAvailable || !d?.downloadURL) return;
        const seenKey = `rx-android-update-started-${d.latestVersion}`;
        if (sessionStorage.getItem(seenKey)) return;
        sessionStorage.setItem(seenKey, '1');
        await androidDownloadAndInstall(d.downloadURL, `rx-store-${d.latestVersion}.apk`);
      } catch { /* update checks never block app startup */ }
    })();
  }, [user?.id, user?.preferences?.autoUpdate, user?.preferences?.wifiOnly, user?.preferences?.mobileDataUpdates]);
  return null;
}

export default function App() {
  React.useEffect(() => startPromoWatcher(), []); // promo alerts (opt-in only)
  return (
    <div className="min-h-screen bg-rx-dark text-white flex flex-col">
      <ScrollToTop />
      <UpdatePolicySync />
      <AndroidAutoUpdateSync />
      <MaintenanceGate>
      <BuilderScope>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: '#1A2332',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '12px',
          },
        }}
      />
      <Header />
      <FaviconSync />
      {/* paddingTop tracks the REAL header height (announcement bar included) */}
      <main className="flex-1 pb-16 lg:pb-0" style={{ paddingTop: 'var(--rx-header-h, 4rem)' }}>
        <GetAppBanner />
        <Suspense fallback={<LoadingFallback />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/browse" element={<Browse />} />
            <Route path="/app/:slug" element={<AppDetail />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/categories/:category" element={<CategoryPage />} />
            <Route path="/login" element={<Login />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/about" element={<About />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/advertise" element={<Advertise />} />
            <Route path="/get-app" element={<GetApp />} />
            <Route path="/sponsor/:token" element={<Sponsor />} />
            <Route path="/admin" element={<Admin />} />
          </Routes>
        </Suspense>
      </main>
      <Footer />
      <AIFloatingButton />
      <UpdateBanner />
      <PromoOptIn />
      <PwaInstallBanner />
      <MobileTabBar />
      </BuilderScope>
      </MaintenanceGate>
    </div>
  );
}
