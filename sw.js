// Service worker: caches the app itself so it opens with no connection.
// Content (articles, images) lives in IndexedDB, not here.
const VERSION = 'v7';
const CACHE = `offline-reader-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/main.js', 'js/config.js', 'js/db.js', 'js/events.js', 'js/github.js', 'js/highlight.js',
  'js/library.js', 'js/outbox.js', 'js/render.js', 'js/sync.js', 'js/ui.js', 'js/viewer.js',
  'js/views/library.js', 'js/views/reader.js', 'js/views/settings.js', 'js/views/themes.js',
  'vendor/marked.esm.js', 'vendor/purify.es.mjs',
  'fonts/iAWriterQuattroS-Regular.woff2', 'fonts/iAWriterQuattroS-Italic.woff2',
  'fonts/iAWriterQuattroS-Bold.woff2', 'fonts/iAWriterQuattroS-BoldItalic.woff2',
  'fonts/iAWriterMonoS-Regular.woff2', 'fonts/iAWriterMonoS-Bold.woff2',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Network-first for the app shell (so updates arrive), falling back to the cache offline.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const isNav = e.request.mode === 'navigate';
    const key = isNav ? 'index.html' : e.request;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3500); // slow network → use the cache
      const res = await fetch(e.request, { signal: ctrl.signal, cache: 'no-cache' });
      clearTimeout(timer);
      if (res.ok) cache.put(key, res.clone());
      return res;
    } catch {
      const hit = await cache.match(key, { ignoreSearch: true });
      return hit || Response.error();
    }
  })());
});
