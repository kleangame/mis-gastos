// Cachea la app para que abra sin conexión.
const CACHE = 'gastos-v8-10-0';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'jsqr.js'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && !k.startsWith('mg-ocr') && k !== 'mg-share').map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Compartir a Mis Gastos (menú Compartir de Android): guarda la imagen o el texto y abre la app para leerlo.
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const fd = await e.request.formData();
      const c = await caches.open('mg-share');
      const img = fd.get('image');
      const text = [fd.get('title'), fd.get('text'), fd.get('url')].filter(Boolean).join('\n');
      await c.put('share-meta', new Response(JSON.stringify({ text, at: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
      if (img && img.size) await c.put('share-image', new Response(img, { headers: { 'Content-Type': img.type || 'image/jpeg' } }));
      else await c.delete('share-image');
      return Response.redirect('./?share=1', 303);
    })());
    return;
  }
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
