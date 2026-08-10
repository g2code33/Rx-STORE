/* RX Store service worker — minimal offline shell.
   Strategy: app shell & static assets = cache-first, API calls = network-only. */
const CACHE = 'rx-store-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/v1.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                 // never touch POST/PUT/etc.
  if (url.origin !== self.location.origin) return;        // API & external = network only

  // Navigations are network-first so an installed PWA receives a newly
  // deployed index/chunk map immediately instead of rendering an old shell.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put('/', res.clone()));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((hit) => {
      const live = fetch(e.request).then((res) => {
        // Keep built assets (immutable hashed files) fresh in cache
        if (res.ok && (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname))) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => hit || caches.match('/'));
      return hit || live;
    })
  );
});

/* Promo notifications — tapping one focuses the app (or opens the offer). */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cls) => {
      const own = /^https?:/.test(target) ? null : cls.find((c) => 'focus' in c);
      if (own) { own.navigate(target); return own.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

/* Server push (VAPID fan-out) — stub ready: when the worker gains a send
   route + subscription table, payloads land here. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_e) { d = { title: 'RX Store', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'RX Store', {
    body: d.body || '',
    icon: d.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || d.id || 'rx-push',
    data: d.data || (d.url ? { url: d.url } : {}),
  }));
});
