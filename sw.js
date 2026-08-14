/* AS HUB — service worker
   Estrategia:
   - el "shell" (HTML, CSS, JS, íconos) se guarda en caché para abrir sin conexión
   - las peticiones a Supabase nunca se cachean (siempre datos frescos)
*/
const VERSION = 'ashub-v2.2.0';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/css/taskgrid.css',
  '/css/finance.css',
  '/js/app.js',
  '/js/config.js',
  '/js/db.js',
  '/js/ui.js',
  '/js/lock.js',
  '/js/views/hub.js',
  '/js/views/tasks.js',
  '/js/views/finance.js',
  '/manifest.webmanifest',
  '/icons/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // cada archivo se guarda por separado: si uno falla, el resto sigue
      .then((cache) => Promise.all(SHELL.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Datos en vivo: red directa, sin caché.
  if (url.hostname.endsWith('supabase.co')) return;

  // Navegación: red primero, caché como respaldo.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // Recursos propios y CDNs: caché primero, refresco en segundo plano.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200 && (url.origin === self.location.origin || res.type === 'cors' || res.type === 'basic')) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
