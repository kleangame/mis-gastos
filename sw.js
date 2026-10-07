// Cachea la app (no las llamadas a Google) para que abra sin conexión.
const CACHE = 'gastos-v6-2-1';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // deja pasar Apps Script
  // Red primero (para recibir actualizaciones), caché si no hay conexión.
  e.respondWith(
    fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
