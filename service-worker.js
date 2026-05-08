const CACHE_NAME = 'grunkle-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './data/app.js',
  './data/grunkle.css',
  './data/worker-process.js',
  './files/bg21600-nxtgen.jpg',
  './files/grunkle.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CORE_ASSETS.map((p) => new Request(p, { cache: 'reload' }))).catch((err) => {
        //  try adding without reload flag for servers that don't like it
        return cache.addAll(CORE_ASSETS);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  if (url.pathname.includes('/files/') || /\.(png|jpg|jpeg|webp|gif|svg)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      }))
    );
    return;
  }

  event.respondWith(
    fetch(event.request).then((res) => {
      // put a copy in cache for future
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      return res;
    }).catch(() => caches.match(event.request))
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
