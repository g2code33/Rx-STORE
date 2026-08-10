import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { AppProvider } from './context/AppContext';
import { ContentProvider } from './context/ContentContext';
import { capturePwaInstallPrompt } from './platform/pwaInstall';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ContentProvider>
          <AppProvider>
            <App />
          </AppProvider>
        </ContentProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);

// PWA: offline shell + installable ("Add to Home Screen" with the RX Store logo).
// Native shells already bundle every asset. Registering the website service
// worker there can retain an old index/chunk map across upgrades and leave a
// packaged app blank. Remove legacy registrations/caches in native shells;
// keep offline caching only on the actual website/PWA.
const isNativeShell =
  window.location.protocol === 'app:' ||
  window.location.protocol === 'capacitor:' ||
  !!window.rxDesktop?.isDesktop ||
  !!(window as any).Capacitor?.isNativePlatform?.();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    if (isNativeShell) {
      navigator.serviceWorker.getRegistrations().then((registrations) =>
        Promise.all(registrations.map((registration) => registration.unregister()))
      ).catch(() => {});
      if ('caches' in window) {
        caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).catch(() => {});
      }
      return;
    }
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Capture the browser's install prompt early so /get-app can offer 1-tap install
capturePwaInstallPrompt();
