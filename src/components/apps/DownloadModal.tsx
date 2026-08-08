import { X, Download, Monitor, Smartphone, Laptop, Globe, ExternalLink } from 'lucide-react';
import { detectDevice, isPWADisplayStandalone } from '../../hooks/useDeviceDetect';

type Props = {
  app: any;
  onClose: () => void;
  onDownload: (platform: string, pkg?: any) => void;
};

const platforms = [
  { id: 'web', label: 'Web / PWA', ext: 'PWA', icon: Globe, desc: 'Progressive Web App • Add to Home Screen' },
  { id: 'ios', label: 'iOS', ext: 'IPA', icon: Smartphone, desc: 'iOS App Store / TestFlight' },
  { id: 'android', label: 'Android', ext: 'APK', icon: Smartphone, desc: 'Android 8+ • APK' },
  { id: 'windows', label: 'Windows', ext: 'EXE', icon: Monitor, desc: 'Windows 10/11 • Installer (.exe / MSI)' },
  { id: 'macos', label: 'macOS', ext: 'DMG', icon: Laptop, desc: 'macOS • DMG / PKG' },
  { id: 'linux_deb', label: 'Linux (DEB)', ext: 'DEB', icon: Laptop, desc: 'Ubuntu/Debian (.deb)' },
  { id: 'linux_appimage', label: 'Linux (AppImage)', ext: 'AppImage', icon: Laptop, desc: 'Universal Linux' },
  { id: 'linux', label: 'Linux', ext: 'DEB', icon: Laptop, desc: 'Linux • DEB / AppImage / Flatpak' },
];

