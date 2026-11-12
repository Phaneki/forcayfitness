const CACHE_NAME = 'forca-fitness-pwa-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/pages/auth.js',
  '/pages/staff/index.html',
  '/pages/staff/asistencia.html',
  '/pages/auth/login.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

