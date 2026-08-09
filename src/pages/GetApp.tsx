import { useMemo, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Download, MonitorSmartphone, Share, PlusSquare, Smartphone, CheckCircle2, Globe, ArrowRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { detectDevice, downloadsFor, deviceLabel, DOWNLOAD_OPTIONS, type DownloadOption } from '../platform/downloads';
import { capturePwaInstallPrompt, subscribePwaInstall, pwaInstallAvailable, promptPwaInstall } from '../platform/pwaInstall';
import { useContent } from '../context/ContentContext';
import Editable from '../components/edit/Editable';

function useDevice() {
  return useMemo(
    () => detectDevice(typeof navigator !== 'undefined' ? navigator.userAgent : '', { maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0 }),
    []
  );
}

function DownloadBtn({ opt, big = false }: { opt: DownloadOption; big?: boolean }) {
  return (
    <a
      href={opt.url}
      className={`btn-primary flex items-center justify-center gap-2 ${big ? 'text-base px-8 py-3.5' : 'text-sm !px-5 !py-2.5'}`}
    >
      <Download className={big ? 'w-5 h-5' : 'w-4 h-4'} /> {opt.platform} {opt.ext} · {opt.size}
    </a>
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
          <span className="text-white/90">Open <span className="text-rx-yellow font-semibold">rx-store-web.pages.dev</span> in <span className="font-semibold">Safari</span> (must be Safari, not Chrome).</span>
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

  const installPwa = async () => {
    capturePwaInstallPrompt();
    const ok = await promptPwaInstall();
    toast[ok ? 'success' : 'error'](ok ? 'Installed ✓ — find RX Store in your apps' : 'Install was cancelled');
  };

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
      </div>

      {/* Recommended for YOUR device */}
      <div className="card p-6 sm:p-8 mb-10 border-rx-yellow/30 relative overflow-hidden">
        <div className="absolute -top-10 -right-10 w-48 h-48 bg-rx-yellow/10 rounded-full blur-3xl" />
        <div className="relative flex flex-col sm:flex-row items-center gap-6">
          <div className="w-16 h-16 rounded-2xl bg-rx-dark-tertiary flex items-center justify-center text-4xl flex-shrink-0">
            {device === 'ios' ? '🍎' : device === 'android' ? '🤖' : device === 'windows' ? '🪟' : device === 'linux' ? '🐧' : device === 'mac' ? '💻' : <MonitorSmartphone className="w-8 h-8 text-rx-yellow" />}
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
            {primary.map((opt) => <DownloadBtn key={opt.id} opt={opt} big />)}
            {device === 'mac' && pwaAvailable && (
              <button onClick={installPwa} className="btn-primary text-base px-8 py-3.5 flex items-center gap-2 justify-center">
                <Download className="w-5 h-5" /> Install web app
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Every platform */}
      <h2 className="text-2xl font-bold text-white mb-6">All platforms</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-10">
        {(['windows', 'deb', 'android'] as const).map((id) => {
          const opt = DOWNLOAD_OPTIONS[id];
          const isPrimary = primary.some((p) => p.id === id);
          return (
            <div key={id} className={`card p-6 ${isPrimary ? 'border-rx-yellow/40' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-3xl">{opt.icon}</span>
                  <div>
                    <h3 className="font-bold text-white">{opt.platform}</h3>
                    <p className="text-xs text-rx-gray-medium">{opt.file} · {opt.size}</p>
                  </div>
                </div>
                {isPrimary && <span className="text-[10px] font-bold uppercase tracking-wider bg-rx-yellow/15 text-rx-yellow px-2 py-1 rounded-full flex-shrink-0">Your device</span>}
              </div>
              <p className="text-xs text-rx-gray-medium mt-3 leading-relaxed">{opt.note}</p>
              <div className="mt-4">
                <DownloadBtn opt={opt} />
              </div>
              {id === 'deb' && (
                <a href={DOWNLOAD_OPTIONS.appimage.url} className="mt-2 inline-flex items-center gap-1.5 text-xs text-rx-yellow hover:underline">
                  {DOWNLOAD_OPTIONS.appimage.icon} Prefer no installer? Get the AppImage instead <ArrowRight className="w-3 h-3" />
                </a>
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
        All downloads come from the official{' '}
        <a href="https://github.com/g2code33/Rx-STORE/releases/latest" target="_blank" rel="noreferrer" className="text-rx-yellow hover:underline">GitHub Releases</a>
        {' '}page · v1.0.0 · every build auto-updates itself. <Link to="/browse" className="text-rx-yellow hover:underline">Back to browsing</Link>
      </p>
    </div>
  );
}
