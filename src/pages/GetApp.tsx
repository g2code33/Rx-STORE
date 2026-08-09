import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Download, MonitorSmartphone, Share, PlusSquare, Smartphone, CheckCircle2, Globe, ArrowRight, Store, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { detectDevice, downloadsFor, deviceLabel, DOWNLOAD_OPTIONS, SELF_APP_SLUG, type DownloadOption } from '../platform/downloads';
import { capturePwaInstallPrompt, subscribePwaInstall, pwaInstallAvailable, promptPwaInstall } from '../platform/pwaInstall';
import { startStoreDownload, fetchSelfListing, type SelfListing } from '../platform/storeDownload';
import { useContent } from '../context/ContentContext';
import Editable from '../components/edit/Editable';
import PlatformIcon from '../icons/PlatformIcon';
import type { DeviceKind, StorePlatform } from '../platform/downloads';

const DEVICE_ICON: Record<DeviceKind, string> = { windows: 'windows', linux: 'linux', android: 'android', ios: 'ios', mac: 'macos', unknown: '' };
const OPTION_ICON: Record<StorePlatform, string> = { windows: 'windows', linux_deb: 'linux', linux_appimage: 'linux', android: 'android' };

function useDevice() {
  return useMemo(
    () => detectDevice(typeof navigator !== 'undefined' ? navigator.userAgent : '', { maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0 }),
    []
  );
}

function DownloadBtn({ opt, big = false, busy, onGo }: { opt: DownloadOption; big?: boolean; busy: boolean; onGo: (opt: DownloadOption) => void }) {
  return (
    <button
      onClick={() => onGo(opt)}
      disabled={busy}
      className={`btn-primary flex items-center justify-center gap-2 disabled:opacity-60 ${big ? 'text-base px-8 py-3.5 w-full sm:w-auto' : 'text-sm !px-5 !py-2.5'}`}
    >
      {busy ? <Loader2 className={`${big ? 'w-5 h-5' : 'w-4 h-4'} animate-spin`} /> : <Download className={big ? 'w-5 h-5' : 'w-4 h-4'} />}
      {opt.platform} {opt.ext} · {opt.size}
    </button>
  );
}

/** iPhone/iPad — Add to Home Screen step-by-step */
function IosPwaGuide() {
  return (
    <div className="card p-6 border-rx-yellow/25">
      <h3 className="font-bold text-white flex items-center gap-2 text-lg">
        <span className="text-2xl">🍎</span> iPhone / iPad — install as an app (PWA)
      </h3>
      <p className="text-sm text-rx-gray-medium mt-2">
        Apple doesn't allow direct app installs from websites, so RX Store installs itself — 30 seconds:
      </p>
      <ol className="mt-4 space-y-3 text-sm">
        <li className="flex items-start gap-3">
          <span className="w-6 h-6 rounded-full bg-rx-yellow text-rx-dark font-bold flex items-center justify-center flex-shrink-0 text-xs">1</span>
          <span className="text-white/90">Open this site in <span className="font-semibold">Safari</span> (must be Safari, not Chrome).</span>
        </li>
        <li className="flex items-start gap-3">
          <span className="w-6 h-6 rounded-full bg-rx-yellow text-rx-dark font-bold flex items-center justify-center flex-shrink-0 text-xs">2</span>
          <span className="text-white/90 flex items-center gap-1.5 flex-wrap">Tap the <Share className="w-4 h-4 text-rx-yellow inline" /> <span className="font-semibold">Share</span> button (bottom bar).</span>
        </li>
        <li className="flex items-start gap-3">
          <span className="w-6 h-6 rounded-full bg-rx-yellow text-rx-dark font-bold flex items-center justify-center flex-shrink-0 text-xs">3</span>
          <span className="text-white/90 flex items-center gap-1.5 flex-wrap">Scroll and tap <PlusSquare className="w-4 h-4 text-rx-yellow inline" /> <span className="font-semibold">"Add to Home Screen"</span>, then <span className="font-semibold">Add</span>.</span>
        </li>
        <li className="flex items-start gap-3">
          <CheckCircle2 className="w-6 h-6 text-green-400 flex-shrink-0" />
          <span className="text-white/90">The yellow RX Store icon lands on your Home Screen — launches full-screen with offline support.</span>
        </li>
      </ol>
    </div>
  );
}

