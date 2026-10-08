// Cachea la app para que abra sin conexión.
const CACHE = 'gastos-v8-9-1';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'jsqr.js'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && !k.startsWith('mg-ocr')).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // solo archivos de la app
  // Lector de tickets (OCR): pesado y no cambia, así que va primero de la caché y sobrevive a las actualizaciones.
  if (url.pathname.includes('/ocr/')) {
    e.respondWith(caches.open('mg-ocr-1').then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }))));
    return;
  }
  // Red primero, validando con el servidor (sin caché HTTP) para recibir actualizaciones al instante; caché si no hay conexión.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