export default function DownloadModal({ app, onClose, onDownload }: Props) {
  const detection = detectDevice();
  const isStandalone = isPWADisplayStandalone();
  const available = (app.platforms || ['web']) as string[];
  // Try to get packages with deployment_url for PWA
  const getPkg = (pid: string) => {
    // app.packages or app.files may contain package info
    const pkgs = (app as any).packages || (app as any).files || {};
    if (Array.isArray(pkgs)) return pkgs.find((p:any)=> p.platform===pid || p.id===pid);
    return pkgs[pid];
  };

  // Determine if PWA is available
  const pwaPkg = getPkg('web') || getPkg('pwa') || getPkg('ios');
  const pwaUrl = pwaPkg?.deployment_url || (app as any).pwa_url || (app as any).deployment_url || `https://${app.slug}.rx-store-web.pages.dev`;

  const isIOS = detection.device === 'iphone' || detection.device === 'ipad';
  const showPWAInstructions = isIOS;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} className="bg-rx-dark-secondary border border-white/10 rounded-2xl w-full max-w-lg overflow-hidden max-h-[90vh] overflow-y-auto">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-white">Install {app.name}</h3>
            <p className="text-xs text-rx-gray-medium flex items-center gap-1">
              <span>{detection.emoji} {detection.label}</span>
              <span className="mx-1">•</span>
              <span>Recommended: {detection.recommended}</span>
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 text-rx-gray-medium"><X className="w-5 h-5"/></button>
        </div>

        <div className="p-4">
          <p className="text-xs font-semibold text-white mb-2">Choose Package Type</p>
          <p className="text-[11px] text-rx-gray-medium mb-3">Detected: <b className="text-white">{detection.label}</b> — recommended option is pre-selected, but you can choose any.</p>
          
          <div className="space-y-3">
            {/* Recommended */}
            {(() => {
              const recId = detection.recommended;
              const recP = platforms.find(p=> p.id===recId) || platforms.find(p=> p.id==='web')!;
              const isAvailable = available.includes(recP.id) || available.includes(recP.id.split('_')[0]);
              const isPWA = recP.id === 'web';
              if (isPWA) {
                if (isStandalone) {
                  return (
                    <div className="w-full flex items-center gap-4 p-4 rounded-xl bg-green-500/10 border border-green-500/20">
                      <div className="w-12 h-12 rounded-xl bg-green-500/20 flex items-center justify-center"><Globe className="w-6 h-6 text-green-400"/></div>
                      <div className="flex-1">
                        <p className="font-semibold text-white flex items-center gap-2">Web / PWA <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500 text-white">Installed ✓</span> <span className="text-[10px] px-1.5 py-0.5 rounded bg-rx-yellow text-rx-dark">Recommended</span></p>
                        <p className="text-xs text-rx-gray-medium">Already installed — tap to open</p>
                      </div>
                      <button onClick={()=> window.open(pwaUrl, '_blank')} className="px-4 py-2 rounded-xl bg-green-500 text-white text-sm font-bold flex items-center gap-1"><ExternalLink className="w-4 h-4"/> Open App</button>
                    </div>
                  );
                }
                return (
                  <button onClick={() => window.open(pwaUrl, '_blank')} className="w-full flex items-center gap-4 p-4 rounded-xl border text-left bg-rx-yellow/10 border-rx-yellow/30">
                    <div className="w-12 h-12 rounded-xl bg-rx-yellow/20 flex items-center justify-center"><recP.icon className="w-6 h-6 text-rx-yellow"/></div>
                    <div className="flex-1">
                      <p className="font-semibold text-white flex items-center gap-2">{recP.label} <span className="text-[10px] px-1.5 py-0.5 rounded bg-rx-yellow text-rx-dark">Recommended</span></p>
                      <p className="text-xs text-rx-gray-medium">{isIOS ? 'Add to Home Screen via Safari — 1. Tap Share → 2. Add to Home Screen → 3. Add' : 'Progressive Web App • Tap to open'}</p>
                    </div>
                    <ExternalLink className="w-5 h-5 text-rx-yellow"/>
                  </button>
                );
              }
              return (
                <button onClick={()=> isAvailable && onDownload(recP.id)} disabled={!isAvailable} className={`w-full flex items-center gap-4 p-4 rounded-xl border text-left ${!isAvailable ? 'bg-rx-dark/50 border-white/5 opacity-60' : 'bg-rx-yellow/10 border-rx-yellow/30 hover:bg-rx-yellow/20'}`}>
                  <div className="w-12 h-12 rounded-xl bg-rx-yellow/20 flex items-center justify-center"><recP.icon className="w-6 h-6 text-rx-yellow"/></div>
                  <div className="flex-1">
                    <p className="font-semibold text-white flex items-center gap-2">{recP.label} <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-rx-gray-medium">{recP.ext}</span> <span className="text-[10px] px-1.5 py-0.5 rounded bg-rx-yellow text-rx-dark">Recommended</span></p>
                    <p className="text-xs text-rx-gray-medium">{recP.desc}</p>
                  </div>
                  {isAvailable ? <Download className="w-5 h-5 text-rx-yellow"/> : <span className="text-xs text-amber-300">Unavailable — use Web/PWA</span>}
                </button>
              );
            })()}
            {/* Other packages — collapsible */}
            <details className="group">
              <summary className="list-none flex items-center justify-center gap-2 py-2 text-xs text-rx-gray-medium hover:text-white cursor-pointer">Other packages <span className="px-1.5 py-0.5 rounded bg-white/10 text-[10px]">{platforms.filter(p=> (available.includes(p.id) || available.includes(p.id.split('_')[0])) && p.id !== detection.recommended).length} available</span></summary>
              <div className="space-y-2 mt-2">
                {platforms.filter(p=> p.id !== detection.recommended).map(p => {
                  const isAvailable = available.includes(p.id) || available.includes(p.id.split('_')[0]);
                  const isPWA = p.id === 'web';
                  if (isPWA) {
                    return (
                      <button key={p.id} onClick={() => window.open(pwaUrl, '_blank')} className="w-full flex items-center gap-4 p-3 rounded-xl bg-rx-dark hover:bg-rx-dark-tertiary border border-white/10 text-left">
                        <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center"><p.icon className="w-5 h-5 text-rx-gray-medium"/></div>
                        <div className="flex-1"><p className="text-sm font-medium text-white">{p.label}</p><p className="text-xs text-rx-gray-medium">Web/PWA • Open</p></div>
                        <ExternalLink className="w-4 h-4 text-rx-gray-medium"/>
                      </button>
                    );
                  }
                  return (
                    <button key={p.id} onClick={()=> isAvailable && onDownload(p.id)} disabled={!isAvailable} className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left ${!isAvailable ? 'bg-rx-dark/30 border-white/5 opacity-50' : 'bg-rx-dark hover:bg-rx-dark-tertiary border-white/10'}`}>
                      <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center"><p.icon className="w-5 h-5 text-rx-gray-medium"/></div>
                      <div className="flex-1"><p className="text-sm text-white">{p.label} <span className="text-[10px] px-1 py-0.5 rounded bg-white/10 text-rx-gray-medium">{p.ext}</span></p><p className="text-xs text-rx-gray-medium">{isAvailable ? p.desc : 'Unavailable'}</p></div>
                      {isAvailable ? <Download className="w-4 h-4 text-rx-gray-medium"/> : <span className="text-xs text-amber-300">—</span>}
                    </button>
                  );
                })}
              </div>
            </details>
          </div>
          <p className="text-[11px] text-rx-gray-medium mt-3 text-center">Device detection is a recommendation — package availability is determined by what Admin uploaded. You can always choose Web/PWA as alternative.</p>
        </div>
      </div>
    </div>
  );
}
