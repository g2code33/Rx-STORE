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

// PWA: offline shell + installable ("Add to Home Screen" with the RX Store logo)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Capture the browser's install prompt early so /get-app can offer 1-tap install
capturePwaInstallPrompt();
