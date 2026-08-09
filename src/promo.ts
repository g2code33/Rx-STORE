import { API_URL, isApiConfigured } from './services/api';
import { trackAd } from './components/home/introAds';

/**
 * Promo notifications — PWA alerts tied to sponsored creatives.
 *
 * The admin composes a promo from any ad (Builder → Ads → Broadcast promo) and
 * it is published to the `intro.promo` content key. Every visitor's browser
 * checks that key on load and every 30 minutes while open; when a fresh promo
 * appears AND the user opted in, a rich notification is shown through the
 * service worker (works from the home-screen PWA too). Each device alerts a
 * given promo at most once, and promos older than 14 days never burst on a
 * fresh device.
 *
 * Note: this is client-triggered — the notification fires while the app is
 * open or next time it launches. True always-on server push (VAPID + a
 * subscriptions table + send fan-out in the worker) needs the web-push
 * crypto stack; the sw.js `push` listener is already stubbed for it.
 */

export interface Promo {
  id: string;
  title: string;
  body?: string;
  iconUrl?: string;
  url?: string;
  adId?: string;
  publishedAt: string;
}

const SEEN_KEY = 'rx-promo-seen';
const FRESH_MS = 14 * 24 * 60 * 60 * 1000;
let started = false;

export function notificationsUsable(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator;
}

/** True while a promo is recent enough to alert about (14-day burst window). */
export function promoIsFresh(p: Pick<Promo, 'publishedAt'> | null | undefined, now = Date.now()): boolean {
  if (!p?.publishedAt) return false;
  const t = new Date(p.publishedAt).getTime();
  return Number.isFinite(t) && now - t <= FRESH_MS && now >= t - 5 * 60 * 1000;
}

/** Compose+persist a promo (admin). Returns true when published. */
export async function broadcastPromo(p: Omit<Promo, 'publishedAt'> & Partial<Pick<Promo, 'publishedAt'>>): Promise<boolean> {
  if (!isApiConfigured()) return false;
  const promo: Promo = { ...p, publishedAt: p.publishedAt || new Date().toISOString() };
  try {
    const token = localStorage.getItem('rx-store-token') || '';
    const res = await fetch(`${API_URL}/admin/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ key: 'intro.promo', value: promo }),
    });
    if (!res.ok) return false;
    // Any opted-in browser with the site open (including the admin's) gets
    // the alert almost immediately — no 30-minute wait for the next poll.
    setTimeout(() => { void checkPromoNow(); }, 1200);
    return true;
  } catch { return false; }
}

/** Run one delivery pass right now (opt-in/refresh/broadcast all funnel here). */
export async function checkPromoNow(): Promise<void> {
  try { await check(); } catch { /* never break the UI over a promo */ }
}

/** Start the client watcher — idempotent; never notifies without opt-in. */
export function startPromoWatcher() {
  if (started || !notificationsUsable() || !isApiConfigured()) return;
  started = true;
  void checkPromoNow();
  setInterval(() => void checkPromoNow(), 30 * 60 * 1000);
}

function parsePromo(raw: unknown): Promo | null {
  try {
    let v: any = raw;
    if (typeof v === 'string') v = JSON.parse(v);
    if (!v || typeof v !== 'object') return null;
    if (!v.id || !v.title || !v.publishedAt) return null;
    return v as Promo;
  } catch { return null; }
}

async function check() {
  let promo: Promo | null = null;
  try {
    const res = await fetch(`${API_URL}/content`);
    const j = await res.json();
    promo = parsePromo(j?.data?.['intro.promo']);
  } catch { return; }
  if (!promo) return;
  try {
    if (localStorage.getItem(SEEN_KEY) === promo.id) return;
  } catch { /* private mode: allow repeat, harmless */ }
  // Not opted in? LEAVE IT UNSEEN — the moment the user enables deal alerts
  // (PromoOptIn → checkPromoNow) the pending promo lands right away. Marking
  // it seen here is what used to silently swallow every broadcast.
  if (Notification.permission !== 'granted') return;
  if (!promoIsFresh(promo)) return;
  await show(promo);
  // One device, one alert — marked only once it was actually delivered.
  try { localStorage.setItem(SEEN_KEY, promo.id); } catch { /* ok */ }
}

async function show(p: Promo) {
  const opts: NotificationOptions = {
    body: p.body || '',
    icon: p.iconUrl || '/icon-192.png',
    badge: '/icon-192.png',
    tag: p.id,
    data: { url: p.url || '/', adId: p.adId || '' },
  };
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(p.title, opts);
  } catch {
    try { new Notification(p.title, opts); } catch { /* blocked — skip silently */ }
  }
  // Server-side counter keyed separately so intro views stay clean (`promo:<adId>`)
  if (p.adId) trackAd(`promo:${p.adId}`, 'views');
}