export default function GetApp() {
  const device = useDevice();
  const primary = downloadsFor(device);
  const { get } = useContent();
  const pwaAvailable = useSyncExternalStore(subscribePwaInstall, pwaInstallAvailable);
  const [busyId, setBusyId] = useState<string>('');
  const [listing, setListing] = useState<SelfListing | null>(null);

  useEffect(() => {
    let stop = false;
    fetchSelfListing().then((l) => { if (!stop) setListing(l); });
    return () => { stop = true; };
  }, []);

  const go = async (opt: DownloadOption) => {
    if (busyId) return;
    setBusyId(opt.id);
    await startStoreDownload(opt);
    setBusyId('');
  };

  const installPwa = async () => {
    capturePwaInstallPrompt();
    const ok = await promptPwaInstall();
    toast[ok ? 'success' : 'error'](ok ? 'Installed ✓ — find RX Store in your apps' : 'Install was cancelled');
  };

  const platformCards: DownloadOption[] = [DOWNLOAD_OPTIONS.windows, DOWNLOAD_OPTIONS.linux_deb, DOWNLOAD_OPTIONS.android];

  return (
    <div className="section-container py-10 lg:py-16">
      {/* Hero + detected device */}
      <div className="text-center max-w-2xl mx-auto mb-12">
        <img src="/v1.png" alt="RX Store" className="w-20 h-20 rounded-2xl object-cover mx-auto mb-5 shadow-glow" />
        <h1 className="text-3xl sm:text-4xl font-black text-white">
          <Editable id="getapp.title" label="Get-App heading">{get('getapp.title', 'Get the RX Store app')}</Editable>
        </h1>
        <p className="text-rx-gray-medium mt-3">
          <Editable id="getapp.sub" type="textarea" label="Get-App subtitle">{get('getapp.sub', 'The fastest way to browse, install and manage your applications — native on every platform, with auto-updates.')}</Editable>
        </p>
        <p className="mt-3 inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-rx-gray-medium">
          <Store className="w-3.5 h-3.5 text-rx-yellow" />
          Served by the RX Store itself — same pipeline as every app here
          {listing && <span className="text-green-400 font-semibold">· v{listing.version} live ✓</span>}
        </p>
      </div>

      {/* Recommended for YOUR device */}
      <div className="card p-6 sm:p-8 mb-10 border-rx-yellow/30 relative overflow-hidden">
        <div className="absolute -top-10 -right-10 w-48 h-48 bg-rx-yellow/10 rounded-full blur-3xl" />
        <div className="relative flex flex-col sm:flex-row items-center gap-6">
          <div className="w-16 h-16 rounded-2xl bg-rx-dark-tertiary flex items-center justify-center text-4xl flex-shrink-0">
            {DEVICE_ICON[device]
              ? <PlatformIcon id={DEVICE_ICON[device]} className="text-4xl leading-none" imgClassName="w-11 h-11" />
              : <MonitorSmartphone className="w-8 h-8 text-rx-yellow" />}
          </div>
          <div className="flex-1 text-center sm:text-left">
            <p className="text-xs font-bold uppercase tracking-widest text-rx-yellow">Recommended for you</p>
            <h2 className="text-xl font-bold text-white mt-1">
              We detected {deviceLabel(device)}
            </h2>
            {primary.length > 0 ? (
              <p className="text-sm text-rx-gray-medium mt-1">{primary[0].note}</p>
            ) : (
              <p className="text-sm text-rx-gray-medium mt-1">
                {device === 'ios' ? 'Install it straight from Safari — guide below.' : 'Install the web app — same experience, zero download.'}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2 w-full sm:w-auto">
            {primary.map((opt) => <DownloadBtn key={opt.id} opt={opt} big busy={busyId === opt.id} onGo={go} />)}
            {device === 'mac' && pwaAvailable && (
              <button onClick={installPwa} className="btn-primary text-base px-8 py-3.5 flex items-center gap-2 justify-center">
                <Download className="w-5 h-5" /> Install web app
              </button>
            )}
            {primary.length > 0 && (
              <Link to={`/app/${SELF_APP_SLUG}`} className="text-xs text-center text-rx-gray-medium hover:text-rx-yellow transition-colors underline-offset-2 hover:underline">
                Open the store listing instead
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* Every platform */}
      <h2 className="text-2xl font-bold text-white mb-6">All platforms</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-10">
        {platformCards.map((opt) => {
          const isPrimary = primary.some((p) => p.id === opt.id);
          return (
            <div key={opt.id} className={`card p-6 ${isPrimary ? 'border-rx-yellow/40' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <PlatformIcon id={OPTION_ICON[opt.platformId]} className="text-3xl leading-none" imgClassName="w-8 h-8" />
                  <div>
                    <h3 className="font-bold text-white">{opt.platform}</h3>
                    <p className="text-xs text-rx-gray-medium">{opt.ext} · {opt.size}{listing ? ` · v${listing.version}` : ''}</p>
                  </div>
                </div>
                {isPrimary && <span className="text-[10px] font-bold uppercase tracking-wider bg-rx-yellow/15 text-rx-yellow px-2 py-1 rounded-full flex-shrink-0">Your device</span>}
              </div>
              <p className="text-xs text-rx-gray-medium mt-3 leading-relaxed">{opt.note}</p>
              <div className="mt-4">
                <DownloadBtn opt={opt} busy={busyId === opt.id} onGo={go} />
              </div>
              {opt.id === 'linux_deb' && (
                <button
                  onClick={() => go(DOWNLOAD_OPTIONS.linux_appimage)}
                  disabled={busyId === DOWNLOAD_OPTIONS.linux_appimage.id}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs text-rx-yellow hover:underline disabled:opacity-60"
                >
                  <PlatformIcon id="linux" className="text-xs leading-none" imgClassName="w-3.5 h-3.5 inline-block" /> Prefer no installer? Get the AppImage instead <ArrowRight className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}

        {/* Web / PWA card */}
        <div className="card p-6">
          <div className="flex items-center gap-3">
            <Globe className="w-8 h-8 text-rx-yellow" />
            <div>
              <h3 className="font-bold text-white">Web app (PWA)</h3>
              <p className="text-xs text-rx-gray-medium">Any browser · installs in one tap</p>
            </div>
          </div>
          <p className="text-xs text-rx-gray-medium mt-3 leading-relaxed">
            Zero download. Works offline, gets deal alerts, sits in your app list / dock like a native app.
          </p>
          <div className="mt-4">
            {pwaAvailable ? (
              <button onClick={installPwa} className="btn-primary text-sm !px-5 !py-2.5 flex items-center gap-2">
                <Download className="w-4 h-4" /> Install web app
              </button>
            ) : (
              <p className="text-xs text-rx-gray-medium leading-relaxed">
                In Chrome/Edge: open the <span className="text-white font-medium">⋮</span> menu → <span className="text-white font-medium">"Install app"</span> (or the install icon in the address bar).
              </p>
            )}
          </div>
        </div>
      </div>

      {/* iOS guide — own section so it can be linked directly */}
      <div id="ios" className="scroll-mt-24 max-w-2xl">
        <IosPwaGuide />
      </div>

      {/* macOS note */}
      {device === 'mac' && (
        <div className="mt-6 max-w-2xl">
          <div className="card p-6">
            <h3 className="font-bold text-white flex items-center gap-2"><Smartphone className="w-5 h-5 text-rx-yellow" /> macOS</h3>
            <p className="text-sm text-rx-gray-medium mt-2">A signed Mac build is on the roadmap — until then the web app (above) gives you the same store in your Dock.</p>
          </div>
        </div>
      )}

      <p className="text-center text-xs text-rx-gray-medium mt-12">
        Every installer is hosted on the RX Store's own storage and served through{' '}
        <Link to={`/app/${SELF_APP_SLUG}`} className="text-rx-yellow hover:underline">the RX Store listing</Link>
        {' '}— exactly like any app you'd download here. Each build auto-updates itself after install.{' '}
        <Link to="/browse" className="text-rx-yellow hover:underline">Back to browsing</Link>
      </p>
    </div>
  );
}
