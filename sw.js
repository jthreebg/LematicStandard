const CACHE = 'lematic-fs-flat-v70';
const PRECACHE = [
  './',
  './index.html',
  './app.css?v=70',
  './app.js?v=70',
  './templates.js?v=70',
  './qrcode.min.js?v=70',
  './exceljs.min.js',
  './timecard-template.xlsx',
  './Punchlist-Template.xlsx',
  './manifest.webmanifest',
  './apple-touch-icon.png',
  './icon-192.png'
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})).then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname.toLowerCase();
  const isDoc = req.mode === 'navigate' || path.endsWith('.html') || path.endsWith('/');
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req) || await cache.match(url.pathname) || await cache.match('.' + url.pathname.split('/').pop());
    if (!isDoc) {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        if (cached) return cached;
        return new Response('Not available offline', { status: 503, statusText: 'Offline' });
      }
    }
    if (cached) {
      event.waitUntil(
        fetch(req).then((fresh) => {
          if (fresh && fresh.ok) return cache.put(req, fresh);
        }).catch(() => {})
      );
      return cached;
    }
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch (e) {
      return cache.match('./index.html');
    }
  })());
});
