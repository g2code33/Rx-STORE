import { useState, useSyncExternalStore } from 'react';
import { Download, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { pwaInstallAvailable, promptPwaInstall, subscribePwaInstall } from '../../platform/pwaInstall';
import { isPWADisplayStandalone } from '../../hooks/useDeviceDetect';

/** Visible user-gesture surface for the deferred beforeinstallprompt event. */
export default function PwaInstallBanner() {
  const available = useSyncExternalStore(subscribePwaInstall, pwaInstallAvailable, () => false);
  const [dismissed, setDismissed] = useState(false);
  if (!available || dismissed || isPWADisplayStandalone() || (window as any).rxDesktop?.isDesktop) return null;

  const install = async () => {
    const ok = await promptPwaInstall();
    if (ok) toast.success('RX Store installed — find it on your Home Screen or in your apps');
    else toast('Installation was not completed.', { icon: 'ℹ️' });
  };

  return (
    <div className="fixed left-3 right-3 bottom-20 sm:left-auto sm:right-5 sm:bottom-5 z-[90] sm:w-96 rounded-2xl bg-rx-dark-secondary border border-rx-yellow/30 shadow-2xl p-4 animate-slide-up">
      <div className="flex items-center gap-3">
        <img src="/icon-192.png" alt="" className="w-12 h-12 rounded-xl" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-white">Install RX Store</p>
          <p className="text-xs text-rx-gray-medium">Open faster from your Home Screen, with an app-like experience.</p>
        </div>
        <button onClick={()=>setDismissed(true)} aria-label="Dismiss install offer" className="p-1 text-rx-gray-medium hover:text-white"><X className="w-4 h-4"/></button>
      </div>
      <button onClick={install} className="mt-3 w-full btn-primary !py-2.5 text-sm flex items-center justify-center gap-2">
        <Download className="w-4 h-4"/> Install now
      </button>
    </div>
  );
}
