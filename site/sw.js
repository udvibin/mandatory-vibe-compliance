// Service worker: makes the site installable + usable offline.
// ponytail: no build step, no workbox — bump CACHE to invalidate everything.
const CACHE = 'mvc-v1';

// Enough to boot offline; everything else fills in at runtime as you browse.
const SHELL = ['./', './index.html', './dashboard.html', './css/style.css', './favicon.svg'];

// CI regenerates data.json every 2 days, so it must never be served stale while online.
const isFresh = (req, url) =>
  req.mode === 'navigate' || url.pathname.endsWith('data.json');

// Site pins three/gsap/chart.js to jsdelivr and fonts to Google — cache them or offline is a blank page.
// scdn.co = Spotify album covers: cached as they lazy-load, so anything you've scrolled past works offline.
// ponytail: no eviction cap — full archive is ~700 small covers, add LRU only if quota ever complains.
const isCacheable = (url) =>
  url.origin === self.location.origin ||
  /(^|\.)jsdelivr\.net$|(^|\.)gstatic\.com$|(^|\.)googleapis\.com$|(^|\.)scdn\.co$/.test(url.hostname);

self.addEventListener('install', (e) => {
  self.skipWaiting();
  // no-cache here too: install must snapshot the server's shell, not the HTTP cache's.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || !isCacheable(url)) return;

  // Cross-origin subresources (covers, fonts, CDN css) arrive as no-cors → opaque responses,
  // which res.ok rejects and Chrome pads by ~MBs in cache. Every host in isCacheable sends
  // ACAO:*, so refetch them in CORS mode to get a real, cacheable response instead.
  // Same-origin gets cache:'no-cache' — otherwise the background refresh trusts the browser's
  // HTTP cache and can re-store stale shell assets forever after a deploy. CDN URLs are
  // version-pinned/immutable, so they keep normal HTTP caching.
  const netReq = url.origin === self.location.origin
    ? new Request(req.url, { cache: 'no-cache' })
    : new Request(req.url, { mode: 'cors' });

  const save = (res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  };

  if (isFresh(req, url)) {
    // Network first, fall back to cache (and to the story page for any offline navigation).
    e.respondWith(
      fetch(netReq)
        .then(save)
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // Cache first, refresh in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(netReq).then(save).catch(() => hit);
      return hit || net;
    })
  );
});
