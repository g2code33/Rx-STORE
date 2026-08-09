import { useState } from 'react';
import toast from 'react-hot-toast';
import { Bell, X } from 'lucide-react';
import { useContent } from '../../context/ContentContext';
import { IntroAd, isAdLive } from '../home/introAds';
import { notificationsUsable } from '../../promo';

const DISMISSED_KEY = 'rx-promo-dismissed';

/**
 * One-time "deal alerts" opt-in card — appears once when there's at least one
 * live sponsored creative, the browser supports notifications, and the user
 * hasn't decided yet. Dismissal and opt-in are both remembered forever.
 */
export default function PromoOptIn() {
  const { getJSON, ready } = useContent();
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);

  if (gone || !ready || !notificationsUsable()) return null;
  if (Notification.permission !== 'default') return null;
  try {
    if (localStorage.getItem(DISMISSED_KEY) === '1') return null;
  } catch { /* private mode */ }

  const ads = getJSON<IntroAd[]>('intro.ads', []);
  if (!(Array.isArray(ads) && ads.some((a) => a?.enabled && a.title?.trim() && isAdLive(a)))) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* ok */ }
    setGone(true);
  };

  const enable = async () => {
    setBusy(true);
    try {
      const p = await Notification.requestPermission();
      if (p === 'granted') toast.success('Deal alerts on — you\'ll hear about featured offers first.');
      dismiss();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed bottom-20 left-3 sm:bottom-6 sm:left-6 z-[60] w-[calc(100%-1.5rem)] max-w-xs animate-fade-in">
      <div className="card p-4 shadow-2xl shadow-black/60 border-rx-yellow/25">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-rx-yellow/15 flex items-center justify-center flex-shrink-0">
            <Bell className="w-4 h-4 text-rx-yellow" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">Deal alerts</p>
            <p className="text-xs text-rx-gray-medium mt-0.5">Get a heads-up when a featured offer drops — sponsored picks only, never spam.</p>
          </div>
          <button onClick={dismiss} className="text-rx-gray-medium hover:text-white transition-colors p-1 -m-1" aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={enable} disabled={busy} className="btn-primary !py-2 !px-4 text-xs font-semibold disabled:opacity-50">
            {busy ? 'Asking…' : 'Enable alerts'}
          </button>
          <button onClick={dismiss} className="px-3 py-2 text-xs font-medium text-rx-gray-medium hover:text-white rounded-xl hover:bg-white/5 transition-all">
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
