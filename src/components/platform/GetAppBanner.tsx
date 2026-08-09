import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Download, X, Loader2 } from 'lucide-react';
import { detectDevice, downloadsFor, bannerPitch, type DeviceKind } from '../../platform/downloads';
import { startStoreDownload } from '../../platform/storeDownload';
import PlatformIcon from '../../icons/PlatformIcon';

const DEVICE_ICON: Record<DeviceKind, string> = { windows: 'windows', linux: 'linux', android: 'android', ios: 'ios', mac: 'macos', unknown: '' };

const DISMISSED_KEY = 'rx-getapp-banner-dismissed';

/**
 * "Get the app" recommendation bar — sits right under the header on every
 * page. Detects the visitor's device and offers THE right download
 * (Windows .exe, Ubuntu .deb, Android .apk); iOS and macOS point at the PWA
 * guide instead. Dismissal is remembered forever.
 */
export default function GetAppBanner() {
  const location = useLocation();
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISSED_KEY) === '1'; } catch { return false; }
  });
  const device = useMemo(
    () => detectDevice(typeof navigator !== 'undefined' ? navigator.userAgent : '', { maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0 }),
    []
  );
  const primary = downloadsFor(device);
  const [downloading, setDownloading] = useState(false);

  const startPrimary = async () => {
    if (downloading || primary.length === 0) return;
    setDownloading(true);
    await startStoreDownload(primary[0]);
    setDownloading(false);
  };

  if (dismissed) return null;
  if (location.pathname === '/get-app') return null; // already on the download page
  // Don't fight the in-app Android shell or the desktop app for attention
  if (typeof window !== 'undefined' && (window as any).rxDesktop?.isDesktop) return null;

  const close = () => {
    try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* ok */ }
    setDismissed(true);
  };

  return (
    <div className="bg-gradient-to-r from-rx-yellow/15 via-rx-yellow/10 to-rx-yellow/15 border-b border-rx-yellow/20">
      <div className="section-container py-2 flex items-center gap-3">
        <span className="text-lg flex-shrink-0" aria-hidden>
          {DEVICE_ICON[device] ? <PlatformIcon id={DEVICE_ICON[device]} className="text-lg leading-none" imgClassName="w-5 h-5 inline-block" /> : '📲'}
        </span>
        <p className="flex-1 min-w-0 text-xs sm:text-sm text-white/90">
          <span className="font-semibold text-white">Get the RX Store app</span>
          <span className="hidden sm:inline text-rx-gray-medium"> — {bannerPitch(device)}</span>
        </p>

        {primary.length > 0 ? (
          <button
            onClick={startPrimary}
            disabled={downloading}
            className="flex-shrink-0 inline-flex items-center gap-1.5 bg-rx-yellow text-rx-dark text-xs font-bold px-3.5 py-1.5 rounded-lg hover:bg-rx-yellow-light transition-colors disabled:opacity-60"
          >
            {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            <span className="whitespace-nowrap">{primary[0].ext} · {primary[0].size}</span>
          </button>
        ) : (
          <Link
            to={device === 'ios' ? '/get-app#ios' : '/get-app'}
            className="flex-shrink-0 inline-flex items-center gap-1.5 bg-rx-yellow text-rx-dark text-xs font-bold px-3.5 py-1.5 rounded-lg hover:bg-rx-yellow-light transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="whitespace-nowrap">Install free</span>
          </Link>
        )}

        <Link to="/get-app" className="hidden md:inline flex-shrink-0 text-xs text-rx-gray-medium hover:text-white transition-colors whitespace-nowrap underline-offset-2 hover:underline">
          All platforms
        </Link>
        <button onClick={close} className="flex-shrink-0 p-1 rounded text-rx-gray-medium hover:text-white transition-colors" aria-label="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
